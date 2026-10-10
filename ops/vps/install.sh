#!/usr/bin/env bash
# Install, or upgrade, the camsocs harvest runner on the VPS host (decision D5;
# the runbook is docs/ops-vps.md). Run as root. Every step checks before it
# acts, so running it again changes only what differs: that is the upgrade.
# It never touches Docker, Mya's container or cliproxy.
#
#   install.sh [--deploy-key FILE] [--pipeline-env FILE] [--prod-env FILE] [--no-enable]
#
#   --deploy-key FILE    the private half of the repo's read-only deploy key
#                        (GitHub → camsocs → Settings → Deploy keys, write access
#                        off). Needed once, until it is installed.
#   --pipeline-env FILE  installed as /opt/camsocs/pipeline/.env: the shared
#                        settings (LLM_BASE_URL=http://127.0.0.1:8317/v1 and the
#                        camsocs cliproxy key, models, User-Agent, Camdram, Meta).
#   --prod-env FILE      installed as /opt/camsocs/pipeline/.env.prod: production's
#                        CONVEX_HTTP_URL and PIPELINE_API_KEY.
#   --no-enable          install everything, but leave the timers off.
#
# Steps:
#   1. tools: git, flock, timeout, curl, sha256sum, tar, ssh, python3, logrotate, systemctl
#   2. the `camsocs` system user: home /var/lib/camsocs, no login shell
#   3. pixi 0.73.0 → /usr/local/bin/pixi, from the official GitHub release; the
#      archive's sha256 must match both the release's checksum file and the
#      hash pinned below
#   4. the deploy key → /var/lib/camsocs/.ssh/camsocs_deploy (0600), and
#      github.com's host key, checked against GitHub's published fingerprint
#   5. the checkout: main cloned into /opt/camsocs as camsocs; an existing
#      checkout is left as it is (each run pulls), only its ssh command is set
#   6. the env files given (0600, camsocs); their values are never printed
#   7. /var/lib/camsocs, /var/log/camsocs and /etc/logrotate.d/camsocs
#   8. the systemd units → /etc/systemd/system, daemon-reload, and (unless
#      --no-enable) the two timers enabled and started
#   9. `pixi install --locked` as camsocs, so the first run starts warm
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
TIMERS=(camsocs-harvest-events.timer camsocs-harvest-full.timer)
MYA_ENV="/docker/hermes-agent-vspa/data/.env"

PIXI_VERSION="0.73.0"
PIXI_ASSET="pixi-x86_64-unknown-linux-musl.tar.gz"
# The sha256 of $PIXI_ASSET, from the release's own .sha256 file (2026-10-10).
PIXI_SHA256="682564e7cd35d38307df3cd6c8e9a45a1437d20febac0c8d165809d7c38408d1"
PIXI_URL="https://github.com/prefix-dev/pixi/releases/download/v$PIXI_VERSION/$PIXI_ASSET"
# GitHub's published SSH host key fingerprint (api.github.com/meta, docs.github.com).
GITHUB_ED25519="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"

SSH_COMMAND="ssh -i $KEY_PATH -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,37p' "$0"
  exit 0
}

# From the user's home: git and pixi must not start in a directory only root
# can read (this script's own, under /root).
as_camsocs() {
  (cd "$HOME_DIR" && runuser -u "$USER_NAME" -- env HOME="$HOME_DIR" PATH=/usr/local/bin:/usr/bin:/bin "$@")
}

DEPLOY_KEY=""
PIPELINE_ENV=""
PROD_ENV=""
ENABLE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-key)
      DEPLOY_KEY="${2:?--deploy-key needs a file}"
      shift 2
      ;;
    --pipeline-env)
      PIPELINE_ENV="${2:?--pipeline-env needs a file}"
      shift 2
      ;;
    --prod-env)
      PROD_ENV="${2:?--prod-env needs a file}"
      shift 2
      ;;
    --no-enable)
      ENABLE=0
      shift
      ;;
    -h | --help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo $0 …)"
[[ "$(uname -m)" == "x86_64" ]] || die "this installer pins pixi for x86_64 only"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. tools ---------------------------------------------------------------------------
say "checking tools"
missing=()
for tool in git flock timeout curl sha256sum tar ssh ssh-keyscan ssh-keygen python3 logrotate runuser systemctl; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  die "missing: ${missing[*]} — install them first (apt-get install git curl python3 logrotate openssh-client)"
fi

# --- 2. user ----------------------------------------------------------------------------
if id -u "$USER_NAME" >/dev/null 2>&1; then
  say "user $USER_NAME exists"
else
  say "creating system user $USER_NAME (home $HOME_DIR)"
  useradd --system --user-group --home-dir "$HOME_DIR" --create-home \
    --shell /usr/sbin/nologin --comment "camsocs harvest runner" "$USER_NAME"
fi
install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR" "$LOG_DIR"
install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"

# --- 3. pixi ----------------------------------------------------------------------------
if [[ -x /usr/local/bin/pixi ]] && [[ "$(/usr/local/bin/pixi --version 2>/dev/null)" == "pixi $PIXI_VERSION" ]]; then
  say "pixi $PIXI_VERSION is installed"
else
  say "installing pixi $PIXI_VERSION from $PIXI_URL"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$WORK/$PIXI_ASSET" "$PIXI_URL"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$WORK/$PIXI_ASSET.sha256" "$PIXI_URL.sha256"
  (cd "$WORK" && sha256sum --check --strict --quiet "$PIXI_ASSET.sha256") ||
    die "pixi archive does not match the release's checksum file"
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

# --- 4. deploy key and github.com's host key ----------------------------------------------
if [[ -n "$DEPLOY_KEY" ]]; then
  [[ -r "$DEPLOY_KEY" ]] || die "cannot read $DEPLOY_KEY"
  ssh-keygen -y -P '' -f "$DEPLOY_KEY" >/dev/null 2>&1 ||
    die "$DEPLOY_KEY is not a private key without a passphrase"
  if [[ -f "$KEY_PATH" ]] && cmp -s "$DEPLOY_KEY" "$KEY_PATH"; then
    say "deploy key is installed"
  else
    say "installing the deploy key → $KEY_PATH"
    install -m 0600 -o "$USER_NAME" -g "$USER_NAME" "$DEPLOY_KEY" "$KEY_PATH"
  fi
elif [[ ! -f "$KEY_PATH" ]]; then
  die "no deploy key yet: pass --deploy-key FILE (read-only deploy key of joshua-e-fehn/camsocs)"
fi

if [[ -f "$KNOWN_HOSTS" ]] && ssh-keygen -lf "$KNOWN_HOSTS" 2>/dev/null | grep -qF "$GITHUB_ED25519"; then
  say "github.com host key is known"
else
  say "checking github.com's host key against $GITHUB_ED25519"
  ssh-keyscan -t ed25519 github.com >"$WORK/github" 2>/dev/null || die "ssh-keyscan github.com failed"
  ssh-keygen -lf "$WORK/github" | grep -qF "$GITHUB_ED25519" ||
    die "github.com offered a host key that is not GitHub's published one"
  install -m 0644 -o "$USER_NAME" -g "$USER_NAME" "$WORK/github" "$KNOWN_HOSTS"
fi

# --- 5. checkout ------------------------------------------------------------------------
if [[ -d "$ROOT/.git" ]]; then
  say "checkout $ROOT exists (each run pulls it)"
  remote="$(as_camsocs git -C "$ROOT" remote get-url origin)"
  [[ "$remote" == "$REPO_URL" ]] || warn "$ROOT's origin is $remote, not $REPO_URL"
else
  say "cloning $REPO_URL ($BRANCH) → $ROOT"
  install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$ROOT"
  as_camsocs env GIT_SSH_COMMAND="$SSH_COMMAND" git clone --quiet --branch "$BRANCH" "$REPO_URL" "$ROOT"
fi
as_camsocs git -C "$ROOT" config core.sshCommand "$SSH_COMMAND"
install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$ROOT/var"

# --- 6. env files -----------------------------------------------------------------------
install_env() {
  local from="$1" to="$2"
  [[ -r "$from" ]] || die "cannot read $from"
  if [[ -f "$to" ]] && cmp -s "$from" "$to"; then
    say "$to is up to date"
  else
    say "installing $to (0600, $USER_NAME)"
    install -m 0600 -o "$USER_NAME" -g "$USER_NAME" "$from" "$to"
  fi
}
[[ -z "$PIPELINE_ENV" ]] || install_env "$PIPELINE_ENV" "$ROOT/pipeline/.env"
[[ -z "$PROD_ENV" ]] || install_env "$PROD_ENV" "$ROOT/pipeline/.env.prod"

# Names only: no value is ever printed.
if [[ -f "$ROOT/pipeline/.env" ]]; then
  grep -q '^LLM_BASE_URL=http://127\.0\.0\.1:8317/v1/\{0,1\}$' "$ROOT/pipeline/.env" ||
    warn "pipeline/.env: LLM_BASE_URL is not http://127.0.0.1:8317/v1 (the host's cliproxy, D5)"
  for name in LLM_API_KEY LLM_MODEL_BULK LLM_MODEL_STRONG CAMSOCS_USER_AGENT; do
    grep -q "^$name=." "$ROOT/pipeline/.env" || warn "pipeline/.env: $name is not set"
  done
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
else
  warn "no $ROOT/pipeline/.env.prod yet: runs fail until --prod-env installs it"
fi
[[ -f "$MYA_ENV" ]] || warn "$MYA_ENV is missing: failure alerts cannot be sent"

# --- 7. logs ----------------------------------------------------------------------------
install -m 0644 -o root -g root "$ROOT/ops/vps/logrotate/camsocs" /etc/logrotate.d/camsocs

# --- 8. systemd -------------------------------------------------------------------------
say "installing systemd units"
for unit in "$ROOT"/ops/vps/systemd/*; do
  install -m 0644 -o root -g root "$unit" "$UNIT_DIR/$(basename "$unit")"
done
systemctl daemon-reload
if [[ $ENABLE -eq 1 ]]; then
  systemctl enable --now "${TIMERS[@]}"
  say "timers enabled"
else
  say "timers left off (--no-enable): systemctl enable --now ${TIMERS[*]}"
fi

# --- 9. environment ---------------------------------------------------------------------
say "pixi install --locked (as $USER_NAME)"
as_camsocs pixi install --locked --manifest-path "$ROOT/pixi.toml"

say "done. Next: systemctl start --no-block camsocs-harvest@full.service; journalctl -fu camsocs-harvest@full"
systemctl list-timers --all 'camsocs-*' --no-pager || true
