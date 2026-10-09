"""Instagram Business Discovery (source-research §17): the client's request,
parsing and error classes, and the `instagram` stage — offline (respx)."""

from __future__ import annotations

import io
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from PIL import Image

import camsocs_pipeline.pipeline.load as load
from camsocs_pipeline.models.observation import EventObservation, Observation
from camsocs_pipeline.pipeline.state import load_state
from camsocs_pipeline.pipeline.sync import run_sync
from camsocs_pipeline.sources.instagram import (
    BusinessDiscovery,
    NotProfessional,
    RateLimited,
    TokenInvalid,
    classify_error,
    parse_profile,
)
from camsocs_pipeline.staging.store import StagingStore
from tests.fakes import QUOKKA_KEY, known_orgs_records

SITE = "https://happy-otter-123.convex.site"
IG_USER = "17841400000000001"
GRAPH = f"https://graph.facebook.com/v25.0/{IG_USER}"
TOKEN = "EAAtest-token-value"
CDN = "https://scontent-lhr8-1.cdninstagram.com/v/t51/poster.jpg"


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load.time, "sleep", lambda _seconds: None)


def jpeg() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (60, 60), "orange").save(out, format="JPEG")
    return out.getvalue()


def graph_time(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S+0000")


def profile_body(now: datetime) -> dict:
    recent = now - timedelta(days=1)
    old = now - timedelta(days=200)
    return {
        "business_discovery": {
            "id": "17841400000000999",
            "username": "cuqas_example",
            "media": {
                "data": [
                    {
                        "id": "m-recent",
                        "caption": "QUOKKA QUIZ is back! Thursday 7pm at The Mill. Free entry.",
                        "timestamp": graph_time(recent),
                        "media_type": "IMAGE",
                        "media_url": CDN,
                        "permalink": "https://www.instagram.com/p/RECENT1/",
                    },
                    {
                        "id": "m-old",
                        "caption": "Throwback to last year's quiz",
                        "timestamp": graph_time(old),
                        "media_type": "IMAGE",
                        "media_url": CDN,
                        "permalink": "https://www.instagram.com/p/OLD1/",
                    },
                    {"id": "m-broken", "timestamp": "not a time", "permalink": "x"},
                ]
            },
        },
        "id": IG_USER,
    }


def test_parse_profile_keeps_usable_media() -> None:
    now = datetime(2026, 10, 7, 12, tzinfo=UTC)
    profile = parse_profile("cuqas_example", profile_body(now))
    assert profile.ig_id == "17841400000000999"
    assert [m.id for m in profile.media] == ["m-recent", "m-old"]
    assert profile.media[0].image_urls == (CDN,)
    with pytest.raises(NotProfessional):
        parse_profile("x", {"id": IG_USER})


@pytest.mark.parametrize(
    ("status", "error", "expected"),
    [
        (400, {"code": 4, "message": "Application request limit reached"}, RateLimited),
        (400, {"code": 17, "message": "User request limit reached"}, RateLimited),
        (429, {}, RateLimited),
        (400, {"code": 190, "message": "Error validating access token"}, TokenInvalid),
        (400, {"code": 110, "message": "Invalid user id"}, NotProfessional),
        (400, {"code": 100, "error_subcode": 2207013, "message": "x"}, NotProfessional),
    ],
)
def test_errors_map_to_what_to_do(status: int, error: dict, expected: type) -> None:
    assert isinstance(classify_error(status, {"error": error}), expected)


def test_the_token_travels_in_a_header_never_in_the_url(net) -> None:
    route = net.get(GRAPH).mock(
        return_value=httpx.Response(
            200,
            json=profile_body(datetime.now(UTC)),
            headers={"x-app-usage": json.dumps({"call_count": 85})},
        )
    )
    client = BusinessDiscovery(
        ig_user_id=IG_USER,
        access_token=TOKEN,
        version="v25.0",
        user_agent="camsocs-test/0.1",
        sleep=lambda _s: None,
    )
    client.fetch("cuqas_example")
    request = route.calls[0].request
    assert TOKEN not in str(request.url)
    assert request.headers["Authorization"] == f"Bearer {TOKEN}"
    assert "business_discovery.username(cuqas_example)" in request.url.params["fields"]
    assert client.near_limit
    assert TOKEN not in repr(client) and TOKEN not in client.source_url("cuqas_example")


def test_download_only_from_meta_cdns(net) -> None:
    net.get(CDN).mock(return_value=httpx.Response(200, content=jpeg()))
    client = BusinessDiscovery(
        ig_user_id=IG_USER, access_token=TOKEN, version="v25.0", user_agent="ua"
    )
    assert client.download(CDN)
    assert client.download("https://evil.example.org/poster.jpg") is None
    assert client.download("http://scontent.cdninstagram.com/x.jpg") is None


# --- the stage ----------------------------------------------------------------------------------


def settings_for(make_settings, **overrides):
    values = {
        "convex_http_url": SITE,
        "pipeline_api_key": "test-key",
        "llm_base_url": "http://llm.test/v1",
        "llm_api_key": "test-llm-key",
        "llm_model_bulk": "bulk-model-1",
        "llm_model_strong": "strong-model-1",
        "meta_ig_user_id": IG_USER,
        "meta_access_token": TOKEN,
    }
    values.update(overrides)
    return make_settings(**values)


def mock_run_log(net) -> None:
    net.get(f"{SITE}/api/pipeline/health").mock(return_value=httpx.Response(200, json={"ok": True}))
    net.post(f"{SITE}/api/pipeline/runs/start").mock(return_value=httpx.Response(200, json={}))
    net.post(f"{SITE}/api/pipeline/runs/finish").mock(return_value=httpx.Response(200, json={}))
    # The organisation lookup reads Convex's crosswalk (resolve/lookup.py).
    net.post(f"{SITE}/api/pipeline/crosswalk").mock(
        return_value=httpx.Response(200, json={"rows": [], "isDone": True})
    )


def caption_completion(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    user = body["messages"][-1]["content"]
    text = user if isinstance(user, str) else user[0]["text"]
    assert "QUOKKA QUIZ" in text
    posted = datetime.now(UTC) - timedelta(days=1)
    thursday = posted.date() + timedelta(days=(3 - posted.weekday()) % 7)
    reply = {
        "events": [
            {
                "title": "Quokka Quiz",
                "title_quote": "QUOKKA QUIZ",
                "date": thursday.isoformat(),
                "start_time": "19:00",
                "when_quote": "Thursday 7pm",
                "venue": "The Mill",
                "event_type": "social",
                "free": True,
                "price_text": "Free entry",
            }
        ]
    }
    return httpx.Response(
        200,
        json={
            "id": "c1",
            "object": "chat.completion",
            "created": 0,
            "model": body["model"],
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": json.dumps(reply)},
                }
            ],
        },
    )


def test_not_configured_is_a_clean_skip(make_settings) -> None:
    report = run_sync(settings=make_settings(), stages=["instagram"], dry_run=True)
    assert report.ok
    assert report.stages[0].notes[0].startswith("skipped: not configured")


def test_the_stage_stages_public_events_with_our_own_image(make_settings, net) -> None:
    settings = settings_for(make_settings)
    StagingStore(settings.staging_dir).write(
        "_resolved", "20261001T000000Z-aaaaaa", known_orgs_records()
    )
    mock_run_log(net)
    graph = net.get(GRAPH).mock(
        return_value=httpx.Response(200, json=profile_body(datetime.now(UTC)))
    )
    net.get(CDN).mock(return_value=httpx.Response(200, content=jpeg()))
    llm = net.post("http://llm.test/v1/chat/completions").mock(side_effect=caption_completion)
    upload = net.post(f"{SITE}/api/pipeline/files").mock(
        return_value=httpx.Response(
            200, json={"storageId": "kg2stored", "sha256": "0" * 64, "inserted": 1}
        )
    )

    report = run_sync(settings=settings, stages=["instagram"])
    assert report.ok, report.summary()
    assert graph.call_count == 1 and llm.call_count == 1  # the old post is never read
    assert json.loads(upload.calls[0].request.content)["contentType"] == "image/jpeg"

    staged = StagingStore(settings.staging_dir).read_latest("instagram_api")
    account = next(r for r in staged if isinstance(r, Observation))
    assert account.entity_key == QUOKKA_KEY
    assert account.internal == {
        "instagram_handle": "cuqas_example",
        "instagram_business": True,
        "instagram_user_id": "17841400000000999",
    }
    assert account.fields[0].field == "lastActiveAt"
    assert TOKEN not in account.source_url
    (event,) = [r for r in staged if isinstance(r, EventObservation)]
    assert event.visibility == "public" and event.event_source == "instagram_api"
    assert event.source_url == "https://www.instagram.com/p/RECENT1/"
    fields = {f.field: f for f in event.fields}
    assert fields["title"].quote_check == "exact"
    assert fields["image"].value == {
        "storageId": "kg2stored",
        "sourceUrl": "https://www.instagram.com/p/RECENT1/",
    }
    assert event.organisers[0].identity.known_key == QUOKKA_KEY

    state = load_state(settings.state_path)
    assert state.stage_data["instagram"]["handles"]["cuqas_example"]["status"] == "ok"


def test_a_handle_checked_recently_is_not_due_and_its_records_carry_forward(
    make_settings, net
) -> None:
    settings = settings_for(make_settings)
    store = StagingStore(settings.staging_dir)
    store.write("_resolved", "20261001T000000Z-aaaaaa", known_orgs_records())
    mock_run_log(net)
    net.get(GRAPH).mock(return_value=httpx.Response(200, json=profile_body(datetime.now(UTC))))
    net.get(CDN).mock(return_value=httpx.Response(200, content=jpeg()))
    net.post("http://llm.test/v1/chat/completions").mock(side_effect=caption_completion)
    net.post(f"{SITE}/api/pipeline/files").mock(
        return_value=httpx.Response(200, json={"storageId": "kg2stored", "sha256": "0" * 64})
    )
    assert run_sync(settings=settings, stages=["instagram"]).ok
    first = store.read_latest("instagram_api")

    graph_again = net.get(GRAPH).mock(return_value=httpx.Response(500))
    calls_before = graph_again.call_count
    report = run_sync(settings=settings, stages=["instagram"])
    assert report.ok and graph_again.call_count == calls_before
    assert store.read_latest("instagram_api") == first


def test_rate_limits_stop_and_non_professional_accounts_are_remembered(make_settings, net) -> None:
    settings = settings_for(make_settings)
    StagingStore(settings.staging_dir).write(
        "_resolved", "20261001T000000Z-aaaaaa", known_orgs_records()
    )
    mock_run_log(net)
    net.get(GRAPH).mock(
        return_value=httpx.Response(
            400, json={"error": {"code": 110, "message": "Invalid user id"}}
        )
    )
    report = run_sync(settings=settings, stages=["instagram"])
    assert report.ok
    handles = load_state(settings.state_path).stage_data["instagram"]["handles"]
    assert handles["cuqas_example"]["status"] == "not_professional"
    (account,) = StagingStore(settings.staging_dir).read_latest("instagram_api")
    assert account.internal == {"instagram_handle": "cuqas_example", "instagram_business": False}


def test_a_throttle_ends_the_run_quietly(make_settings, net) -> None:
    settings = settings_for(make_settings)
    StagingStore(settings.staging_dir).write(
        "_resolved", "20261001T000000Z-aaaaaa", known_orgs_records()
    )
    mock_run_log(net)
    net.get(GRAPH).mock(
        return_value=httpx.Response(400, json={"error": {"code": 4, "message": "limit"}})
    )
    report = run_sync(settings=settings, stages=["instagram"])
    assert report.ok
    assert any("rate limited" in note for note in report.stages[0].notes)
    assert "cuqas_example" not in load_state(settings.state_path).stage_data["instagram"].get(
        "handles", {}
    )


def test_an_invalid_token_fails_the_stage_with_a_reason(make_settings, net) -> None:
    settings = settings_for(make_settings)
    StagingStore(settings.staging_dir).write(
        "_resolved", "20261001T000000Z-aaaaaa", known_orgs_records()
    )
    mock_run_log(net)
    net.get(GRAPH).mock(
        return_value=httpx.Response(
            400, json={"error": {"code": 190, "message": "Error validating access token"}}
        )
    )
    report = run_sync(settings=settings, stages=["instagram"])
    assert not report.ok
    assert "TokenInvalid" in (report.stages[0].error or "")
    assert TOKEN not in report.summary()


def test_a_dry_run_makes_no_request(make_settings) -> None:
    settings = settings_for(make_settings)
    StagingStore(settings.staging_dir).write(
        "_resolved", "20261001T000000Z-aaaaaa", known_orgs_records()
    )
    report = run_sync(settings=settings, stages=["instagram"], dry_run=True)
    assert report.ok
    assert report.stages[0].notes == ["dry run: 1 of 1 handles would be checked"]


def test_status_shows_the_meta_token_only_as_set(make_settings) -> None:
    from click.testing import CliRunner

    from camsocs_pipeline.cli import cli

    settings = settings_for(make_settings)
    assert settings.meta_configured
    result = CliRunner().invoke(cli, ["status"], obj={"settings": settings})
    assert result.exit_code == 0, result.output
    assert TOKEN not in result.output
    assert "Meta token:" in result.output and IG_USER in result.output
    assert not make_settings().meta_configured
