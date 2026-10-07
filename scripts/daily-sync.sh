#!/usr/bin/env bash
# Daily pipeline sync, for a system cron (Bundestracker scripts/daily-sync.sh).
#
# Wraps `pixi run pipeline -- sync` with the three things cron does not give
# you: an environment, a lock, and a log. Resolves the repo from its own
# location, because cron starts in $HOME.
#
#   crontab -e
#   17 4 * * * /path/to/camsocs/scripts/daily-sync.sh
#
# Exit code is the pipeline's own: non-zero when any stage failed, so a cron
# MAILTO or a monitor sees a broken source rather than silence.
#
# Environment (all optional):
#   CAMSOCS_ENV_FILE   extra env file to source (e.g. /etc/camsocs.env); the
#                      pipeline also reads pipeline/.env on its own
#   CAMSOCS_LOG_DIR    default <repo>/.logs
#   CAMSOCS_LOCK_FILE  default <repo>/.daily-sync.lock
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${CAMSOCS_LOG_DIR:-$REPO_ROOT/.logs}"
LOG_FILE="$LOG_DIR/daily-sync.log"
LOCK_FILE="${CAMSOCS_LOCK_FILE:-$REPO_ROOT/.daily-sync.lock}"

mkdir -p "$LOG_DIR"

# cron's PATH is typically /usr/bin:/bin, which has neither pixi nor bun.
export PATH="$HOME/.pixi/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# Never let a stray deploy key reach anything this script runs.
unset CONVEX_DEPLOY_KEY

if [ -n "${CAMSOCS_ENV_FILE:-}" ]; then
  if [ ! -r "$CAMSOCS_ENV_FILE" ]; then
    echo "daily-sync: CAMSOCS_ENV_FILE is set but not readable: $CAMSOCS_ENV_FILE" >&2
    exit 78 # EX_CONFIG
  fi
  set -a
  # shellcheck disable=SC1090
  . "$CAMSOCS_ENV_FILE"
  set +a
fi

if ! command -v pixi >/dev/null 2>&1; then
  echo "daily-sync: pixi not on PATH (looked in $PATH)" >&2
  exit 127
fi

# Never two syncs at once: per-host politeness is enforced inside one process,
# and a slow run overlapping the next tick would double the request rate on
# every host. `-n` fails immediately rather than queueing a second run.
# (`flock` is util-linux; this script targets the Linux cron host.)
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -Is) daily-sync: another sync is still running — skipping this tick." \
    | tee -a "$LOG_FILE" >&2
  exit 0
fi

{
  echo "──────────────────────────────────────────────────────────────"
  echo "$(date -Is) daily-sync: starting (repo: $REPO_ROOT)"
} >>"$LOG_FILE"

status=0
pixi run --manifest-path "$REPO_ROOT/pixi.toml" pipeline -- sync >>"$LOG_FILE" 2>&1 || status=$?

echo "$(date -Is) daily-sync: finished with status $status" >>"$LOG_FILE"
exit "$status"
