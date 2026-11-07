"""What the VPS runner and the alert script assume about the pipeline
(multi-campus seam, guardrail L0a).

The scheduled runs live outside the package (`ops/vps/`, docs/ops-vps.md): the
harvest script runs ``sync --group <group>`` and logs to
``/var/log/camsocs/<date>-<group>.log``; the alert script shows a failed
stage's name only when it has the `_STAGE` shape and a log path only when it
has the `_LOG_FILE` shape, so a stage or group name outside those shapes would
silently vanish from every alert. The monitor unit skips its run unless the
checkout has the monitor module at the path it names. These hold for every
registry the seam builds, so they are pinned here.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import ModuleType

from camsocs_pipeline.stages import GROUPS, STAGES

REPO = Path(__file__).resolve().parents[3]
OPS = REPO / "ops" / "vps"
SYSTEMD = OPS / "systemd"
#: Where install.sh puts the checkout on the host.
CHECKOUT = "/opt/camsocs/"


def _alert() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "camsocs_alert_contract", OPS / "camsocs-alert.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


alert = _alert()


def test_the_groups_are_exactly_events_full_and_talks() -> None:
    assert set(GROUPS) == {"events", "full", "talks"}


def test_every_stage_name_has_the_alert_scripts_stage_shape() -> None:
    for stage in STAGES:
        assert alert._STAGE.fullmatch(stage.name), stage.name


def test_every_group_names_a_log_file_the_alert_script_shows() -> None:
    for name in GROUPS:
        assert alert._LOG_FILE.fullmatch(f"/var/log/camsocs/2026-11-07-{name}.log"), name


def test_every_group_the_timers_and_the_harvest_script_run_exists() -> None:
    timed = {
        match.group(1)
        for timer in SYSTEMD.glob("camsocs-harvest-*.timer")
        for match in re.finditer(r"^Unit=camsocs-harvest@([a-z]+)\.service$",
                                 timer.read_text(encoding="utf-8"), re.MULTILINE)
    }  # fmt: skip
    assert timed == {"events", "full"}
    script = (OPS / "camsocs-harvest.sh").read_text(encoding="utf-8")
    cases = re.search(r'case "\$GROUP" in\n(.*?)\nesac', script, re.DOTALL)
    assert cases is not None
    accepted = set(re.findall(r"^  ([a-z]+)\)$", cases.group(1), re.MULTILINE))
    assert accepted == timed
    assert accepted <= set(GROUPS)


def test_the_monitor_units_condition_path_exists_in_the_checkout() -> None:
    unit = (SYSTEMD / "camsocs-monitor.service").read_text(encoding="utf-8")
    paths = re.findall(r"^ConditionPathExists=(\S+)$", unit, re.MULTILINE)
    assert paths, "the monitor unit names the module it runs"
    for path in paths:
        assert path.startswith(CHECKOUT), path
        assert (REPO / path.removeprefix(CHECKOUT)).is_file(), path
