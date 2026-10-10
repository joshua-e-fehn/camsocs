#!/usr/bin/env bash
# One scheduled camsocs harvest on the VPS host (decision D5; docs/ops-vps.md).
#
#   camsocs-harvest.sh events|full
#
# Run by camsocs-harvest@<group>.service as the `camsocs` user, in the checkout
# /opt/camsocs. This script itself is root-owned in /usr/local/lib/camsocs-ops/,
# installed from a reviewed commit by install.sh: a pull of the checkout never
# changes it. In order:
#
#   1. lock      one run at a time (flock on $STATE_DIR/harvest.lock): per-host
#                politeness holds only inside one process. `events` skips its
#                tick when another run holds the lock (flock -n; the weekly run
#                harvests every events source too). `full` waits for it up to
#                3 h, so a catch-up after downtime never costs the weekly run;
#                if it still cannot have it, the run fails (exit 75, phase
#                `lock`) and alerts: the weekly run (and retention with it) is
#                never lost in silence.
#   2. update    git pull --ff-only (or the commit pinned in $STATE_DIR/pin, for
#                a rollback), each git command within $UPDATE_LIMIT. On failure
#                the run stops and the checkout stays as it was.
#   3. install   pixi install --locked, within $INSTALL_LIMIT. On failure the
#                checkout goes back to the commit it had before step 2 (the
#                last one that installed), and the run stops.
#   4. pipeline  timeout <limit> pixi run pipeline -- --env prod sync --group <group>
#                (events 2 h, full 6 h), output to the day's log.
#   5. prune     after every run, whatever step 4 did: prune-cache (retention
#                R7, var/cache and superseded staging older than 90 days; R4,
#                what quotes list mail after 30 days), within $INSTALL_LIMIT.
#   6. status    $STATE_DIR/status-<group>.json and status.json (camsocs-status.py),
#                on every exit after the lock, failures included.
#
# Exit code: the pipeline's own (1: a stage failed, 2: a usage error), 124
# when it timed out (137 when it had to be killed), else 10 update failed,
# 11 install failed, 12 prune failed, 64 usage, 75 the weekly run could not
# have the lock. A skipped daily tick exits 0 and writes no status. A
# non-zero exit fails the unit, whose OnFailure= sends the Slack alert
# (camsocs-alert@<group>.service).
#
# Logs: $LOG_DIR/<London date>-<group>.log (the pipeline's whole output; this
# script's own lines also go to stdout, i.e. the journal).
#
# Overrides, for tests and a second checkout: CAMSOCS_ROOT, CAMSOCS_STATE_DIR,
# CAMSOCS_LOG_DIR, CAMSOCS_ENV (prod), CAMSOCS_BRANCH (main), CAMSOCS_PIXI,
# CAMSOCS_PYTHON, CAMSOCS_TIMEOUT_EVENTS / CAMSOCS_TIMEOUT_FULL /
# CAMSOCS_TIMEOUT_UPDATE (15m) / CAMSOCS_TIMEOUT_INSTALL (30m) (timeout(1)
# durations), CAMSOCS_LOCK_WAIT_FULL (seconds).
set -Eeuo pipefail

usage() {
  echo "usage: camsocs-harvest.sh events|full" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
GROUP="$1"
case "$GROUP" in
  events)
    LIMIT="${CAMSOCS_TIMEOUT_EVENTS:-2h}"
    LOCK_WAIT=0
    ;;
  full)
    LIMIT="${CAMSOCS_TIMEOUT_FULL:-6h}"
    LOCK_WAIT="${CAMSOCS_LOCK_WAIT_FULL:-10800}"
    ;;
  *) usage ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CAMSOCS_ROOT:-/opt/camsocs}"
STATE_DIR="${CAMSOCS_STATE_DIR:-/var/lib/camsocs}"
LOG_DIR="${CAMSOCS_LOG_DIR:-/var/log/camsocs}"
ENV_NAME="${CAMSOCS_ENV:-prod}"
BRANCH="${CAMSOCS_BRANCH:-main}"
PIXI="${CAMSOCS_PIXI:-pixi}"
PYTHON="${CAMSOCS_PYTHON:-python3}"
# git and pixi talk to the network: neither may hang the run (or the lock).
UPDATE_LIMIT="${CAMSOCS_TIMEOUT_UPDATE:-15m}"
INSTALL_LIMIT="${CAMSOCS_TIMEOUT_INSTALL:-30m}"

# Never let a stray deploy key reach anything this script runs (AGENTS.md).
unset CONVEX_DEPLOY_KEY

mkdir -p "$STATE_DIR" "$LOG_DIR"
LOG="$LOG_DIR/$(TZ=Europe/London date +%F)-$GROUP.log"
SUMMARY="$STATE_DIR/run-$GROUP.json"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() {
  printf '%s camsocs-harvest %s: %s\n' "$(stamp)" "$GROUP" "$*" | tee -a "$LOG"
}

# git within the update's limit; ssh gives up on a dead connection too
# (core.sshCommand, set by install.sh, carries ConnectTimeout / ServerAlive).
git_limited() { timeout --kill-after=1m "$UPDATE_LIMIT" git "$@"; }
pixi_install() {
  timeout --kill-after=1m "$INSTALL_LIMIT" "$PIXI" install --locked --manifest-path "$ROOT/pixi.toml"
}

# --- 1. lock ------------------------------------------------------------------------------
STARTED="$(stamp)"
exec 9>>"$STATE_DIR/harvest.lock"
if [[ "$LOCK_WAIT" -eq 0 ]]; then
  if ! flock -n 9; then
    log "another run holds the lock; skipping this tick"
    exit 0
  fi
elif ! flock -w "$LOCK_WAIT" 9; then
  # The weekly run (and the retention it applies) must not vanish quietly.
  log "another run held the lock for ${LOCK_WAIT}s; the $GROUP run did not start"
  "$PYTHON" -I "$HERE/camsocs-status.py" \
    --state-dir "$STATE_DIR" --group "$GROUP" --env "$ENV_NAME" \
    --started "$STARTED" --finished "$(stamp)" --exit-code 75 --phase lock \
    --commit "" --log "$LOG" --invocation "${INVOCATION_ID:-}" ||
    log "status file not written (camsocs-status.py failed)"
  exit 75
fi

FAILED_PHASE=""
# A summary left by an earlier run must never be reported as this one's.
rm -f "$SUMMARY"

# Both run from the EXIT trap below, which ShellCheck does not follow.
# shellcheck disable=SC2329
write_status() {
  local code="$1" phase="${FAILED_PHASE:-done}" commit=""
  commit="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)"
  "$PYTHON" -I "$HERE/camsocs-status.py" \
    --state-dir "$STATE_DIR" --group "$GROUP" --env "$ENV_NAME" \
    --started "$STARTED" --finished "$(stamp)" --exit-code "$code" --phase "$phase" \
    --commit "$commit" --log "$LOG" --run-summary "$SUMMARY" \
    --invocation "${INVOCATION_ID:-}" ||
    log "status file not written (camsocs-status.py failed)"
}

# shellcheck disable=SC2329
on_exit() {
  local code=$?
  trap - EXIT
  if [[ $code -ne 0 && -z "$FAILED_PHASE" ]]; then
    FAILED_PHASE="script"
  fi
  write_status "$code"
  log "finished with exit code $code${FAILED_PHASE:+ (failed: $FAILED_PHASE)}"
  exit "$code"
}
trap on_exit EXIT
# systemd stops a unit with SIGTERM: record it like any other failure.
trap 'FAILED_PHASE="${FAILED_PHASE:-stopped}"; exit 143' TERM INT

{
  echo "────────────────────────────────────────────────────────────────────"
  echo "$STARTED camsocs-harvest $GROUP: starting (checkout $ROOT, env $ENV_NAME, limit $LIMIT)"
} >>"$LOG"

# --- 2. update ----------------------------------------------------------------------------
cd "$ROOT"
PREV="$(git rev-parse HEAD)"
PREV_BRANCH="$(git symbolic-ref -q --short HEAD || true)"

where() { printf '%s %s' "$(git rev-parse HEAD)" "$(git symbolic-ref -q --short HEAD || true)"; }

restore_checkout() {
  if [[ -n "$PREV_BRANCH" ]]; then
    git checkout --quiet "$PREV_BRANCH" && git reset --quiet --hard "$PREV"
  else
    git checkout --quiet --detach "$PREV"
  fi
}

# Its output goes to the log only (set -e does not hold inside an `if`, hence
# the explicit returns). Pulling never changes this script: it is installed
# outside the checkout (install.sh).
update() {
  local pin=""
  if [[ -s "$STATE_DIR/pin" ]]; then
    pin="$(tr -d '[:space:]' <"$STATE_DIR/pin")"
    if [[ ! "$pin" =~ ^[0-9a-f]{7,40}$ ]]; then
      echo "update: $STATE_DIR/pin holds no commit id"
      return 1
    fi
    echo "update: pinned to $pin ($STATE_DIR/pin)"
    git_limited fetch --quiet origin || return 1
    git checkout --quiet --detach "$pin" || return 1
  else
    if [[ "$PREV_BRANCH" != "$BRANCH" ]]; then
      git checkout --quiet "$BRANCH" || return 1
    fi
    git_limited pull --ff-only --quiet origin "$BRANCH" || return 1
  fi
}

BEFORE="$(where)"
if ! update >>"$LOG" 2>&1; then
  FAILED_PHASE="update"
  if [[ "$(where)" != "$BEFORE" ]]; then
    restore_checkout >>"$LOG" 2>&1 || log "update: could not return to ${PREV:0:12}"
  fi
  log "update failed; the checkout stays at ${PREV:0:12} (see $LOG)"
  exit 10
fi
NEW="$(git rev-parse HEAD)"
if [[ "$NEW" == "$PREV" ]]; then
  log "update: at ${NEW:0:12}, nothing new"
else
  log "update: ${PREV:0:12} → ${NEW:0:12}"
fi

# --- 3. install ---------------------------------------------------------------------------
if ! pixi_install >>"$LOG" 2>&1; then
  FAILED_PHASE="install"
  if [[ "$NEW" != "$PREV" ]]; then
    log "install failed at ${NEW:0:12}; returning to ${PREV:0:12}"
    if restore_checkout >>"$LOG" 2>&1; then
      pixi_install >>"$LOG" 2>&1 ||
        log "install: the environment of ${PREV:0:12} did not install either"
    else
      log "install: could not return to ${PREV:0:12}"
    fi
  else
    log "install failed (see $LOG)"
  fi
  exit 11
fi

# --- 4. pipeline --------------------------------------------------------------------------
log "pipeline: sync --group $GROUP (limit $LIMIT)"
code=0
timeout --kill-after=10m "$LIMIT" \
  "$PIXI" run --locked --manifest-path "$ROOT/pixi.toml" pipeline -- \
  --env "$ENV_NAME" sync --group "$GROUP" --summary-json "$SUMMARY" >>"$LOG" 2>&1 || code=$?
case "$code" in
  0) log "pipeline: ok" ;;
  124) log "pipeline: timed out after $LIMIT" ;;
  137) log "pipeline: killed after not stopping within 10 minutes of the time limit" ;;
  *) log "pipeline: exit code $code" ;;
esac
if [[ $code -ne 0 ]]; then
  FAILED_PHASE="pipeline"
fi

# --- 5. prune ----------------------------------------------------------------------------
# After every run: R7 (90 days) and R4 (30 days for what quotes list mail) are
# applied daily, so a lapsed weekly run never stops retention.
if timeout --kill-after=1m "$INSTALL_LIMIT" "$PIXI" run --locked --manifest-path "$ROOT/pixi.toml" \
  pipeline -- --env "$ENV_NAME" prune-cache >>"$LOG" 2>&1; then
  log "prune: done"
else
  log "prune-cache failed (retention R7 / R4 not applied this run)"
  if [[ $code -eq 0 ]]; then
    FAILED_PHASE="prune"
    code=12
  fi
fi

if [[ $code -eq 0 ]]; then
  git rev-parse HEAD >"$STATE_DIR/last-good-commit"
fi
exit "$code"
