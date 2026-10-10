# The VPS runner (decision D5)

The scheduled harvests run on the VPS host (`srv1608974`, Ubuntu 24.04, systemd) under their own systemd timers, as a dedicated `camsocs` user, from a checkout in `/opt/camsocs`. They do **not** run inside Mya's Hermes container: that container is not reproducible, and production write keys must not sit next to an LLM agent that browses the web (PLAN.md decision D5, 2026-10-10). LLM calls go to cliproxy on the host's loopback with a camsocs key of their own; a failed run sends a Slack DM through Mya's bot.

Everything here lives in `ops/vps/` and is installed by Joshua's operator; nothing in this repo deploys it. Until it is installed, production is harvested by hand from the laptop (docs/deploy.md §4).

**Secrets.** Never paste a value into a chat, a commit or a log. On the host each secret lives in exactly one file: `pipeline/.env` (LLM key, Camdram, Meta), `pipeline/.env.prod` (production's `PIPELINE_API_KEY`), both `0600` and owned by `camsocs`; the deploy key in `/var/lib/camsocs/.ssh/`; the Slack token stays in Mya's env file and is only read at alert time.

## 1. Architecture

```
VPS host srv1608974 (systemd)
├─ camsocs-harvest-events.timer   daily 04:30 Europe/London ─┐
├─ camsocs-harvest-full.timer     Sunday 02:00 Europe/London ┤
│                                                            ▼
│  camsocs-harvest@<group>.service   user camsocs, /opt/camsocs, sandboxed
│    camsocs-harvest.sh <group>
│      lock → git pull --ff-only → pixi install --locked
│      → timeout 2h|6h pixi run pipeline -- --env prod sync --group <group>
│      → prune-cache (full) → /var/lib/camsocs/status.json
│        ├─► public sources (polite fetcher, robots.txt / D3)
│        ├─► cliproxy http://127.0.0.1:8317/v1 (camsocs key) ─► Codex models
│        └─► Convex production /api/pipeline/* (cheerful-bandicoot-511)
│    OnFailure= ─► camsocs-alert@<group>.service ─► Slack DM (Mya's bot)
└─ Docker: Mya's Hermes container, cliproxy, … — never touched by the runner
```

| What | Where |
|---|---|
| Checkout (main, read-only deploy key) | `/opt/camsocs` (owned by `camsocs`; `var/` holds cache, staging, state, reports) |
| Run state of production | `/opt/camsocs/.camsocs-state.prod.json` |
| User home, deploy key, pixi cache | `/var/lib/camsocs` (`.ssh/camsocs_deploy`, `.ssh/known_hosts`, `.cache/rattler`) |
| Status, lock, pin, last good commit | `/var/lib/camsocs/status.json`, `status-<group>.json`, `run-<group>.json`, `harvest.lock`, `pin`, `last-good-commit` |
| Logs | `/var/log/camsocs/<London date>-<group>.log`, removed after 90 days (`/etc/logrotate.d/camsocs`); the script's own lines also in the journal |
| Units | `/etc/systemd/system/camsocs-harvest@.service`, `camsocs-alert@.service`, `camsocs-harvest-events.timer`, `camsocs-harvest-full.timer` |
| pixi | `/usr/local/bin/pixi` (0.73.0, the version CI pins) |

### The two groups

`camsocs sync --group <name>` runs one entry of `stages.GROUPS` (`pipeline/src/camsocs_pipeline/stages/__init__.py`, which also tabulates what each daily stage reads):

- **events, daily at 04:30.** `term_dates`, `camdram_events`, `talks_cam`, `cucbc_events`, `playwaze`, `calendar_feeds`, `su_whatson`, `website_events`, `inbox`, `instagram`, `termcards`, then `load` and `report`. It harvests no organisation, so it reads what the last full run staged: the resolver's `_resolved`, enrichment's `society_website` (feeds, talks lists, events pages, termcards, handles) and the SU profiles (`su_profile` and their cached pages). If any of these was never staged it stops before any request ("run `camsocs sync --group full` first") — it would otherwise stage nothing and succeed. Older than eight days (the weekly run failed), they still serve, and the run carries a warning (in the run log on Convex and the status file). `load` posts the latest file of every staging directory; the full run's observations re-posted are no-ops on the server, and each claim's sighting stays the `retrievedAt` it carries. `pixi run harvest-events` locally.
- **full, Sundays at 02:00.** Every stage in registry order, then the server's re-derivation (`pixi run harvest` = `sync --group full`), then `prune-cache` (retention R7). 02:00 exists exactly once on both clock-change Sundays.

One run at a time (`flock` on `/var/lib/camsocs/harvest.lock`; per-host politeness holds only inside one process). A daily tick that finds the lock held skips (exit 0, no status: the weekly run covers every events source); the weekly run waits up to 3 hours for it, so a catch-up after downtime (`Persistent=true` starts both missed timers at boot) never costs the weekly run. Limits: 2 hours for events, 6 hours for full (`timeout`, then a kill 10 minutes later); the unit's own `TimeoutStartSec=10h` is a backstop.

**One production runner.** Once the timers are on, production is harvested only from the VPS. Do not run `--env prod sync` on the laptop at the same time: the lock is per host, and two harvesters double the request rate on every site.

### Exit codes (status file, journal, alert)

| Code | Meaning | `phase` |
|---|---|---|
| 0 | ok | `done` |
| 1 | a stage failed (the stages that succeeded kept their work), or a run-level error such as missing inputs or a rejected key | `pipeline` |
| 2 | a usage error inside the pipeline | `pipeline` |
| 10 | `git pull` / the pinned checkout failed; the checkout stays where it was | `update` |
| 11 | `pixi install --locked` failed; the checkout went back to the previous commit | `install` |
| 12 | the run was fine, `prune-cache` failed (retention R7 not applied) | `prune` |
| 124 / 137 | the run hit its time limit / had to be killed | `pipeline` |
| 143 | systemd stopped it (`systemctl stop`, shutdown) | `stopped` |
| 64 | the script was called without exactly one known group | — |

## 2. Install (first time)

All on Joshua's side; Claude does not ssh to the host. Commands marked *laptop* run in the repo on the laptop, the rest on the host as root.

1. **cliproxy key** — make the change in §8, so the camsocs key works before the first run.
2. **Deploy key** (*laptop*): `ssh-keygen -t ed25519 -N '' -C camsocs-vps-deploy -f ~/camsocs_deploy`. GitHub → `joshua-e-fehn/camsocs` → Settings → Deploy keys → Add: paste `~/camsocs_deploy.pub`, **Allow write access off**.
3. **Env files** (*laptop*), never committed:
   - `vps.env` → becomes `pipeline/.env` on the host: `LLM_BASE_URL=http://127.0.0.1:8317/v1`, `LLM_API_KEY=<the camsocs cliproxy key>`, `LLM_MODEL_BULK=gpt-6-luna`, `LLM_MODEL_STRONG=gpt-6.1-sol`, `CAMSOCS_USER_AGENT=camsocs-bot/0.1 (+https://camsocs.vercel.app/about)`, and, if used, `CAMDRAM_API_KEY`, `META_IG_USER_ID`, `META_ACCESS_TOKEN`. No `CONVEX_*` and no `PIPELINE_API_KEY`: the host never targets dev.
   - the laptop's `pipeline/.env.prod` (production's `CONVEX_HTTP_URL` and `PIPELINE_API_KEY`), as is.
4. **Copy** (*laptop*, over Tailscale): `ssh mya-ts 'install -d -m 700 /root/camsocs-setup'` then `scp ops/vps/install.sh ~/camsocs_deploy vps.env pipeline/.env.prod mya-ts:/root/camsocs-setup/`.
5. **Install, timers off:**

   ```bash
   cd /root/camsocs-setup
   bash install.sh --deploy-key camsocs_deploy --pipeline-env vps.env --prod-env .env.prod --no-enable
   ```

   It creates the user, installs pixi 0.73.0 (checksum-verified), the key and GitHub's verified host key, clones main to `/opt/camsocs`, installs the env files (`0600`), logrotate and the units, and warms the pixi environment. Its warnings name what is missing; it prints no secret. Then `shred -u /root/camsocs-setup/*`.
6. **Seed the cache (recommended).** A host with an empty `var/` re-fetches every page and asks the model again for every text the laptop's cache already answered, which can take longer than the 6-hour limit. Copy the laptop's (*laptop*): `rsync -a var/cache var/staging var/state mya-ts:/opt/camsocs/var/` and, if the laptop has harvested production, `scp .camsocs-state.prod.json mya-ts:/opt/camsocs/` (Instagram rotation, inbox lists); then on the host `chown -R camsocs:camsocs /opt/camsocs/var` (and the state file, if copied). (Same data, same retention: R7's 90 days count from each file's own date.)
7. **First full run, by hand:** `systemctl start --no-block camsocs-harvest@full.service`, follow with `journalctl -fu camsocs-harvest@full` and `tail -f /var/log/camsocs/$(TZ=Europe/London date +%F)-full.log`. Without step 6, run it outside the time limit once instead: `sudo -u camsocs CAMSOCS_TIMEOUT_FULL=12h /opt/camsocs/ops/vps/camsocs-harvest.sh full` (no sandbox and no alert for this one run).
8. **Check:** `python3 -m json.tool /var/lib/camsocs/status-full.json` (`"result": "ok"`, coverage numbers), the coverage report in `/opt/camsocs/var/reports/`, and the broker overview's run list (`sync --group full`).
9. **Checks that need the host** (not runnable on the laptop, which has no systemd):

   ```bash
   systemd-analyze verify /etc/systemd/system/camsocs-harvest@.service /etc/systemd/system/camsocs-alert@.service /etc/systemd/system/camsocs-harvest-*.timer
   systemd-analyze security camsocs-harvest@events.service
   systemd-analyze calendar '*-*-* 04:30:00 Europe/London' 'Sun *-*-* 02:00:00 Europe/London'
   logrotate -d /etc/logrotate.d/camsocs
   ```

10. **Alerts:** §6 "Testing".
11. **Timers on:** `bash /opt/camsocs/ops/vps/install.sh` (no arguments: everything is already in place, so it only enables the timers), then `systemctl list-timers 'camsocs-*'`.

## 3. Upgrade

- **Code** upgrades itself: each run pulls main (`--ff-only`) and runs `pixi install --locked` before the pipeline, so a merge to main reaches the next run. A push that breaks the lock file fails that run at `install` (exit 11) and leaves the previous commit checked out.
- **Units, logrotate config, pixi version:** they are installed from the checkout, so after a run has pulled the change, `bash /opt/camsocs/ops/vps/install.sh` (idempotent: it rewrites the units, reloads systemd, and changes nothing else).
- **A new pixi:** bump `PIXI_VERSION` and `PIXI_SHA256` in `ops/vps/install.sh` (the hash from the release's own `pixi-x86_64-unknown-linux-musl.tar.gz.sha256`) together with CI's `pixi-version`.

## 4. Rollback

- **Pin a commit:** `echo <commit> | sudo -u camsocs tee /var/lib/camsocs/pin`. The next run fetches and checks out that commit (detached) instead of pulling main. `/var/lib/camsocs/last-good-commit` is the last commit whose run ended with exit 0. `rm /var/lib/camsocs/pin` follows main again from the next run.
- **Data:** every pipeline write is an upsert of claims; the next good run repairs what a bad one wrote. Function and site rollbacks are docs/deploy.md §6.
- **Stop:** `systemctl disable --now camsocs-harvest-events.timer camsocs-harvest-full.timer`; a run in progress: `systemctl stop camsocs-harvest@full.service` (recorded as `stopped`, exit 143, which alerts).
- **Uninstall:** stop as above, then `rm /etc/systemd/system/camsocs-* /etc/logrotate.d/camsocs && systemctl daemon-reload`; `userdel camsocs`; `rm -rf /opt/camsocs /var/lib/camsocs /var/log/camsocs` (the cache and logs go with it); remove the deploy key in GitHub and the camsocs key from cliproxy.

## 5. Running by hand

- **A scheduled run now**, with the same sandbox, status file and alert: `systemctl start camsocs-harvest@events.service` (blocks until it ends; `--no-block` to return at once).
- **Anything else** runs as `camsocs` in the checkout; keep the lock in mind (a manual run next to a scheduled one doubles the request rate):

  ```bash
  sudo -u camsocs -H bash -lc 'cd /opt/camsocs && pixi run pipeline -- --env prod status'
  sudo -u camsocs -H bash -lc 'cd /opt/camsocs && flock -n /var/lib/camsocs/harvest.lock pixi run pipeline -- --env prod sync --stages calendar_feeds,load'
  sudo -u camsocs -H bash -lc 'cd /opt/camsocs && pixi run harvest-events -- --env prod --dry-run'
  ```

  A dry run writes nothing to Convex, but the events stages still read the network and stage locally.

## 6. Status, logs and alerts

- **Timers and units:** `systemctl list-timers 'camsocs-*'`, `systemctl status camsocs-harvest@events`, `journalctl -u 'camsocs-harvest@*' --since today` (the script's own lines and systemd's), `journalctl -u 'camsocs-alert@*'`.
- **Status file:** `/var/lib/camsocs/status.json` is the latest run of either group, `status-<group>.json` each group's latest; both are rewritten whole on every exit after the lock (a skipped tick leaves them alone).

  | Field | |
  |---|---|
  | `group`, `environment` | `events` / `full`, `prod` |
  | `startedAt`, `finishedAt` | UTC |
  | `exitCode`, `result`, `phase` | §1 table; `result` is `ok`, `failed`, `timed_out` or `stopped` |
  | `commit`, `invocationId`, `logFile` | the checkout's commit, systemd's invocation id, the run's log |
  | `runKey`, `summary`, `failedStages`, `warnings`, `error` | from the pipeline's `--summary-json` (`run-<group>.json`): one line per stage, e.g. `calendar_feeds: 219 new, 0 updated, 0 unchanged, 0 skipped` |
  | `coverage` | `{listed, counterparts, upcomingEvents, report}` from the `report` stage; `null` when it did not run |

- **Logs:** `/var/log/camsocs/<London date>-<group>.log` holds the whole run (git, pixi, the pipeline's log and report). Removed after 90 days by logrotate (`minage 90`, `rotate 0`: dated files are never renamed).
- **Coverage:** `/opt/camsocs/var/reports/coverage-<date>.md`, and the broker overview.

### Alerts

`camsocs-harvest@<group>.service` has `OnFailure=camsocs-alert@<group>.service`: any non-zero exit, a timeout or a kill starts `/opt/camsocs/ops/vps/camsocs-alert.py <group>` (standard library only, the host's `python3`), modelled on `mya-backup`'s `send_alert`:

- **Credentials.** The alert unit has `LoadCredential=slack-env:/docker/hermes-agent-vspa/data/.env`: systemd (root) reads Mya's env file and hands the unit a read-only copy that only it can read, while it runs; the file itself stays root's and the harvest cannot reach `/docker` at all. `CAMSOCS_ALERT_ENV=%d/slack-env` points the script there; it keeps `SLACK_BOT_TOKEN`, `SLACK_HOME_CHANNEL` and `SLACK_ALLOWED_USERS` and ignores the rest.
- **Destination.** `SLACK_HOME_CHANNEL` when set; otherwise the first user in `SLACK_ALLOWED_USERS`, whose DM `conversations.open` opens; then `chat.postMessage` (Slack Web API, Bearer token).
- **Message.** Group, exit status and how the unit ended (systemd's `MONITOR_SERVICE_RESULT` / `MONITOR_EXIT_CODE` / `MONITOR_EXIT_STATUS`), the failed phase, commit, run key and failed stages from the status file (only if that file is this run's: its `invocationId` must match `MONITOR_INVOCATION_ID`), and the last 20 log lines. Everything key- or token-like is masked: Slack, OpenAI-style, GitHub and Google keys, `Bearer …`, `NAME=value` for names with KEY / TOKEN / SECRET / PASSWORD / AUTH, credentials in URLs, secret-looking query parameters, long opaque strings, and the literal values of such keys in `pipeline/.env` and `pipeline/.env.prod` (`CAMSOCS_SECRET_FILES`).
- **Not alerted:** a skipped tick, and a run's warnings (stale inputs) — those are in the status file and the run log.
- **Testing.** Print the message without sending (no credential needed): `sudo -u camsocs CAMSOCS_SECRET_FILES=/opt/camsocs/pipeline/.env:/opt/camsocs/pipeline/.env.prod python3 -I /opt/camsocs/ops/vps/camsocs-alert.py --dry-run events`. Send a real DM: `systemctl start camsocs-alert@events.service` (it reports the last events run as failed; say so in Slack if anyone else reads the channel). If nothing arrives: `journalctl -u camsocs-alert@events` shows Slack's error code (`not_in_channel`, `missing_scope` — `conversations.open` needs `im:write`, posting needs `chat:write`) and never the token.

## 7. Rotating keys

Do it outside the run windows (not 02:00–08:00 on Sundays, not 04:30–06:30 daily) or with the timers stopped; a run between the two halves fails with 401 and alerts.

- **Production `PIPELINE_API_KEY`:** `openssl rand -hex 32`; *laptop*: `cd webapp && unset CONVEX_DEPLOY_KEY && bunx convex env set --prod PIPELINE_API_KEY` (prompts for the value); on the host `sudoedit /opt/camsocs/pipeline/.env.prod` (it stays `0600 camsocs`); then `sudo -u camsocs -H bash -lc 'cd /opt/camsocs && pixi run pipeline -- --env prod health'`; update the laptop's `pipeline/.env.prod` too.
- **The camsocs cliproxy key:** add the new key to cliproxy's client keys (§8), restart it, change `LLM_API_KEY` in `/opt/camsocs/pipeline/.env`, check with `pixi run pipeline -- --env prod status` (shows `LLM key: set`) and a manual `sync --stages website_events --limit 1`, then remove the old key from cliproxy.
- **The deploy key:** a new pair (§2 step 2), add it in GitHub, `bash /opt/camsocs/ops/vps/install.sh --deploy-key <new private key>`, check `sudo -u camsocs git -C /opt/camsocs fetch`, delete the old key in GitHub.
- **Slack:** the bot token is Mya's and is read at each alert; rotating it in Mya's env file needs nothing here.
- **Meta token** (about every 60 days) and **Camdram key:** in `/opt/camsocs/pipeline/.env`.

## 8. The cliproxy change (operator)

The runner calls cliproxy on the host's loopback, `http://127.0.0.1:8317/v1`, with a client key of its own, so it can be revoked without touching Mya's. Codex models only (`extract/llm.py` refuses any `claude*` / `anthropic*` model id).

1. Generate the key: `openssl rand -hex 32`.
2. In cliproxy's `config.yaml` (its compose directory under `/docker/`), add it as a second **client** key. Current CLIProxyAPI (config v8) lists them under `access.api-keys`; older files have a top-level `api-keys:` — use the layout the file already has:

   ```yaml
   access:
     api-keys:
       - "<Mya's existing key>"
       - "<the camsocs key>"   # camsocs VPS runner (D5)
   ```

   Not under the upstream provider keys (`api-keys:` with `gemini:` / `claude:` groups in v8): those are cliproxy's own credentials.
3. Restart cliproxy the way its compose stack does (`docker compose restart <its service>` in its directory). The runner's installer never does this.
4. Check that 8317 listens on the host's loopback: `ss -ltnp 'sport = :8317'`. If the container is reachable only through traefik, publish it to loopback only (`ports: ["127.0.0.1:8317:8317"]` on its compose service), never on a public address.
5. Check the key without putting it in the shell history: `read -rs KEY; curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8317/v1/models | head -c 300; unset KEY` lists `gpt-6-luna` and `gpt-6.1-sol`.
6. In `/opt/camsocs/pipeline/.env`: `LLM_BASE_URL=http://127.0.0.1:8317/v1` and `LLM_API_KEY=<the camsocs key>`.

## 9. What the runner never does

- touch Docker, Mya's container, her data (`/docker` is inaccessible to the harvest unit) or cliproxy's configuration;
- deploy anything: no `vercel`, no `convex deploy`; it only posts to `/api/pipeline/*` with production's pipeline key;
- target the dev deployment (the host has no dev key);
- run as root: the units run as `camsocs` with `NoNewPrivileges`, `ProtectSystem=strict` (writable: `/opt/camsocs` — the run's own `git pull` and `pixi install` write the checkout — `/var/lib/camsocs`, `/var/log/camsocs`), `ProtectHome`, `PrivateTmp`, `PrivateDevices` and an empty capability set.
