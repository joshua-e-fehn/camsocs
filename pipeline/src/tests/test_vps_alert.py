"""The VPS runner's alert, status file and systemd units (decision D5,
docs/ops-vps.md): `ops/vps/camsocs-alert.py` builds a masked message and sends
it through the Slack Web API (a fake opener here, never the network),
`ops/vps/camsocs-status.py` writes the status, and the units say what the
runbook says.
"""

from __future__ import annotations

import importlib.util
import io
import json
import re
import subprocess
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parents[3]
OPS = REPO / "ops" / "vps"
#: Fake tokens, assembled at run time so no token-shaped literal sits in the repo
#: (secret scanners flag those, real or not).
TOKEN = "-".join(["xoxb", "1234567890", "0987654321", "AbCdEfGhIjKlMnOpQrStUvWx"])
GITHUB_TOKEN = "ghp" + "_" + "abcdefghijklmnopqrstuvwxyz0123456789"


def script(name: str) -> ModuleType:
    """Import an ops script (its file name has hyphens) as a module."""
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), OPS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


alert = script("camsocs-alert")
status_writer = script("camsocs-status")


# --- masking ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, secret",
    [
        (f"posting with {TOKEN}", TOKEN),
        ("LLM_API_KEY=sk-live-abcdefghijklmnopqrstu", "sk-live-abcdefghijklmnopqrstu"),
        ('PIPELINE_API_KEY: "3f9a1c00ff"', "3f9a1c00ff"),
        ("Authorization: Bearer abc.def.ghi", "abc.def.ghi"),
        ("https://joshua:hunter2@example.org/feed.ics", "hunter2"),
        ("GET https://example.org/x?access_token=EAAB123&page=2", "EAAB123"),
        ('{"api_key": "plain-words"}', "plain-words"),
        ("password: correct-horse", "correct-horse"),
        (GITHUB_TOKEN, GITHUB_TOKEN),
        (
            "key " + "0123456789abcdef" * 4,  # openssl rand -hex 32
            "0123456789abcdef" * 4,
        ),
        ("token rotated: Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==", "Zm9vYmFyYmF6cXV4MTIz"),
    ],
)
def test_anything_key_or_token_like_is_masked(text: str, secret: str) -> None:
    masked = alert.mask(text)
    assert secret not in masked
    assert alert.MASK in masked


def test_ordinary_log_lines_stay_readable() -> None:
    lines = [
        "03:41:07 INFO     camsocs_pipeline.staging.store: staged 235 records → "
        "/opt/camsocs/var/staging/camdram.events/20261010T024104Z-f99a3d.jsonl",
        "  calendar_feeds: 219 new, 0 updated, 0 unchanged, 0 skipped",
        "    26 of 26 feeds read (22 disallowed by robots.txt, read as society content, D3)",
        "  keyed: 5 monkey=3 author: the society",
        "Error: One or more stages failed — see the report above.",
    ]
    for line in lines:
        assert alert.mask(line) == line


def test_known_secret_values_are_masked_wherever_they_appear() -> None:
    assert alert.mask(f"sent {TOKEN} and plain-words", [TOKEN]) == "sent *** and plain-words"


def test_only_the_slack_keys_are_read_from_myas_env_file(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text(
        "OPENAI_API_KEY=sk-not-ours\n"
        f'SLACK_BOT_TOKEN="{TOKEN}"\n'
        "export SLACK_ALLOWED_USERS=U0AAA,U0BBB  # owners\n"
        "SLACK_HOME_CHANNEL=\n"
    )
    settings = alert.read_env(env, alert.WANTED_KEYS)
    assert settings == {
        "SLACK_BOT_TOKEN": TOKEN,
        "SLACK_ALLOWED_USERS": "U0AAA,U0BBB",
        "SLACK_HOME_CHANNEL": "",
    }


# --- the message ------------------------------------------------------------------------

STATUS = {
    "group": "events",
    "exitCode": 1,
    "phase": "pipeline",
    "commit": "0123456789ab",
    "runKey": "20261010T033000Z-abcdef",
    "startedAt": "2026-10-10T03:30:00Z",
    "finishedAt": "2026-10-10T03:52:10Z",
    "failedStages": ["calendar_feeds"],
    "invocationId": "inv-1",
    "logFile": "/var/log/camsocs/2026-10-10-events.log",
    "error": "Server said: 'PR closed to sisters (Brothers PR Chill)' was refused",
    "warnings": ["_resolved was last staged 9 days ago"],
    "summary": ["load: 'MCR room booking (Jane Example)' not posted"],
}
MONITOR = {
    "MONITOR_SERVICE_RESULT": "exit-code",
    "MONITOR_EXIT_CODE": "exited",
    "MONITOR_EXIT_STATUS": "1",
    "MONITOR_INVOCATION_ID": "inv-1",
}


def message(*, environ: dict[str, str] | None = None, **status) -> str:
    return alert.build_message(
        "events",
        environ=MONITOR if environ is None else environ,
        status=STATUS | status,
        host="srv1608974",
        today="2026-10-10",
        known_secrets=[TOKEN],
    )


def test_the_message_names_the_group_the_exit_the_phase_and_where_the_log_is() -> None:
    text = message()

    assert "camsocs harvest *events* failed on srv1608974" in text
    assert "exit status 1 (exited, exit-code)" in text
    assert "phase: pipeline" in text and "commit 0123456789ab" in text
    assert "run 20261010T033000Z-abcdef" in text
    assert "failed stages: calendar_feeds" in text
    assert "/var/log/camsocs/2026-10-10-events.log" in text
    assert len(text) <= alert.MAX_MESSAGE_CHARS


def test_nothing_a_harvest_read_reaches_slack() -> None:
    """The pipeline's error text, warnings, summary and the log carry scraped
    titles and server errors: none of it is sent, only shaped facts."""
    text = message()
    for leaked in ("PR closed", "Jane Example", "Brothers", "9 days", "Server said", "```"):
        assert leaked not in text


@pytest.mark.parametrize(
    "field, value",
    [
        ("phase", "pipeline; see https://evil.example/x"),
        ("commit", "not a commit <@U123>"),
        ("runKey", "r1 — Jane Example's booking"),
        ("startedAt", "Saturday, with Jane"),
        ("failedStages", ["load", "MCR room booking (Jane Example)"]),
        ("logFile", "/run/credentials/camsocs-alert@events.service/slack-env"),
    ],
)
def test_a_status_value_of_the_wrong_shape_is_not_shown(field: str, value: object) -> None:
    text = message(**{field: value})
    for word in ("evil", "<@U123>", "Jane", "credentials"):
        assert word not in text
    if field == "logFile":
        assert "/var/log/camsocs/2026-10-10-events.log" in text, "the day's log instead"
    if field == "failedStages":
        assert "failed stages: load" in text


def test_a_status_file_from_an_earlier_run_is_not_presented_as_this_ones() -> None:
    text = message(invocationId="inv-0")
    assert "from an earlier run" in text
    assert "phase: pipeline" not in text and "failed stages" not in text


def test_a_run_that_could_not_have_the_lock_says_so() -> None:
    text = message(phase="lock", exitCode=75, failedStages=[], runKey=None, commit=None)
    assert "phase: lock" in text


# --- the monitor's message (ENG-10) -------------------------------------------------------


def monitor_status(**overrides) -> dict:
    """A status file as `camsocs monitor --status-json` writes it."""
    from datetime import UTC, datetime

    from camsocs_pipeline.monitor import CheckResult, assess

    results = [
        CheckResult("error_spike", "failed", 34, 20, "gt", 1.0),
        CheckResult("stale_harvest", "ok", 1, 1, "lt", 26, {"hoursSinceLastSuccess": 3.5}),
        CheckResult("zero_result_rate", "unknown", None, 0.5, "gt", 24, {}, "HTTP 503"),
        CheckResult("pageview_heartbeat", "failed", 0, 1, "lt", 48),
    ]
    verdict = assess(results, {}, now=datetime(2026, 11, 1, 12, 0, tzinfo=UTC))
    return verdict.status_payload("f" * 32) | overrides


def monitor_message(status: dict, **environ: str) -> str:
    return alert.build_message(
        "monitor",
        environ={"MONITOR_INVOCATION_ID": "f" * 32, "MONITOR_EXIT_STATUS": "1"} | environ,
        status=status,
        host="srv1608974",
        today="2026-11-01",
        known_secrets=[TOKEN],
    )


def test_the_monitor_alert_lists_the_failing_checks_with_their_numbers() -> None:
    text = monitor_message(monitor_status())
    assert "camsocs monitor: 2 checks failing on srv1608974" in text
    assert "• error_spike: 34 (fails when > 20, last 1 h)" in text
    assert "• pageview_heartbeat: 0 (fails when < 1, last 48 h)" in text
    assert "stale_harvest" not in text, "a passing check is not listed"
    assert "not checked (PostHog did not answer): zero_result_rate" in text
    assert "status-monitor.json" in text and "journalctl -u camsocs-monitor" in text
    assert "harvest" not in text.split("\n")[0]


def test_the_monitor_alert_shows_only_shaped_names_and_numbers() -> None:
    status = monitor_status()
    status["checks"][0] |= {
        "value": "34 — see https://evil.example",
        "detail": {"Jane Example": 3, "searches": "many <@U123>", "zeroResults": 14},
    }
    status["checks"][3]["name"] = "pageview heartbeat (Jane's booking)"
    status["unknownChecks"] = ["zero_result_rate", "<@U123> ping"]
    text = monitor_message(status)
    for leaked in ("evil", "Jane", "<@U123>", "many"):
        assert leaked not in text
    assert "• error_spike" in text, "the name stays; the bad value goes"


@pytest.mark.parametrize("op", [["gt"], {"gt": 1}, 1])
def test_a_monitor_check_with_an_op_of_the_wrong_shape_shows_its_name_only(op: object) -> None:
    status = monitor_status()
    for check in status["checks"]:
        check["op"] = op
    text = monitor_message(status)
    assert "camsocs monitor: 2 checks failing on srv1608974" in text
    assert "fails when" not in text


def test_a_status_file_that_breaks_the_message_still_alerts(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    def broken(*_args, **_kwargs):
        raise TypeError("unhashable type: 'list'")

    monkeypatch.setattr(alert, "build_message", broken)
    env = tmp_path / "alert.env"
    env.write_text(f"SLACK_BOT_TOKEN={TOKEN}\n")
    code = alert.main(
        ["--dry-run", "monitor"],
        environ={"CAMSOCS_ALERT_ENV": str(env), "CAMSOCS_STATE_DIR": str(tmp_path)},
    )
    assert code == 0
    out = capsys.readouterr()
    assert "camsocs monitor failed on" in out.out and "status file unreadable" in out.out
    assert "TypeError" in out.err and "unhashable" not in out.err


def test_a_monitor_that_wrote_no_status_this_run_says_it_failed_itself() -> None:
    for status in ({}, monitor_status(invocationId="0" * 32)):
        text = monitor_message(status, MONITOR_SERVICE_RESULT="exit-code")
        assert "camsocs monitor failed on srv1608974" in text
        assert "exit status 1 (exit-code)" in text and "no check results" in text
        assert "error_spike" not in text


# --- the monitor's news: requests and recoveries (ENG-33) ---------------------------------


def monitor_news(*, failing: tuple[str, ...] = (), previous: dict | None = None, **kw) -> dict:
    """A status file of a run that pages for new requests and/or a recovery."""
    from datetime import UTC, datetime, timedelta

    from camsocs_pipeline.monitor import CheckResult, RequestCount, assess

    now = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
    results = [
        CheckResult(name, "failed" if name in failing else "ok", 0, 1, "lt", 26)
        for name in ("stale_harvest", "pageview_heartbeat")
    ] + [
        CheckResult("site_home", "ok", 200, 200, "ne", None, {"attempts": 1}, None, True),
    ]
    requests = RequestCount(
        "ok", now - timedelta(minutes=70), now - timedelta(minutes=10), kw.pop("by_kind", {})
    )
    verdict = assess(results, previous or {}, now=now, requests=requests)
    return verdict.status_payload("f" * 32) | kw


def test_new_requests_send_their_counts_by_kind_and_where_to_answer_them() -> None:
    text = monitor_message(monitor_news(by_kind={"claim": 1, "remove": 2}))
    lines = text.split("\n")
    assert lines[0] == (
        ":inbox_tray: camsocs: 3 new listing requests: claim 1, remove 2 "
        "(stored 2026-11-01T10:50:00Z to 2026-11-01T11:50:00Z)"
    )
    assert "https://camsocs.uk/dashboard/requests" in text
    assert "failing" not in text and ":rotating_light:" not in text
    one = monitor_message(monitor_news(by_kind={"object": 1}))
    assert "1 new listing request: object 1" in one


def test_requests_show_only_kinds_and_numbers_of_the_right_shape() -> None:
    status = monitor_news(by_kind={"claim": 1})
    status["requests"]["byKind"] = {
        "claim": 1,
        "Jane Example": 4,
        "remove": "two, from jane@example.org",
        "object": True,
        "add": 1,
    }
    status["requests"]["since"] = "<@U123> yesterday"
    text = monitor_message(status)
    for leaked in ("Jane", "jane@", "<@U123>", "object"):
        assert leaked not in text
    assert "2 new listing requests: claim 1, add 1" in text
    assert "stored" not in text, "a window of the wrong shape is left out"


def test_requests_that_were_not_counted_or_were_none_send_nothing_of_their_own() -> None:
    for requests in (
        {"status": "unknown", "byKind": {"claim": 3}},
        {"status": "ok", "byKind": {}},
        "3 new",
    ):
        status = monitor_news() | {"requests": requests, "paged": True}
        assert "camsocs monitor failed on" in monitor_message(status)


def test_a_recovered_site_check_says_it_is_ok_again() -> None:
    previous = {"alertedChecks": ["site_home"], "lastAlertAt": "2026-11-01T11:00:00Z"}
    status = monitor_news(previous=previous)
    assert status["recoveredChecks"] == ["site_home"]
    text = monitor_message(status)
    first = text.split("\n")[0]
    assert first == ":white_check_mark: camsocs monitor: site_home ok again on srv1608974"
    status["recoveredChecks"] = ["site_home", "<@U123> ping"]
    assert "<@U123>" not in monitor_message(status)


def test_news_during_a_failure_already_paged_names_it_without_paging_it_again() -> None:
    previous = {"alertedChecks": ["stale_harvest"], "lastAlertAt": "2026-11-01T10:00:00Z"}
    status = monitor_news(failing=("stale_harvest",), previous=previous, by_kind={"claim": 1})
    assert status["checksPaged"] is False
    text = monitor_message(status)
    assert ":rotating_light:" not in text and "• stale_harvest" not in text
    assert "still failing (paged before): stale_harvest" in text
    assert "1 new listing request: claim 1" in text


def test_a_failing_site_check_shows_its_status_and_reason() -> None:
    status = monitor_news()
    status["checks"][2] |= {"status": "failed", "value": 0, "reason": "ConnectTimeout"}
    status |= {"checksPaged": True, "failedChecks": ["site_home"]}
    text = monitor_message(status)
    assert "• site_home: 0 (fails when ≠ 200) · attempts 1 · ConnectTimeout" in text
    status["checks"][2]["reason"] = "<html>talk titles</html>"
    assert "talk" not in monitor_message(status)


def test_a_status_file_from_before_eng_33_still_lists_its_failing_checks() -> None:
    status = monitor_status()
    for key in ("checksPaged", "recoveredChecks", "requests", "requestsCountedUntil"):
        status.pop(key)
    assert "camsocs monitor: 2 checks failing on srv1608974" in monitor_message(status)


# --- campuses (D8) and the shadow checks (D9) --------------------------------------------


def test_every_monitor_check_and_its_counts_have_the_shapes_the_alert_shows() -> None:
    """Promoting every shadow check must not make a check or a count vanish
    from the alert: names of `_CHECK`'s shape, camelCased counts, and no more
    checks than `MAX_CHECKS`."""
    from camsocs_pipeline import monitor
    from camsocs_pipeline.campuses import CAMBRIDGE
    from camsocs_pipeline.stages import GROUPS, STAGES

    paging = monitor.checks_for(CAMBRIDGE)
    shadow = monitor.shadow_checks_for(CAMBRIDGE)
    names = [c.name for c in (*paging, *shadow)] + list(monitor.SITE_CHECK_NAMES)
    assert alert.MAX_CHECKS == 16 and len(names) <= alert.MAX_CHECKS
    for name in names:
        assert alert._CHECK.fullmatch(name), name
    for count in [monitor.camel(s.name) for s in STAGES] + [monitor.camel(g) for g in GROUPS]:
        assert alert._COUNT_NAME.fullmatch(count), count
    for count in ("hoursSinceLastSuccess", "generations", "errors", "bulkGenerations", "fallbacks"):
        assert alert._COUNT_NAME.fullmatch(count), count


def many_failing(n: int) -> dict:
    from datetime import UTC, datetime

    from camsocs_pipeline.monitor import CheckResult, assess

    results = [
        CheckResult(f"check_{chr(97 + i)}", "failed", 3, 0, "gt", 26, {"websiteEvents": 3})
        for i in range(n)
    ]
    return assess(results, {}, now=datetime(2026, 11, 1, 12, 0, tzinfo=UTC)).status_payload(
        "f" * 32
    )


def test_the_monitor_alert_names_up_to_sixteen_checks() -> None:
    text = monitor_message(many_failing(18))
    assert "18 checks failing" in text
    shown = [line for line in text.split("\n") if line.startswith("• check_")]
    assert len(shown) == 16
    assert "• check_a: 3 (fails when > 0, last 26 h) · websiteEvents 3" in text


def test_cambridges_alerts_read_as_before_the_campus_existed() -> None:
    """The monitor now writes `campus` and `site`; for Cambridge the message
    is byte for byte the one a status file without them gives."""
    for status in (monitor_status(), monitor_news(by_kind={"claim": 1})):
        old = {k: v for k, v in status.items() if k not in ("campus", "site")}
        cam = old | {"campus": "cam", "site": "https://camsocs.uk"}
        assert monitor_message(cam) == monitor_message(old)
    assert message(campus="cam") == message()


def test_another_campus_is_named_and_its_own_inbox_linked() -> None:
    status = monitor_news(by_kind={"remove": 1}) | {
        "campus": "zz",
        "site": "https://zz.localhost",
    }
    text = monitor_message(status)
    assert text.split("\n")[0].startswith(":inbox_tray: camsocs (campus zz): 1 new listing")
    assert "Read and answer: https://zz.localhost/dashboard/requests" in text
    assert "camsocs.uk" not in text
    failing = monitor_message(monitor_status() | {"campus": "zz"})
    assert failing.split("\n")[0].endswith("failing on srv1608974 (campus zz)")
    harvest = message(campus="ox")
    assert harvest.split("\n")[0] == (
        ":rotating_light: camsocs harvest *events* failed on srv1608974 (campus ox)"
    )


@pytest.mark.parametrize(
    "campus, site",
    [
        ("Oxford <@U123>", "https://evil.example/path?x=1"),
        ("x", "http://zz.localhost"),
        (["zz"], "javascript:alert(1)"),
        ("toolongcampus", "https://user:pw@zz.localhost"),
        (None, "https://zz.localhost/"),
    ],
)
def test_a_campus_or_site_of_the_wrong_shape_is_not_shown(campus: object, site: object) -> None:
    status = monitor_news(by_kind={"claim": 1}) | {"campus": campus, "site": site}
    text = monitor_message(status)
    assert "(campus" not in text
    assert "Read and answer: https://camsocs.uk/dashboard/requests" in text
    for leaked in ("evil", "<@U123>", "javascript", "pw@", "http://"):
        assert leaked not in text


def test_a_status_file_from_an_earlier_run_names_no_campus() -> None:
    text = message(invocationId="inv-0", campus="ox")
    assert "from an earlier run" in text and "campus" not in text


def write_status(tmp_path: Path, *extra: str) -> dict:
    code = status_writer.main(
        [
            "--state-dir", str(tmp_path), "--group", "events",
            "--started", "2026-10-10T03:30:00Z", "--finished", "2026-10-10T03:40:00Z",
            "--exit-code", "0", "--phase", "done", *extra,
        ]
    )  # fmt: skip
    assert code == 0
    return json.loads((tmp_path / "status-events.json").read_text())


def test_the_status_file_records_the_campus(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("CAMSOCS_CAMPUS", raising=False)
    assert write_status(tmp_path)["campus"] == "cam", "Cambridge's runner names none"
    assert write_status(tmp_path, "--campus", "zz")["campus"] == "zz"
    monkeypatch.setenv("CAMSOCS_CAMPUS", "ox")
    assert write_status(tmp_path)["campus"] == "ox"
    assert write_status(tmp_path, "--campus", "zz")["campus"] == "zz", "the flag wins"
    monkeypatch.setenv("CAMSOCS_CAMPUS", "Oxford; rm -rf")
    assert write_status(tmp_path)["campus"] is None, "written, but never a bad value"


# --- sending ----------------------------------------------------------------------------


class FakeSlack:
    """Stands in for urllib's urlopen: records requests, answers like Slack."""

    def __init__(self, answers: dict[str, dict]) -> None:
        self.answers = answers
        self.requests: list[tuple[str, dict, dict]] = []

    def __call__(self, request, timeout: float):
        method = request.full_url.rsplit("/", 1)[-1]
        self.requests.append((method, json.loads(request.data), dict(request.header_items())))
        return io.BytesIO(json.dumps(self.answers[method]).encode())


def test_without_a_home_channel_the_first_allowed_user_gets_a_dm() -> None:
    slack = FakeSlack(
        {
            "conversations.open": {"ok": True, "channel": {"id": "D0DM"}},
            "chat.postMessage": {"ok": True},
        }
    )
    settings = {"SLACK_BOT_TOKEN": TOKEN, "SLACK_ALLOWED_USERS": "U0AAA, U0BBB"}

    assert alert.send(settings, "hello", slack) == "D0DM"

    [(opened, first, headers), (posted, second, _)] = slack.requests
    assert (opened, first) == ("conversations.open", {"users": "U0AAA"})
    assert posted == "chat.postMessage" and second["channel"] == "D0DM"
    assert second["text"] == "hello"
    assert headers["Authorization"] == f"Bearer {TOKEN}"


def test_the_home_channel_wins_when_it_is_set() -> None:
    slack = FakeSlack({"chat.postMessage": {"ok": True}})
    settings = {
        "SLACK_BOT_TOKEN": TOKEN,
        "SLACK_HOME_CHANNEL": "C0HOME",
        "SLACK_ALLOWED_USERS": "U0AAA",
    }
    assert alert.send(settings, "hello", slack) == "C0HOME"
    assert [method for method, _, _ in slack.requests] == ["chat.postMessage"]


def test_slacks_refusal_is_reported_without_the_token() -> None:
    slack = FakeSlack({"chat.postMessage": {"ok": False, "error": "not_in_channel"}})
    with pytest.raises(alert.AlertError, match="not_in_channel") as raised:
        alert.send({"SLACK_BOT_TOKEN": TOKEN, "SLACK_HOME_CHANNEL": "C0"}, "x", slack)
    assert TOKEN not in str(raised.value)


def test_main_reads_the_credential_masks_and_sends(tmp_path: Path, capsys) -> None:
    credentials = tmp_path / "credentials"
    credentials.mkdir()
    (credentials / "slack-env").write_text(
        f"SLACK_BOT_TOKEN={TOKEN}\nSLACK_ALLOWED_USERS=U0AAA\nOTHER_SECRET=abc\n"
    )
    state = tmp_path / "state"
    state.mkdir()
    (state / "status-full.json").write_text(
        json.dumps({"phase": "update", "exitCode": 10, "error": "LLM_API_KEY=sk-abcdefghijklmnopq"})
    )
    slack = FakeSlack(
        {
            "conversations.open": {"ok": True, "channel": {"id": "D0DM"}},
            "chat.postMessage": {"ok": True},
        }
    )
    environ = {
        "CREDENTIALS_DIRECTORY": str(credentials),
        "CAMSOCS_STATE_DIR": str(state),
        "MONITOR_EXIT_STATUS": "10",
    }

    assert alert.main(["full"], environ, slack) == 0

    text = slack.requests[-1][1]["text"]
    assert "*full* failed" in text and "phase: update" in text
    assert "sk-abcdefghijklmnopq" not in text and "LLM_API_KEY" not in text
    out = capsys.readouterr()
    assert TOKEN not in out.out + out.err


def test_main_without_its_env_file_fails_and_says_where_it_looked(tmp_path, capsys) -> None:
    environ = {"CAMSOCS_ALERT_ENV": str(tmp_path / "nope.env"), "CAMSOCS_STATE_DIR": str(tmp_path)}
    assert alert.main(["events"], environ, FakeSlack({})) == 1
    assert "nope.env" in capsys.readouterr().err


def test_a_dry_run_prints_the_message_and_sends_nothing(tmp_path: Path, capsys) -> None:
    environ = {"CAMSOCS_ALERT_ENV": str(tmp_path / "none"), "CAMSOCS_STATE_DIR": str(tmp_path)}
    slack = FakeSlack({})
    assert alert.main(["--dry-run", "events"], environ, slack) == 0
    assert slack.requests == []
    assert "camsocs harvest *events* failed" in capsys.readouterr().out


# --- the status file --------------------------------------------------------------------


def test_the_status_file_is_written_whole_from_the_run_summary(tmp_path: Path) -> None:
    summary = tmp_path / "run-events.json"
    summary.write_text(
        json.dumps(
            {
                "runKey": "r1",
                "summary": ["load: 3 new"],
                "warnings": ["_resolved was last staged 9 days ago"],
                "stages": [{"name": "load", "status": "failed"}],
                "coverage": {"listed": 793},
            }
        )
    )
    code = status_writer.main(
        [
            "--state-dir",
            str(tmp_path / "state"),
            "--group",
            "events",
            "--started",
            "2026-10-10T03:30:00Z",
            "--finished",
            "2026-10-10T03:40:00Z",
            "--exit-code",
            "1",
            "--phase",
            "pipeline",
            "--commit",
            "0123456789ab",
            "--log",
            "/var/log/camsocs/2026-10-10-events.log",
            "--run-summary",
            str(summary),
        ]
    )
    assert code == 0
    written = json.loads((tmp_path / "state" / "status-events.json").read_text())
    assert written == json.loads((tmp_path / "state" / "status.json").read_text())
    assert written["result"] == "failed" and written["failedStages"] == ["load"]
    assert written["summary"] == ["load: 3 new"] and written["coverage"] == {"listed": 793}
    assert written["warnings"] == ["_resolved was last staged 9 days ago"]
    assert not list((tmp_path / "state").glob(".*.tmp"))


@pytest.mark.parametrize(
    "code, result", [(0, "ok"), (1, "failed"), (10, "failed"), (124, "timed_out"), (143, "stopped")]
)
def test_exit_codes_have_names(code: int, result: str) -> None:
    assert status_writer.result_of(code) == result


def test_a_missing_or_broken_run_summary_leaves_the_run_fields_empty(tmp_path: Path) -> None:
    broken = tmp_path / "run.json"
    broken.write_text("{not json")
    assert status_writer.read_run_summary(broken) == {}
    assert status_writer.read_run_summary(tmp_path / "absent.json") == {}


# --- systemd units, logrotate and the installer -------------------------------------------


def unit(name: str) -> dict[str, list[str]]:
    """``Section.Key`` → every value it is given (systemd allows repeats)."""
    values: dict[str, list[str]] = {}
    section = ""
    for raw in (OPS / "systemd" / name).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("["):
            section = line.strip("[]")
            continue
        key, _, value = line.partition("=")
        values.setdefault(f"{section}.{key}", []).append(value)
    return values


def test_the_harvest_unit_runs_the_script_as_camsocs_hardened() -> None:
    harvest = unit("camsocs-harvest@.service")
    assert harvest["Service.Type"] == ["oneshot"]
    assert harvest["Service.User"] == ["camsocs"]
    # Root-owned, from a reviewed commit: never the checkout the run writes.
    assert harvest["Service.ExecStart"] == ["/usr/local/lib/camsocs-ops/camsocs-harvest.sh %i"]
    assert harvest["Unit.OnFailure"] == ["camsocs-alert@%i.service"]
    assert harvest["Service.ProtectSystem"] == ["strict"]
    assert harvest["Service.NoNewPrivileges"] == ["yes"]
    assert harvest["Service.PrivateTmp"] == ["yes"]
    writable = harvest["Service.ReadWritePaths"][0].split()
    assert writable == ["/opt/camsocs", "/var/lib/camsocs", "/var/log/camsocs"]
    assert "-/docker" in harvest["Service.InaccessiblePaths"][0].split()
    denied = harvest["Service.IPAddressDeny"][0].split()
    for network in ("link-local", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"):
        assert network in denied
    assert harvest["Service.ProtectProc"] == ["invisible"]


def test_the_alert_unit_runs_root_owned_code_with_the_three_slack_values_only() -> None:
    sender = unit("camsocs-alert@.service")
    assert "Service.User" not in sender, "not the harvest's user"
    assert sender["Service.DynamicUser"] == ["yes"]
    assert sender["Service.SupplementaryGroups"] == ["camsocs"]
    assert sender["Service.ExecStart"] == [
        "/usr/bin/python3 -I /usr/local/lib/camsocs-ops/camsocs-alert.py %i"
    ]
    assert sender["Service.LoadCredential"] == ["slack-env:/etc/camsocs/alert.env"]
    assert "CAMSOCS_ALERT_ENV=%d/slack-env" in sender["Service.Environment"]
    assert sender["Service.ProtectSystem"] == ["strict"]
    assert "Service.ReadWritePaths" not in sender, "the alert writes nothing"
    hidden = sender["Service.InaccessiblePaths"][0].split()
    for path in ("-/docker", "-/opt/camsocs", "-/var/log/camsocs", "-/root"):
        assert path in hidden


def test_the_monitor_unit_runs_the_pipeline_as_camsocs_hardened() -> None:
    monitor = unit("camsocs-monitor.service")
    assert monitor["Service.Type"] == ["oneshot"]
    assert monitor["Service.User"] == ["camsocs"]
    assert monitor["Unit.OnFailure"] == ["camsocs-alert@monitor.service"]
    [command] = monitor["Service.ExecStart"]
    # Never installs (the harvest does, under its lock); production's env file.
    assert command.startswith("/usr/local/bin/pixi run --as-is --manifest-path /opt/camsocs/")
    assert command.endswith(
        "pipeline -- --env prod monitor --status-json /var/lib/camsocs/status-monitor.json"
    )
    # The status file is where the alert looks for the `monitor` group.
    assert f"{alert.DEFAULT_STATE_DIR}/status-{alert.MONITOR_GROUP}.json" in command
    assert monitor["Service.TimeoutStartSec"] == ["10min"]
    assert monitor["Service.UMask"] == ["0027"], "the alert reads the file as group camsocs"
    assert monitor["Service.ProtectSystem"] == ["strict"]
    assert monitor["Service.NoNewPrivileges"] == ["yes"]
    writable = monitor["Service.ReadWritePaths"][0].split()
    assert writable == ["/var/lib/camsocs", "-/opt/camsocs/.pixi"], "not the whole checkout"
    hidden = monitor["Service.InaccessiblePaths"][0].split()
    for path in (
        "-/docker",
        "-/root",
        "-/etc/camsocs",
        "-/var/lib/camsocs/.ssh",
        "-/var/log/camsocs",
    ):
        assert path in hidden
    harvest = unit("camsocs-harvest@.service")
    # The harvest's denied ranges and the loopback, except the DNS stub:
    # cliproxy and every other local service are out of reach.
    denied = monitor["Service.IPAddressDeny"][0].split()
    assert set(harvest["Service.IPAddressDeny"][0].split()) <= set(denied)
    assert "localhost" in denied
    assert monitor["Service.IPAddressAllow"] == ["127.0.0.53"]
    assert monitor["Service.SystemCallFilter"] == harvest["Service.SystemCallFilter"]


def test_the_monitor_unit_skips_quietly_on_a_checkout_without_the_monitor() -> None:
    # The checkout is only pulled by the harvest, and a pin can hold a commit
    # from before ENG-10: a failed condition skips the run without OnFailure=,
    # where a missing `monitor` command would alert every hour.
    monitor = unit("camsocs-monitor.service")
    assert monitor["Unit.ConditionPathExists"] == [
        "/opt/camsocs/pipeline/src/camsocs_pipeline/monitor.py"
    ]
    assert (REPO / "pipeline" / "src" / "camsocs_pipeline" / "monitor.py").is_file()


def test_the_monitor_timer_runs_hourly_spread_out() -> None:
    values = unit("camsocs-monitor.timer")
    assert values["Timer.OnCalendar"] == ["hourly"]
    assert values["Timer.RandomizedDelaySec"] == ["15min"]
    # One offset per host, so runs are exactly an hour apart (ENG-33: a
    # request is announced within about an hour, not up to 85 minutes).
    assert values["Timer.FixedRandomDelay"] == ["yes"]
    assert values["Timer.AccuracySec"] == ["1s"]
    assert values["Timer.Unit"] == ["camsocs-monitor.service"]
    assert values["Install.WantedBy"] == ["timers.target"]


@pytest.mark.parametrize(
    "timer, calendar, group",
    [
        ("camsocs-harvest-events.timer", "*-*-* 04:30:00 Europe/London", "events"),
        ("camsocs-harvest-full.timer", "Sun *-*-* 02:00:00 Europe/London", "full"),
    ],
)
def test_the_timers_fire_in_london_time_and_catch_up(timer: str, calendar: str, group: str) -> None:
    values = unit(timer)
    assert values["Timer.OnCalendar"] == [calendar]
    assert values["Timer.Persistent"] == ["true"]
    assert values["Timer.Unit"] == [f"camsocs-harvest@{group}.service"]
    assert values["Install.WantedBy"] == ["timers.target"]


def test_the_script_limits_are_two_and_six_hours() -> None:
    text = (OPS / "camsocs-harvest.sh").read_text()
    assert 'LIMIT="${CAMSOCS_TIMEOUT_EVENTS:-2h}"' in text
    assert 'LIMIT="${CAMSOCS_TIMEOUT_FULL:-6h}"' in text


def test_logs_go_after_ninety_days_as_the_camsocs_user() -> None:
    text = (OPS / "logrotate" / "camsocs").read_text()
    assert "/var/log/camsocs/*.log {" in text
    for directive in ("su camsocs camsocs", "minage 90", "rotate 0", "missingok", "nocreate"):
        assert directive in text


def test_the_installer_pins_pixi_and_installs_only_from_a_verified_revision() -> None:
    text = (OPS / "install.sh").read_text()
    assert 'PIXI_VERSION="0.73.0"' in text
    assert re.search(r'PIXI_SHA256="[0-9a-f]{64}"', text)
    assert "sha256sum --check" in text
    # Root installs what it extracted from the revision in its own mirror,
    # never a file of the camsocs-writable checkout.
    assert "--revision must be a full 40-character commit id" in text
    assert 'merge-base --is-ancestor "$revision"' in text
    assert '"$REV_DIR"/systemd/*' in text and '"$REV_DIR/logrotate/camsocs"' in text
    assert '"$ROOT"/ops' not in text and "$ROOT/ops" not in text
    assert 'OPS_DIR="/usr/local/lib/camsocs-ops"' in text
    for timer in ("camsocs-harvest-events.timer", "camsocs-harvest-full.timer"):
        assert timer in text
    # A re-run leaves the timers as the operator left them …
    assert '"$enable" == "auto" && $first_install -eq 1' in text
    # … but turns on one it installs for the first time (the monitor's).
    assert (
        "TIMERS=(camsocs-harvest-events.timer camsocs-harvest-full.timer camsocs-monitor.timer"
        " camsocs-notify.timer)" in text
    )
    assert '"$enable" == "auto" && ${#new_timers[@]} -gt 0' in text
    assert 'systemctl enable --now "${new_timers[@]}"' in text
    # … only while a harvest timer is on: a host the operator stopped stays off.
    assert "for timer in camsocs-harvest-events.timer camsocs-harvest-full.timer; do" in text
    assert 'systemctl is-enabled --quiet "$timer"' in text
    assert "new timers left off (the harvest timers are off)" in text
    # The monitor runs from the checkout as camsocs: no script of its own for root.
    assert (
        "OPS_FILES=(camsocs-harvest.sh camsocs-alert.py camsocs-status.py camsocs-notify.py"
        " install.sh)" in text
    )
    # Names only, never values, for the monitor's optional key.
    assert "for name in POSTHOG_PERSONAL_API_KEY POSTHOG_PROJECT_ID; do" in text
    # The warm-up waits for, and holds, the harvest's lock.
    assert 'flock -E 75 -w 600 "$HOME_DIR/harvest.lock"' in text
    # It leaves Docker, Mya's container and cliproxy alone.
    commands = [
        line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")
    ]
    assert not any(re.search(r"(^|[\s;&|(])(docker|docker-compose)\s", line) for line in commands)
    assert "config.yaml" not in text and "8317" not in " ".join(
        line for line in commands if "LLM_BASE_URL" not in line
    )


def test_the_installers_usage_is_its_whole_header() -> None:
    lines = (OPS / "install.sh").read_text().splitlines()
    header_end = next(i for i, line in enumerate(lines[1:], 2) if not line.startswith("#")) - 1
    assert f"sed -n '2,{header_end}p'" in "\n".join(lines)


def test_the_installer_copies_only_the_three_slack_values(tmp_path: Path) -> None:
    mya = tmp_path / "mya.env"
    mya.write_text(
        "OPENAI_API_KEY=sk-not-ours\n"
        f'SLACK_BOT_TOKEN="{TOKEN}"\n'
        "SLACK_SIGNING_SECRET=abc\n"
        "export SLACK_ALLOWED_USERS=U0AAA,U0BBB\n"
        "SLACK_HOME_CHANNEL=C0HOME\n"
        "#SLACK_BOT_TOKEN=commented\n"
        "NOT_SLACK_HOME_CHANNEL=x\n"
    )
    done = subprocess.run(
        ["bash", "-c", f'source "{OPS / "install.sh"}" && extract_alert_env "$1"', "_", str(mya)],
        capture_output=True,
        text=True,
        check=True,
    )
    assert done.stdout.splitlines() == [
        f'SLACK_BOT_TOKEN="{TOKEN}"',
        "export SLACK_ALLOWED_USERS=U0AAA,U0BBB",
        "SLACK_HOME_CHANNEL=C0HOME",
    ]
    copied = tmp_path / "alert.env"
    copied.write_text(done.stdout)
    assert set(alert.read_env(copied)) == set(alert.WANTED_KEYS)
