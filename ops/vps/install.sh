#!/usr/bin/env bash
# Install, or upgrade, the camsocs harvest runner on the VPS host (decision D5;
# the runbook is docs/ops-vps.md). Run as root. Every step checks before it
# acts, so running it again changes only what differs: that is the upgrade.
# It never touches Docker, Mya's container or cliproxy.
#
#   install.sh --revision SHA [--deploy-key FILE] [--pipeline-env FILE]
#              [--prod-env FILE] [--backup-env FILE] [--enable | --no-enable] [--diff]
#   install.sh --refresh-alert-env
#
#   --revision SHA       the full 40-character commit of main to install the
#                        runner's own files from (the scripts, the units, the
#                        logrotate config): one you reviewed. Root fetches it into
#                        its own mirror and installs only from there — never
#                        from the checkout /opt/camsocs, which the harvest writes.
#   --deploy-key FILE    the private half of the repo's read-only deploy key
#                        (GitHub → camsocs → Settings → Deploy keys, write access
#                        off). Needed once, until it is installed, and to rotate it.
#   --pipeline-env FILE  installed as /opt/camsocs/pipeline/.env: the shared
#                        settings (LLM_BASE_URL=http://127.0.0.1:8317/v1 and the
#                        camsocs cliproxy key, models, User-Agent, Camdram, Meta).
#   --prod-env FILE      installed as /opt/camsocs/pipeline/.env.prod: production's
#                        CONVEX_HTTP_URL and PIPELINE_API_KEY (and the PostHog
#                        values: run telemetry, and the monitor's personal key).
#   --backup-env FILE    installed as /etc/camsocs/backup.env (0600 root): one
#                        line, CONVEX_DEPLOY_KEY=prod:cheerful-bandicoot-511|…,
#                        the production deploy key the nightly backup exports
#                        with (ENG-44; docs/ops-vps.md §10). Nothing else may
#                        be in it.
#   --enable             turn the timers on (and start them): the two harvests'
#                        and the hourly monitor's, and the backup's two when
#                        /etc/camsocs/backup.env exists.
#   --no-enable          on a first install, leave the timers off.
#                        Without either, a first install turns them on and a
#                        later run turns on only a timer it installs for the
#                        first time (the monitor's, on an upgrade; the
#                        backup's two once backup.env exists), leaving each
#                        other timer as the operator left it.
#   --diff               show what installing SHA would change, change nothing.
#   --refresh-alert-env  copy the three Slack values from Mya's env file into
#                        /etc/camsocs/alert.env again (after Mya's token
#                        changed), and nothing else.
#
# Steps:
#   1. tools: git, flock, timeout, curl, sha256sum, tar, ssh, python3, logrotate, systemctl
#   2. the `camsocs` system user: home /var/lib/camsocs, no login shell
#   3. pixi 0.73.0 → /usr/local/bin/pixi, from the official GitHub release; the
#      archive's sha256 must match both the release's checksum file and the
#      hash pinned below
#   4. the deploy key, twice: root's copy /etc/camsocs/deploy_key (0600 root)
#      and the camsocs user's /var/lib/camsocs/.ssh/camsocs_deploy; github.com's
#      host key, checked against GitHub's published fingerprint, for both
#   5. the revision: fetched into root's mirror /var/lib/camsocs-ops/camsocs.git,
#      checked to be a commit on main, and its ops/vps extracted; if that
#      revision's installer differs from this one, it runs instead
#   6. the checkout: main cloned into /opt/camsocs as camsocs; an existing
#      checkout is left as it is (each run pulls), only its ssh command is set
#   7. the env files given (0600, camsocs; written as camsocs); their values are
#      never printed
#   8. /etc/camsocs/alert.env (0600 root): SLACK_BOT_TOKEN, SLACK_HOME_CHANNEL
#      and SLACK_ALLOWED_USERS from Mya's env file, nothing else
#   9. the runner's scripts → /usr/local/lib/camsocs-ops (root-owned), with the
#      revision in REVISION; /var/lib/camsocs, /var/log/camsocs and
#      /etc/logrotate.d/camsocs
#  10. the systemd units → /etc/systemd/system, daemon-reload; the timers on
#      for a first install (unless --no-enable) or with --enable; a timer new to
#      this host on too (unless --no-enable, or both harvest timers are off);
#      else each as it was
#  11. `pixi install --locked` as camsocs, holding the harvest lock (it waits up
#      to 10 minutes for a running harvest), so the first run starts warm
#  12. the backup (ENG-44), when the revision has one: /etc/camsocs/backup.env
#      from --backup-env (0600 root); the Convex CLI's toolchain root-owned in
#      /usr/local/lib/camsocs-ops/backup/ (node by `pixi install --locked`, the
#      CLI by `npm ci --ignore-scripts`, both from the revision's lock files);
#      the pinned convex-local-backend for the restore test, its sha256 checked
set -euo pipefail

REPO_URL="git@github.com:joshua-e-fehn/camsocs.git"
BRANCH="main"
ROOT="/opt/camsocs"
USER_NAME="camsocs"
HOME_DIR="/var/lib/camsocs"
LOG_DIR="/var/log/camsocs"
KEY_PATH="$HOME_DIR/.ssh/camsocs_deploy"
KNOWN_HOSTS="$HOME_DIR/.ssh/known_hosts"
UNIT_DIR="/etc/systemd/system"
TIMERS=(camsocs-harvest-events.timer camsocs-harvest-full.timer camsocs-monitor.timer)
MYA_ENV="/docker/hermes-agent-vspa/data/.env"
# Root's own: the installed runner, its keys and its mirror of the repository.
OPS_DIR="/usr/local/lib/camsocs-ops"
ETC_DIR="/etc/camsocs"
ALERT_ENV="$ETC_DIR/alert.env"
ROOT_KEY="$ETC_DIR/deploy_key"
ROOT_KNOWN_HOSTS="$ETC_DIR/known_hosts"
MIRROR="/var/lib/camsocs-ops/camsocs.git"
OPS_FILES=(camsocs-harvest.sh camsocs-alert.py camsocs-status.py install.sh)
# The backup (ENG-44): its script and toolchain, installed when the revision
# has them (an earlier revision, installed for a rollback, has not).
BACKUP_SCRIPT="camsocs-backup.py"
BACKUP_FILES=(pixi.toml pixi.lock package.json package-lock.json)
BACKUP_TOOLS="$OPS_DIR/backup"
BACKUP_ENV="$ETC_DIR/backup.env"
BACKUP_TIMERS=(camsocs-backup.timer camsocs-restore-test.timer)
BACKUP_DEPLOYMENT="cheerful-bandicoot-511"
# The restore test's throwaway backend: the release the Convex CLI would
# download for `convex dev --local`, pinned (2026-10-22, the latest
# non-prerelease on 2026-11-04) with the sha256 GitHub publishes for the asset.
CONVEX_BACKEND_RELEASE="precompiled-2026-10-22-1447815"
CONVEX_BACKEND_ASSET="convex-local-backend-x86_64-unknown-linux-gnu.zip"
CONVEX_BACKEND_SHA256="7be627d8a8c9175b66a55cf6c4ab63c5f6bde1c412f59fbbe93f64a24a11bd13"
CONVEX_BACKEND_URL="https://github.com/get-convex/convex-backend/releases/download/$CONVEX_BACKEND_RELEASE/$CONVEX_BACKEND_ASSET"
ALERT_KEYS="SLACK_BOT_TOKEN|SLACK_HOME_CHANNEL|SLACK_ALLOWED_USERS"

PIXI_VERSION="0.73.0"
PIXI_ASSET="pixi-x86_64-unknown-linux-musl.tar.gz"
# The sha256 of $PIXI_ASSET, from the release's own .sha256 file (2026-10-10).
PIXI_SHA256="682564e7cd35d38307df3cd6c8e9a45a1437d20febac0c8d165809d7c38408d1"
PIXI_URL="https://github.com/prefix-dev/pixi/releases/download/v$PIXI_VERSION/$PIXI_ASSET"
# GitHub's published SSH host key fingerprint (api.github.com/meta, docs.github.com).
GITHUB_ED25519="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"

# A dead connection never hangs a fetch (each run's pull uses the same options).
SSH_OPTIONS="-o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30 -o ServerAliveInterval=30 -o ServerAliveCountMax=4"
SSH_COMMAND="ssh -i $KEY_PATH $SSH_OPTIONS -o UserKnownHostsFile=$KNOWN_HOSTS"
ROOT_SSH_COMMAND="ssh -i $ROOT_KEY $SSH_OPTIONS -o UserKnownHostsFile=$ROOT_KNOWN_HOSTS"

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,75p' "$0"
  exit 0
}

# From the user's home: git and pixi must not start in a directory only root
# can read (this script's own, under /root).
as_camsocs() {
  (cd "$HOME_DIR" && runuser -u "$USER_NAME" -- env HOME="$HOME_DIR" PATH=/usr/local/bin:/usr/bin:/bin "$@")
}

# Writes stdin to DEST as the camsocs user (0600): a file in a directory that
# user owns is never written by root, so a link planted there cannot point a
# root write elsewhere. The new file replaces whatever was at DEST.
write_as_camsocs() {
  # shellcheck disable=SC2016 # expanded by the inner shell
  as_camsocs sh -c 'umask 077 && cat >"$1.new" && mv -f "$1.new" "$1"' sh "$1"
}

# The three Slack values (and nothing else) of a dotenv file, as lines.
extract_alert_env() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?($ALERT_KEYS)[[:space:]]*=" "$1" || true
}

refresh_alert_env() {
  install -d -m 0750 -o root -g root "$ETC_DIR"
  if [[ ! -r "$MYA_ENV" ]]; then
    warn "$MYA_ENV is missing: failure alerts cannot be sent until --refresh-alert-env"
    return 0
  fi
  local tmp
  tmp="$(mktemp "$ETC_DIR/.alert.env.XXXXXX")"
  extract_alert_env "$MYA_ENV" >"$tmp"
  chmod 0600 "$tmp"
  chown root:root "$tmp"
  if [[ -f "$ALERT_ENV" ]] && cmp -s "$tmp" "$ALERT_ENV"; then
    rm -f "$tmp"
    say "$ALERT_ENV is up to date"
  else
    mv -f "$tmp" "$ALERT_ENV"
    say "wrote $ALERT_ENV (0600 root: the Slack token, home channel and allowed users only)"
  fi
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?SLACK_BOT_TOKEN[[:space:]]*=.' "$ALERT_ENV" ||
    warn "$MYA_ENV names no SLACK_BOT_TOKEN: failure alerts cannot be sent"
}

# Fetches main into root's mirror, checks that REVISION is a commit on it and
# extracts that commit's ops/vps into $REV_DIR. Root reads nothing from the
# camsocs checkout: the mirror, its key and its known_hosts are root's.
fetch_revision() {
  local revision="$1"
  install -d -m 0700 -o root -g root "$(dirname "$MIRROR")"
  if [[ ! -d "$MIRROR" ]]; then
    git init --quiet --bare "$MIRROR"
    git --git-dir="$MIRROR" remote add origin "$REPO_URL"
  fi
  say "fetching $BRANCH into $MIRROR"
  GIT_SSH_COMMAND="$ROOT_SSH_COMMAND" timeout --kill-after=1m 10m \
    git --git-dir="$MIRROR" fetch --quiet --prune origin "+refs/heads/$BRANCH:refs/heads/$BRANCH" ||
    die "could not fetch $BRANCH from $REPO_URL"
  git --git-dir="$MIRROR" cat-file -e "$revision^{commit}" 2>/dev/null ||
    die "$revision is not a commit of $REPO_URL"
  git --git-dir="$MIRROR" merge-base --is-ancestor "$revision" "refs/heads/$BRANCH" ||
    die "$revision is not on $BRANCH"
  REV_DIR="$WORK/rev/ops/vps"
  mkdir -p "$WORK/rev"
  git --git-dir="$MIRROR" archive --format=tar "$revision" ops/vps | tar -x -C "$WORK/rev"
  local file
  for file in "${OPS_FILES[@]}" logrotate/camsocs systemd/camsocs-harvest@.service systemd/camsocs-alert@.service; do
    [[ -f "$REV_DIR/$file" ]] || die "$revision has no ops/vps/$file"
  done
}

# One file's diff against what is installed; returns 1 when it differs.
compare_file() {
  local installed="$1" incoming="$2" shown="$1"
  [[ -f "$installed" ]] || installed=/dev/null
  diff -u --label "installed $shown" --label "revision ${incoming#"$WORK/rev/"}" \
    "$installed" "$incoming"
}

# What installing the fetched revision would change, file by file.
show_diff() {
  local changed=0 file
  for file in "${OPS_FILES[@]}"; do
    compare_file "$OPS_DIR/$file" "$REV_DIR/$file" || changed=1
  done
  compare_file /etc/logrotate.d/camsocs "$REV_DIR/logrotate/camsocs" || changed=1
  if [[ -f "$REV_DIR/$BACKUP_SCRIPT" ]]; then
    compare_file "$OPS_DIR/$BACKUP_SCRIPT" "$REV_DIR/$BACKUP_SCRIPT" || changed=1
    for file in "${BACKUP_FILES[@]}"; do
      compare_file "$BACKUP_TOOLS/$file" "$REV_DIR/backup/$file" || changed=1
    done
  fi
  for file in "$REV_DIR"/systemd/*; do
    compare_file "$UNIT_DIR/$(basename "$file")" "$file" || changed=1
  done
  if [[ $changed -eq 0 ]]; then
    say "the installed runner is the revision's: nothing to change"
  fi
}

# A backup key file holds exactly one setting, production's deploy key:
# `CONVEX_DEPLOY_KEY=prod:<deployment>|…` (comments and blank lines aside).
# Anything else (a dev or preview key, CONVEX_DEPLOYMENT, a self-hosted URL)
# would back up another deployment. Prints nothing of the value.
check_backup_env() {
  local settings
  settings="$(grep -Ev '^[[:space:]]*(#|$)' "$1" || true)"
  [[ "$(printf '%s\n' "$settings" | grep -c .)" == 1 ]] &&
    printf '%s\n' "$settings" | grep -Eq "^(export[[:space:]]+)?CONVEX_DEPLOY_KEY=[\"']?prod:${BACKUP_DEPLOYMENT}[|]."
}

# ShellCheck 0.11 reports say/die here as defined later (SC2218), as for
# install_runner below; they are defined at the top.
# shellcheck disable=SC2218
# Step 12: the backup's key, its Convex CLI (node + the npm package, from the
# revision's lock files) and the restore test's local backend, all root-owned;
# then its two timers. Skipped for a revision from before ENG-44.
install_backup() {
  if [[ ! -f "$REV_DIR/$BACKUP_SCRIPT" || ! -d "$REV_DIR/backup" ]]; then
    say "the revision has no backup (ENG-44): skipped"
    return 0
  fi
  if [[ -n "$backup_env" ]]; then
    [[ -r "$backup_env" ]] || die "cannot read $backup_env"
    check_backup_env "$backup_env" ||
      die "$backup_env must hold one line, CONVEX_DEPLOY_KEY=prod:$BACKUP_DEPLOYMENT|… (production's deploy key), and nothing else"
    if [[ -f "$BACKUP_ENV" ]] && cmp -s "$backup_env" "$BACKUP_ENV"; then
      say "$BACKUP_ENV is up to date"
    else
      install -m 0600 -o root -g root "$backup_env" "$BACKUP_ENV"
      say "installed $BACKUP_ENV (0600 root: the backup's deploy key)"
    fi
  elif [[ -f "$BACKUP_ENV" ]] && ! check_backup_env "$BACKUP_ENV"; then
    warn "$BACKUP_ENV is not one CONVEX_DEPLOY_KEY=prod:$BACKUP_DEPLOYMENT|… line: the backup will refuse it"
  fi

  install -d -m 0755 -o root -g root "$BACKUP_TOOLS"
  local stamp file node="$BACKUP_TOOLS/.pixi/envs/default/bin/node"
  stamp="$(cd "$REV_DIR/backup" && sha256sum "${BACKUP_FILES[@]}" | sha256sum | cut -d' ' -f1)"
  if [[ "$(cat "$BACKUP_TOOLS/.installed" 2>/dev/null || true)" == "$stamp" && -x "$node" &&
    -f "$BACKUP_TOOLS/node_modules/convex/bin/main.js" ]]; then
    say "the backup's Convex CLI is installed"
  else
    say "installing the backup's Convex CLI → $BACKUP_TOOLS (pixi install --locked, npm ci --ignore-scripts)"
    rm -f "$BACKUP_TOOLS/.installed"
    for file in "${BACKUP_FILES[@]}"; do
      install -m 0644 -o root -g root "$REV_DIR/backup/$file" "$BACKUP_TOOLS/$file"
    done
    (cd "$BACKUP_TOOLS" && timeout --kill-after=1m 30m /usr/local/bin/pixi install --locked --manifest-path "$BACKUP_TOOLS/pixi.toml") ||
      die "pixi install of the backup's node failed"
    (cd "$BACKUP_TOOLS" && env PATH="$(dirname "$node"):/usr/bin:/bin" HOME="$WORK" \
      timeout --kill-after=1m 30m npm ci --ignore-scripts --no-audit --no-fund --cache "$WORK/npm-cache") ||
      die "npm ci of the backup's Convex CLI failed"
    local want have
    want="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["dependencies"]["convex"])' "$BACKUP_TOOLS/package.json")"
    have="$("$node" "$BACKUP_TOOLS/node_modules/convex/bin/main.js" --version)"
    [[ "$have" == "$want" ]] || die "the backup's Convex CLI is $have, not the pinned $want"
    chown -R root:root "$BACKUP_TOOLS"
    chmod -R go-w "$BACKUP_TOOLS"
    printf '%s\n' "$stamp" >"$BACKUP_TOOLS/.installed"
  fi

  if [[ -x "$BACKUP_TOOLS/convex-local-backend" &&
    "$(cat "$BACKUP_TOOLS/convex-local-backend.sha256" 2>/dev/null || true)" == "$CONVEX_BACKEND_SHA256" ]]; then
    say "the restore test's local backend ($CONVEX_BACKEND_RELEASE) is installed"
  else
    say "installing the restore test's local backend $CONVEX_BACKEND_RELEASE from $CONVEX_BACKEND_URL"
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 900 -o "$WORK/$CONVEX_BACKEND_ASSET" "$CONVEX_BACKEND_URL" ||
      die "could not download $CONVEX_BACKEND_ASSET"
    local actual
    actual="$(sha256sum "$WORK/$CONVEX_BACKEND_ASSET" | cut -d' ' -f1)"
    [[ "$actual" == "$CONVEX_BACKEND_SHA256" ]] ||
      die "$CONVEX_BACKEND_ASSET sha256 $actual is not the pinned $CONVEX_BACKEND_SHA256"
    mkdir -p "$WORK/backend"
    python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract("convex-local-backend", sys.argv[2])' \
      "$WORK/$CONVEX_BACKEND_ASSET" "$WORK/backend" || die "$CONVEX_BACKEND_ASSET has no convex-local-backend"
    install -m 0755 -o root -g root "$WORK/backend/convex-local-backend" "$BACKUP_TOOLS/convex-local-backend"
    printf '%s\n' "$CONVEX_BACKEND_SHA256" >"$WORK/backend.sha256"
    install -m 0644 -o root -g root "$WORK/backend.sha256" "$BACKUP_TOOLS/convex-local-backend.sha256"
  fi

  # On with the key: on --enable, when this run installed the key, and for a
  # timer new to this host; otherwise each stays as the operator left it.
  local timer
  if [[ ! -f "$BACKUP_ENV" ]]; then
    say "no $BACKUP_ENV yet: the backup's timers stay off until install.sh --backup-env FILE (docs/ops-vps.md §10)"
  elif [[ "$enable" != "no" ]]; then
    for timer in "${BACKUP_TIMERS[@]}"; do
      if [[ "$enable" == "yes" || -n "$backup_env" || " ${NEW_BACKUP_TIMERS[*]} " == *" $timer "* ]]; then
        systemctl enable --now "$timer"
      fi
    done
  fi
  for timer in "${BACKUP_TIMERS[@]}"; do
    say "$timer: $(systemctl is-enabled "$timer" 2>/dev/null || true)"
  done
}

parse_args() {
  ORIGINAL_ARGS=("$@")
  revision="" deploy_key="" pipeline_env="" prod_env="" backup_env="" enable="auto" diff_only=0 refresh_only=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --revision)
        revision="${2:?--revision needs a commit}"
        shift 2
        ;;
      --deploy-key)
        deploy_key="${2:?--deploy-key needs a file}"
        shift 2
        ;;
      --pipeline-env)
        pipeline_env="${2:?--pipeline-env needs a file}"
        shift 2
        ;;
      --prod-env)
        prod_env="${2:?--prod-env needs a file}"
        shift 2
        ;;
      --backup-env)
        backup_env="${2:?--backup-env needs a file}"
        shift 2
        ;;
      --enable)
        enable="yes"
        shift
        ;;
      --no-enable)
        enable="no"
        shift
        ;;
      --diff)
        diff_only=1
        shift
        ;;
      --refresh-alert-env)
        refresh_only=1
        shift
        ;;
      -h | --help) usage ;;
      *) die "unknown argument: $1 (see --help)" ;;
    esac
  done
}

# ShellCheck 0.11 reports say/die here as defined later (SC2218); they are
# defined at the top, and nothing runs before main at the bottom.
# shellcheck disable=SC2218
install_runner() {
  [[ -n "$revision" ]] || die "--revision SHA is required: the full commit of main you reviewed"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "--revision must be a full 40-character commit id"
  [[ "$(uname -m)" == "x86_64" ]] || die "this installer pins pixi for x86_64 only"

  WORK="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: WORK is fixed for this run
  trap "rm -rf '$WORK' ${CAMSOCS_INSTALL_SELF:+'$CAMSOCS_INSTALL_SELF'}" EXIT

  # --- 1. tools -------------------------------------------------------------------------
  say "checking tools"
  local missing=() tool
  for tool in git flock timeout curl sha256sum tar ssh ssh-keyscan ssh-keygen python3 logrotate runuser systemctl cmp diff; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "missing: ${missing[*]} — install them first (apt-get install git curl python3 logrotate openssh-client diffutils)"
  fi

  if [[ $diff_only -eq 1 ]]; then
    [[ -d "$MIRROR" && -f "$ROOT_KEY" ]] || die "--diff needs an installed runner (no $MIRROR yet)"
    fetch_revision "$revision"
    show_diff
    exit 0
  fi

  # --- 2. user --------------------------------------------------------------------------
  if id -u "$USER_NAME" >/dev/null 2>&1; then
    say "user $USER_NAME exists"
  else
    say "creating system user $USER_NAME (home $HOME_DIR)"
    useradd --system --user-group --home-dir "$HOME_DIR" --create-home \
      --shell /usr/sbin/nologin --comment "camsocs harvest runner" "$USER_NAME"
  fi
  # Their parents are root's, so these two paths cannot be swapped for links.
  install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR" "$LOG_DIR"
  as_camsocs install -d -m 0700 "$HOME_DIR/.ssh"

  # --- 3. pixi --------------------------------------------------------------------------
  if [[ -x /usr/local/bin/pixi ]] && [[ "$(/usr/local/bin/pixi --version 2>/dev/null)" == "pixi $PIXI_VERSION" ]]; then
    say "pixi $PIXI_VERSION is installed"
  else
    say "installing pixi $PIXI_VERSION from $PIXI_URL"
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 600 -o "$WORK/$PIXI_ASSET" "$PIXI_URL"
    curl --proto '=https' --tlsv1.2 -fsSL --max-time 60 -o "$WORK/$PIXI_ASSET.sha256" "$PIXI_URL.sha256"
    (cd "$WORK" && sha256sum --check --strict --quiet "$PIXI_ASSET.sha256") ||
      die "pixi archive does not match the release's checksum file"
    local actual binary
    actual="$(sha256sum "$WORK/$PIXI_ASSET" | cut -d' ' -f1)"
    [[ "$actual" == "$PIXI_SHA256" ]] ||
      die "pixi archive sha256 $actual is not the pinned $PIXI_SHA256"
    mkdir "$WORK/pixi"
    tar -xzf "$WORK/$PIXI_ASSET" -C "$WORK/pixi"
    binary="$(find "$WORK/pixi" -type f -name pixi | head -n 1)"
    [[ -n "$binary" ]] || die "no pixi binary in $PIXI_ASSET"
    install -m 0755 -o root -g root "$binary" /usr/local/bin/pixi
    [[ "$(/usr/local/bin/pixi --version)" == "pixi $PIXI_VERSION" ]] || die "pixi did not install"
  fi

  # --- 4. deploy key and github.com's host key --------------------------------------------
  install -d -m 0750 -o root -g root "$ETC_DIR"
  if [[ -n "$deploy_key" ]]; then
    [[ -r "$deploy_key" ]] || die "cannot read $deploy_key"
    ssh-keygen -y -P '' -f "$deploy_key" >/dev/null 2>&1 ||
      die "$deploy_key is not a private key without a passphrase"
    if [[ -f "$ROOT_KEY" ]] && cmp -s "$deploy_key" "$ROOT_KEY"; then
      say "deploy key is installed (root's copy)"
    else
      say "installing the deploy key → $ROOT_KEY (root) and $KEY_PATH ($USER_NAME)"
      install -m 0600 -o root -g root "$deploy_key" "$ROOT_KEY"
    fi
    if ! cmp -s "$deploy_key" "$KEY_PATH" 2>/dev/null; then
      write_as_camsocs "$KEY_PATH" <"$deploy_key"
    fi
  elif [[ ! -f "$ROOT_KEY" ]]; then
    die "no deploy key yet: pass --deploy-key FILE (read-only deploy key of joshua-e-fehn/camsocs)"
  fi

  if [[ -f "$ROOT_KNOWN_HOSTS" ]] && ssh-keygen -lf "$ROOT_KNOWN_HOSTS" 2>/dev/null | grep -qF "$GITHUB_ED25519"; then
    say "github.com host key is known"
  else
    say "checking github.com's host key against $GITHUB_ED25519"
    ssh-keyscan -T 30 -t ed25519 github.com >"$WORK/github" 2>/dev/null || die "ssh-keyscan github.com failed"
    ssh-keygen -lf "$WORK/github" | grep -qF "$GITHUB_ED25519" ||
      die "github.com offered a host key that is not GitHub's published one"
    install -m 0644 -o root -g root "$WORK/github" "$ROOT_KNOWN_HOSTS"
  fi
  if ! cmp -s "$ROOT_KNOWN_HOSTS" "$KNOWN_HOSTS" 2>/dev/null; then
    write_as_camsocs "$KNOWN_HOSTS" <"$ROOT_KNOWN_HOSTS"
  fi

  # --- 5. the revision ------------------------------------------------------------------
  fetch_revision "$revision"
  if [[ "${CAMSOCS_INSTALL_REVISION:-}" != "$revision" ]] && ! cmp -s "$REV_DIR/install.sh" "$0"; then
    # The reviewed revision's own installer does the rest.
    local next
    next="$(mktemp)"
    install -m 0700 "$REV_DIR/install.sh" "$next"
    rm -rf "$WORK"
    say "running the installer of ${revision:0:12}"
    exec env CAMSOCS_INSTALL_REVISION="$revision" CAMSOCS_INSTALL_SELF="$next" \
      bash "$next" "${ORIGINAL_ARGS[@]}"
  fi

  # --- 6. checkout ----------------------------------------------------------------------
  if [[ -d "$ROOT/.git" ]]; then
    say "checkout $ROOT exists (each run pulls it)"
    local remote
    remote="$(as_camsocs git -C "$ROOT" remote get-url origin)"
    [[ "$remote" == "$REPO_URL" ]] || warn "$ROOT's origin is $remote, not $REPO_URL"
  else
    say "cloning $REPO_URL ($BRANCH) → $ROOT"
    install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$ROOT"
    as_camsocs env GIT_SSH_COMMAND="$SSH_COMMAND" timeout 15m git clone --quiet --branch "$BRANCH" "$REPO_URL" "$ROOT"
  fi
  as_camsocs git -C "$ROOT" config core.sshCommand "$SSH_COMMAND"
  as_camsocs install -d -m 0750 "$ROOT/var"

  # --- 7. env files ---------------------------------------------------------------------
  local from to
  for pair in "$pipeline_env:$ROOT/pipeline/.env" "$prod_env:$ROOT/pipeline/.env.prod"; do
    from="${pair%%:*}"
    to="${pair#*:}"
    [[ -n "$from" ]] || continue
    [[ -r "$from" ]] || die "cannot read $from"
    if cmp -s "$from" "$to" 2>/dev/null; then
      say "$to is up to date"
    else
      say "installing $to (0600, $USER_NAME)"
      write_as_camsocs "$to" <"$from"
    fi
  done

  # Names only: no value is ever printed.
  if [[ -f "$ROOT/pipeline/.env" ]]; then
    grep -q '^LLM_BASE_URL=http://127\.0\.0\.1:8317/v1/\{0,1\}$' "$ROOT/pipeline/.env" ||
      warn "pipeline/.env: LLM_BASE_URL is not http://127.0.0.1:8317/v1 (the host's cliproxy, D5)"
    local name
    for name in LLM_API_KEY LLM_MODEL_BULK LLM_MODEL_STRONG CAMSOCS_USER_AGENT; do
      grep -q "^$name=." "$ROOT/pipeline/.env" || warn "pipeline/.env: $name is not set"
    done
    if grep -q '^CAMSOCS_USER_AGENT=.' "$ROOT/pipeline/.env" &&
      ! grep -q '^CAMSOCS_USER_AGENT=.*https://camsocs\.uk/about' "$ROOT/pipeline/.env"; then
      warn "pipeline/.env: CAMSOCS_USER_AGENT does not link https://camsocs.uk/about (the About page the site names)"
    fi
    if grep -Eq '^(CONVEX_URL|CONVEX_HTTP_URL|PIPELINE_API_KEY)=.' "$ROOT/pipeline/.env"; then
      warn "pipeline/.env names a deployment; on this host only pipeline/.env.prod should"
    fi
  else
    warn "no $ROOT/pipeline/.env yet: runs fail until --pipeline-env installs it"
  fi
  if [[ -f "$ROOT/pipeline/.env.prod" ]]; then
    for name in CONVEX_HTTP_URL PIPELINE_API_KEY; do
      grep -q "^$name=." "$ROOT/pipeline/.env.prod" || warn "pipeline/.env.prod: $name is not set"
    done
    # Optional: without them the hourly monitor runs but checks nothing.
    for name in POSTHOG_PERSONAL_API_KEY POSTHOG_PROJECT_ID; do
      grep -q "^$name=." "$ROOT/pipeline/.env.prod" ||
        warn "pipeline/.env.prod: $name is not set (the monitor checks nothing)"
    done
  else
    warn "no $ROOT/pipeline/.env.prod yet: runs fail until --prod-env installs it"
  fi

  # --- 8. the alert's three Slack values ---------------------------------------------------
  refresh_alert_env

  # --- 9. the runner's scripts and logs ---------------------------------------------------
  say "installing the runner of ${revision:0:12} → $OPS_DIR (root-owned)"
  install -d -m 0755 -o root -g root "$OPS_DIR"
  local file mode
  for file in "${OPS_FILES[@]}"; do
    mode=0755
    [[ "$file" == *.py ]] && mode=0644
    install -m "$mode" -o root -g root "$REV_DIR/$file" "$OPS_DIR/$file"
  done
  if [[ -f "$REV_DIR/$BACKUP_SCRIPT" ]]; then
    install -m 0644 -o root -g root "$REV_DIR/$BACKUP_SCRIPT" "$OPS_DIR/$BACKUP_SCRIPT"
  fi
  printf '%s\n' "$revision" >"$WORK/REVISION"
  install -m 0644 -o root -g root "$WORK/REVISION" "$OPS_DIR/REVISION"
  install -m 0644 -o root -g root "$REV_DIR/logrotate/camsocs" /etc/logrotate.d/camsocs

  # --- 10. systemd ------------------------------------------------------------------------
  local first_install=1 timer new_timers=()
  for timer in "${TIMERS[@]}"; do
    if [[ -f "$UNIT_DIR/$timer" ]]; then
      first_install=0
    else
      new_timers+=("$timer")
    fi
  done
  NEW_BACKUP_TIMERS=()
  for timer in "${BACKUP_TIMERS[@]}"; do
    [[ -f "$UNIT_DIR/$timer" ]] || NEW_BACKUP_TIMERS+=("$timer")
  done
  say "installing systemd units"
  local unit
  for unit in "$REV_DIR"/systemd/*; do
    install -m 0644 -o root -g root "$unit" "$UNIT_DIR/$(basename "$unit")"
  done
  systemctl daemon-reload
  if [[ "$enable" == "yes" || ("$enable" == "auto" && $first_install -eq 1) ]]; then
    systemctl enable --now "${TIMERS[@]}"
    say "timers enabled"
  elif [[ $first_install -eq 1 ]]; then
    say "timers left off (--no-enable): systemctl enable --now ${TIMERS[*]}"
  else
    # A timer this host never had (the monitor's, on an upgrade) starts on,
    # unless the operator has stopped the harvests: then it stays off too (the
    # monitor would only report the stale harvest).
    if [[ "$enable" == "auto" && ${#new_timers[@]} -gt 0 ]]; then
      local harvest_on=0
      for timer in camsocs-harvest-events.timer camsocs-harvest-full.timer; do
        if systemctl is-enabled --quiet "$timer" 2>/dev/null; then harvest_on=1; fi
      done
      if [[ $harvest_on -eq 1 ]]; then
        systemctl enable --now "${new_timers[@]}"
        say "new timers enabled: ${new_timers[*]}"
      else
        say "new timers left off (the harvest timers are off): systemctl enable --now ${new_timers[*]}"
      fi
    fi
    for timer in "${TIMERS[@]}"; do
      say "$timer: $(systemctl is-enabled "$timer" 2>/dev/null || true)"
    done
  fi

  # --- 11. environment --------------------------------------------------------------------
  # Under the harvest's lock: never next to a running harvest's own install.
  say "pixi install --locked (as $USER_NAME, under the harvest lock)"
  local code=0
  as_camsocs flock -E 75 -w 600 "$HOME_DIR/harvest.lock" \
    timeout --kill-after=1m 30m pixi install --locked --manifest-path "$ROOT/pixi.toml" || code=$?
  case "$code" in
    0) ;;
    75) warn "a harvest held the lock for 10 minutes: pixi install skipped (the next run installs)" ;;
    *) warn "pixi install failed (exit $code): the next run tries again and alerts if it fails" ;;
  esac

  # --- 12. the backup (ENG-44) -------------------------------------------------------------
  install_backup

  say "done (${revision:0:12}). First run: systemctl start --no-block camsocs-harvest@full.service; journalctl -fu camsocs-harvest@full"
  systemctl list-timers --all 'camsocs-*' --no-pager || true
}

main() {
  parse_args "$@"
  [[ $EUID -eq 0 ]] || die "run as root (sudo $0 …)"
  if [[ $refresh_only -eq 1 ]]; then
    refresh_alert_env
  else
    install_runner
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
