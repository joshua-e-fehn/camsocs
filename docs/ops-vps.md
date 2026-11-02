# The VPS runner (decision D5)

The scheduled harvests run on the VPS host (`srv1608974`, Ubuntu 24.04, systemd) under their own systemd timers, as a dedicated `camsocs` user, from a checkout in `/opt/camsocs`. They do **not** run inside Mya's Hermes container: that container is not reproducible, and production write keys must not sit next to an LLM agent that browses the web (PLAN.md decision D5, 2026-10-10). LLM calls go to cliproxy on the host's loopback with a camsocs key of their own; a failed run sends a Slack DM through Mya's bot.

Everything here lives in `ops/vps/` and is installed by Joshua's operator; nothing in this repo deploys it. Until it is installed, production is harvested by hand from the laptop (docs/deploy.md §4).

**Secrets.** Never paste a value into a chat, a commit or a log. On the host each secret lives in one place: `pipeline/.env` (LLM key, Camdram, Meta), `pipeline/.env.prod` (production's `PIPELINE_API_KEY`, the PostHog project token for run telemetry, and the PostHog personal API key the hourly monitor queries with), both `0600` and owned by `camsocs`; the deploy key in `/var/lib/camsocs/.ssh/` (the harvest's) and `/etc/camsocs/deploy_key` (root's, for the installer's mirror); the three Slack values the alert needs in `/etc/camsocs/alert.env` (`0600` root), copied from Mya's env file by the installer — nothing else of that file leaves it.

**Who runs what (review 2026-10-10).** Root runs only code it installed itself from a commit the operator reviewed: `install.sh` fetches that commit into root's own mirror (`/var/lib/camsocs-ops/camsocs.git`) and installs the runner's scripts root-owned in `/usr/local/lib/camsocs-ops/` and the units and logrotate config from there. Nothing root runs or installs ever comes from `/opt/camsocs`, which the harvest writes (its own `git pull`, `pixi install`, `var/`). The harvest unit runs the root-owned `camsocs-harvest.sh` as `camsocs`; the pipeline it starts is the checkout's (main, pulled each run). The alert runs as a user of its own (`DynamicUser`), never as `camsocs`.

## 1. Architecture

```
VPS host srv1608974 (systemd)
├─ camsocs-harvest-events.timer   daily 04:30 Europe/London ─┐
├─ camsocs-harvest-full.timer     Sunday 02:00 Europe/London ┤
│                                                            ▼
│  camsocs-harvest@<group>.service   user camsocs, /opt/camsocs, sandboxed
│    /usr/local/lib/camsocs-ops/camsocs-harvest.sh <group>   (root-owned)
│      lock → git pull --ff-only (15 min) → pixi install --locked (30 min)
│      → timeout 2h|6h pixi run pipeline -- --env prod sync --group <group>
│      → prune-cache → /var/lib/camsocs/status.json
│        ├─► public sources (polite fetcher, robots.txt / D3; public addresses only)
│        ├─► cliproxy http://127.0.0.1:8317/v1 (camsocs key) ─► Codex models
│        └─► Convex production /api/pipeline/* (cheerful-bandicoot-511)
│    OnFailure= ─► camsocs-alert@<group>.service (DynamicUser, /etc/camsocs/alert.env)
│                    ─► Slack DM (Mya's bot): structured facts only
├─ camsocs-monitor.timer          hourly (+ up to 15 min)
│  camsocs-monitor.service   user camsocs, /opt/camsocs read-only, sandboxed
│    pixi run --as-is pipeline -- --env prod monitor → /var/lib/camsocs/status-monitor.json
│      └─► PostHog EU query API (four HogQL counts, personal key, §6 "Monitor")
│    OnFailure= ─► camsocs-alert@monitor.service ─► Slack DM: failing checks' numbers
└─ Docker: Mya's Hermes container, cliproxy, … — never touched by the runner
```

| What | Where |
|---|---|
| Checkout (main, read-only deploy key) | `/opt/camsocs` (owned by `camsocs`; `var/` holds cache, staging, state, reports). Root never runs or installs anything from it |
| The runner (root-owned, from the reviewed commit in `REVISION`) | `/usr/local/lib/camsocs-ops/`: `camsocs-harvest.sh`, `camsocs-alert.py`, `camsocs-status.py`, `install.sh`, `REVISION` |
| Root's keys and the alert's Slack values | `/etc/camsocs/` (`0750` root): `deploy_key`, `known_hosts`, `alert.env` (`0600`) |
| Root's mirror of the repository | `/var/lib/camsocs-ops/camsocs.git` (`0700` root) |
| Run state of production | `/opt/camsocs/.camsocs-state.prod.json` |
| User home, deploy key, pixi cache | `/var/lib/camsocs` (`.ssh/camsocs_deploy`, `.ssh/known_hosts`, `.cache/rattler`) |
| Status, lock, pin, last good commit | `/var/lib/camsocs/status.json`, `status-<group>.json`, `run-<group>.json`, `harvest.lock`, `pin`, `last-good-commit`; the monitor's `status-monitor.json` |
| Logs | `/var/log/camsocs/<London date>-<group>.log`, removed after 90 days (`/etc/logrotate.d/camsocs`); the script's own lines also in the journal |
| Units | `/etc/systemd/system/camsocs-harvest@.service`, `camsocs-alert@.service`, `camsocs-harvest-events.timer`, `camsocs-harvest-full.timer`, `camsocs-monitor.service`, `camsocs-monitor.timer` |
| pixi | `/usr/local/bin/pixi` (0.73.0, the version CI pins) |

### The two groups

`camsocs sync --group <name>` runs one entry of `stages.GROUPS` (`pipeline/src/camsocs_pipeline/stages/__init__.py`, which also tabulates what each daily stage reads):

- **events, daily at 04:30.** `term_dates`, `camdram_events`, `talks_cam`, `cucbc_events`, `playwaze`, `uni_events` (the University's events programme, read with recorded permission: about five requests to webservices.admin.cam.ac.uk, source-research §10), `calendar_feeds`, `su_whatson`, `website_events`, `inbox`, `instagram`, `termcards`, then `load`, `talks` and `report`. `talks` is the talks pillar (decision D7, `pipeline/.../talks/stage.py`): the talks.cam API (at least 10 s between requests, at most 120 pages and 30 minutes a run, `talks/talkscam.py`), then the ~111 sources of the department registry (robots.txt always holds; 20 minutes of wall time for all of them, a source not started by then is skipped), posted straight to `/api/pipeline/talks/*` rather than through `load`. It runs after `load`, so a slow talks.cam day never holds back the day's events. So talks.cam is read twice a run, one stage after the other and never at once: `talks_cam` for the society lists, `talks` for the academic talks. Expect the daily run to take up to about 50 minutes longer than before (30 + 20 minutes at most); it stays inside the 2-hour limit. `--group talks` runs that stage alone. It harvests no organisation, so it reads what the last full run staged: the resolver's `_resolved`, enrichment's `society_website` (feeds, talks lists, events pages, termcards, handles) and the SU profiles (`su_profile` and their cached pages). If any of these was never staged it stops before any request ("run `camsocs sync --group full` first") — it would otherwise stage nothing and succeed. Older than eight days (the weekly run failed), they still serve, and the run carries a warning (in the run log on Convex and the status file). `load` posts the latest file of every staging directory; the full run's observations re-posted are no-ops on the server, and each claim's sighting stays the `retrievedAt` it carries. `pixi run harvest-events` locally.
- **full, Sundays at 02:00.** Every stage in registry order, then the server's re-derivation (`pixi run harvest` = `sync --group full`), then `prune-cache` (retention R7, as after the daily run). 02:00 exists exactly once on both clock-change Sundays.

One run at a time (`flock` on `/var/lib/camsocs/harvest.lock`; per-host politeness holds only inside one process). A daily tick that finds the lock held skips (exit 0, no status: the weekly run covers every events source); the weekly run waits up to 3 hours for it, so a catch-up after downtime (`Persistent=true` starts both missed timers at boot) never costs the weekly run — and if it still cannot have the lock it fails (exit 75, phase `lock`, status written) and alerts, so the weekly run is never lost in silence. Limits: 2 hours for events, 6 hours for full (`timeout`, then a kill 10 minutes later); each git command 15 minutes and `pixi install` 30 (`CAMSOCS_TIMEOUT_UPDATE` / `CAMSOCS_TIMEOUT_INSTALL`; ssh also gives up on a dead connection: `ConnectTimeout`, `ServerAliveInterval`); the unit's own `TimeoutStartSec=10h` is a backstop. `prune-cache` runs after every run, daily too (R7 at 90 days, R4 at 30 for what quotes list mail).

**One production runner.** Once the timers are on, production is harvested only from the VPS. Do not run `--env prod sync` on the laptop at the same time: the lock is per host, and two harvesters double the request rate on every site.

### Exit codes (status file, journal, alert)

| Code | Meaning | `phase` |
|---|---|---|
| 0 | ok | `done` |
| 1 | a stage failed (the stages that succeeded kept their work), or a run-level error such as missing inputs or a rejected key | `pipeline` |
| 2 | a usage error inside the pipeline | `pipeline` |
| 10 | `git pull` / the pinned checkout failed or took over 15 minutes; the checkout stays where it was | `update` |
| 11 | `pixi install --locked` failed or took over 30 minutes; the checkout went back to the previous commit | `install` |
| 12 | the run was fine, `prune-cache` failed (retention R7 / R4 not applied) | `prune` |
| 75 | the weekly run waited 3 hours and never had the lock (nothing ran) | `lock` |
| 124 / 137 | the run hit its time limit / had to be killed | `pipeline` |
| 143 | systemd stopped it (`systemctl stop`, shutdown) | `stopped` |
| 64 | the script was called without exactly one known group | — |

## 2. Install (first time)

All on Joshua's side; Claude does not ssh to the host. Commands marked *laptop* run in the repo on the laptop, the rest on the host as root.

1. **cliproxy key** — make the change in §8, so the camsocs key works before the first run.
2. **Deploy key** (*laptop*): `ssh-keygen -t ed25519 -N '' -C camsocs-vps-deploy -f ~/camsocs_deploy`. GitHub → `joshua-e-fehn/camsocs` → Settings → Deploy keys → Add: paste `~/camsocs_deploy.pub`, **Allow write access off**.
3. **Env files** (*laptop*), never committed:
   - `vps.env` → becomes `pipeline/.env` on the host: `LLM_BASE_URL=http://127.0.0.1:8317/v1`, `LLM_API_KEY=<the camsocs cliproxy key>`, `LLM_MODEL_BULK=gpt-6-luna`, `LLM_MODEL_STRONG=gpt-6.1-sol`, `CAMSOCS_USER_AGENT=camsocs-bot/0.1 (+https://camsocs.uk/about)`, and, if used, `CAMDRAM_API_KEY`, `META_IG_USER_ID`, `META_ACCESS_TOKEN`. No `CONVEX_*` and no `PIPELINE_API_KEY`: the host never targets dev.
   - the laptop's `pipeline/.env.prod` (production's `CONVEX_HTTP_URL` and `PIPELINE_API_KEY`), as is. For run telemetry (§6, optional) it also carries `POSTHOG_KEY=<the project token, phc_…>`, `POSTHOG_HOST=https://eu.i.posthog.com` and `POSTHOG_ENV=production` (1Password Mya vault, item `PostHog`); without `POSTHOG_KEY` the harvest sends nothing. For the hourly monitor (§6 "Monitor", optional) it also carries `POSTHOG_PERSONAL_API_KEY=<a personal API key, phx_…>` and `POSTHOG_PROJECT_ID=<the numeric project id>`; without them the monitor runs and checks nothing.
4. **The revision** (*laptop*): review `ops/vps/` at the commit of main to install (`git log -p origin/main -- ops/vps`), and note its full id: `git rev-parse origin/main`. Every install and upgrade names one; root installs the runner from nothing else.
5. **Copy** (*laptop*, over Tailscale): `ssh mya-ts 'install -d -m 700 /root/camsocs-setup'` then `scp ops/vps/install.sh ~/camsocs_deploy vps.env pipeline/.env.prod mya-ts:/root/camsocs-setup/` (`install.sh` from that commit).
6. **Install, timers off:**

   ```bash
   cd /root/camsocs-setup
   bash install.sh --revision <full commit id> --deploy-key camsocs_deploy \
     --pipeline-env vps.env --prod-env .env.prod --no-enable
   ```

   It creates the user, installs pixi 0.73.0 (checksum-verified), the deploy key for root and for `camsocs` and GitHub's verified host key, fetches main into root's mirror and checks that the revision is a commit on it (if that commit's own `install.sh` differs from the copy you ran, it runs that one instead), clones main to `/opt/camsocs` as `camsocs`, writes the env files as `camsocs` (`0600`), copies `SLACK_BOT_TOKEN`, `SLACK_HOME_CHANNEL` and `SLACK_ALLOWED_USERS` from Mya's env file into `/etc/camsocs/alert.env` (`0600` root), installs the revision's scripts root-owned in `/usr/local/lib/camsocs-ops/`, its logrotate config and units, and warms the pixi environment under the harvest lock. Its warnings name what is missing; it prints no secret. Then `shred -u /root/camsocs-setup/*`.
7. **Seed the cache (recommended).** A host with an empty `var/` re-fetches every page and asks the model again for every text the laptop's cache already answered, which can take longer than the 6-hour limit. Copy the laptop's (*laptop*): `rsync -a var/cache var/staging var/state mya-ts:/opt/camsocs/var/` and, if the laptop has harvested production, `scp .camsocs-state.prod.json mya-ts:/opt/camsocs/` (Instagram rotation, inbox lists); then on the host `chown -R camsocs:camsocs /opt/camsocs/var` (and the state file, if copied). (Same data, same retention: R7's 90 days count from each file's own date.)
8. **First full run, by hand:** `systemctl start --no-block camsocs-harvest@full.service`, follow with `journalctl -fu camsocs-harvest@full` and `tail -f /var/log/camsocs/$(TZ=Europe/London date +%F)-full.log`. Without step 7, run it outside the time limit once instead: `sudo -u camsocs CAMSOCS_TIMEOUT_FULL=12h /usr/local/lib/camsocs-ops/camsocs-harvest.sh full` (no sandbox and no alert for this one run).
9. **Check:** `python3 -m json.tool /var/lib/camsocs/status-full.json` (`"result": "ok"`, coverage numbers), the coverage report in `/opt/camsocs/var/reports/`, and the broker overview's run list (`sync --group full`).
10. **Checks that need the host** (not runnable on the laptop, which has no systemd):

    ```bash
    systemd-analyze verify /etc/systemd/system/camsocs-harvest@.service /etc/systemd/system/camsocs-alert@.service /etc/systemd/system/camsocs-harvest-*.timer /etc/systemd/system/camsocs-monitor.*
    systemd-analyze security camsocs-harvest@events.service camsocs-alert@events.service camsocs-monitor.service
    systemd-analyze calendar '*-*-* 04:30:00 Europe/London' 'Sun *-*-* 02:00:00 Europe/London' hourly
    logrotate -d /etc/logrotate.d/camsocs
    resolvectl status | head -5   # DNS through the loopback stub: the unit denies private ranges
    ```

    The harvest unit denies the private, CGNAT and link-local ranges (`IPAddressDeny`) and filters system calls (`SystemCallFilter=@system-service`, refused calls answer `EPERM`); if the first run fails on DNS or a refused call, the journal says which.
11. **Alerts:** §6 "Testing".
12. **Timers on:** `systemctl enable --now camsocs-harvest-events.timer camsocs-harvest-full.timer camsocs-monitor.timer`, then `systemctl list-timers 'camsocs-*'`. Run the monitor once by hand first (§6 "Monitor": `systemctl start camsocs-monitor.service`); until the first harvest has finished, `stale_harvest` fails and alerts.

## 3. Upgrade

- **Pipeline code** upgrades itself: each run pulls main (`--ff-only`) and runs `pixi install --locked` before the pipeline, so a merge to main reaches the next run. A push that breaks the lock file fails that run at `install` (exit 11) and leaves the previous commit checked out. The runner's own scripts and units are not part of that: a pull never changes them.
- **Pipeline code that needs new Convex functions** (the talks pillar's `talks/*` routes, for one): pushing to main does not deploy Convex, so deploy first (`cd webapp && vercel deploy --prod`, whose build runs `convex deploy`; docs/deploy.md), check the new routes answer, and only then merge to main. If main must move first, pin the current commit before the merge (`git rev-parse origin/main | sudo -u camsocs tee /var/lib/camsocs/pin`, §4) and remove the pin after the deploy. A talks stage that meets a deployment without its routes fails on its first post, before it crawls anything, and the run's other stages are unaffected.
- **The runner** (`ops/vps/`: scripts, units, logrotate config, pixi version): review the change on the laptop, then on the host, with the full id of the reviewed commit of main:

  ```bash
  bash /usr/local/lib/camsocs-ops/install.sh --revision <commit> --diff   # what would change
  bash /usr/local/lib/camsocs-ops/install.sh --revision <commit>          # install it
  ```

  The installed (root-owned) installer fetches the commit into root's mirror, checks it is on main, and installs from it (running that commit's own installer first if it changed). It changes only what differs, refreshes `alert.env`, leaves each timer enabled or disabled as you left it (`--enable` turns them on) except a timer the host never had, which it turns on unless `--no-enable` is given or both harvest timers are off (the monitor's, on the upgrade that adds it: put the monitor's key in `pipeline/.env.prod` first, §6 "Monitor"), and waits for a running harvest before it warms the pixi environment. It does not pull the checkout, so until the next harvest pulls main the monitor unit finds no `monitor.py` there and skips its runs quietly (`ConditionPathExists=`); to see it run at once, start a harvest (`systemctl start camsocs-harvest@events.service`) or wait for the 04:30 one. `cat /usr/local/lib/camsocs-ops/REVISION` is what is installed.
- **A new pixi:** bump `PIXI_VERSION` and `PIXI_SHA256` in `ops/vps/install.sh` (the hash from the release's own `pixi-x86_64-unknown-linux-musl.tar.gz.sha256`) together with CI's `pixi-version`, then upgrade the runner as above.

## 4. Rollback

- **Pin a commit:** `echo <commit> | sudo -u camsocs tee /var/lib/camsocs/pin`. The next run fetches and checks out that commit (detached) instead of pulling main. `/var/lib/camsocs/last-good-commit` is the last commit whose run ended with exit 0. `rm /var/lib/camsocs/pin` follows main again from the next run. (The runner itself: install an earlier reviewed commit with `install.sh --revision`.) A pinned commit from before ENG-10 has no `monitor` command: the monitor unit then skips each run quietly (`ConditionPathExists=` on `monitor.py`, shown as a skipped condition in `systemctl status camsocs-monitor`), so the checks stop while the pin holds; a runner installed from before ENG-10 has no monitor unit at all.
- **Data:** every pipeline write is an upsert of claims; the next good run repairs what a bad one wrote. Function and site rollbacks are docs/deploy.md §6.
- **Stop:** `systemctl disable --now camsocs-harvest-events.timer camsocs-harvest-full.timer` (and `camsocs-monitor.timer`, or the monitor alerts on the stale harvest); a run in progress: `systemctl stop camsocs-harvest@full.service` (recorded as `stopped`, exit 143, which alerts). Re-running the installer keeps them off, and while both harvest timers are off it does not turn on a timer the host never had (the monitor's) either.
- **Uninstall:** stop as above, then `rm /etc/systemd/system/camsocs-* /etc/logrotate.d/camsocs && systemctl daemon-reload`; `userdel camsocs`; `rm -rf /opt/camsocs /var/lib/camsocs /var/log/camsocs /usr/local/lib/camsocs-ops /var/lib/camsocs-ops /etc/camsocs` (the cache and logs go with it); remove the deploy key in GitHub and the camsocs key from cliproxy.

## 5. Running by hand

- **A scheduled run now**, with the same sandbox, status file and alert: `systemctl start camsocs-harvest@events.service` (blocks until it ends; `--no-block` to return at once).
- **Anything else** runs as `camsocs` in the checkout; keep the lock in mind (a manual run next to a scheduled one doubles the request rate):

  ```bash
  sudo -u camsocs -H bash -lc 'cd /opt/camsocs && pixi run pipeline -- --env prod status'
  sudo -u camsocs -H bash -lc 'cd /opt/camsocs && flock -n /var/lib/camsocs/harvest.lock pixi run pipeline -- --env prod sync --stages calendar_feeds,load'
  sudo -u camsocs -H bash -lc 'cd /opt/camsocs && pixi run harvest-events -- --env prod --dry-run'
  ```

  A dry run writes nothing to Convex, but the events stages still read the network and stage locally.

### Revoking the University events permission

The `uni_events` stage reads the University's events programme only under the permission recorded in `pipeline/.../sources/policy.py` `RECORDED_PERMISSIONS` (decision D3a, source-research §10). If University Information Services or the Office of External Affairs and Communications withdraws it, removing the row alone is not enough: the stage would only stop fetching, `load` would keep re-posting the last staged file every day, and published events would stay (the sweep withdraws only events a listing that is still read stops showing, and a folded run that has started is never swept). In order:

1. **Code (a reviewed commit):** delete the permission row and put `("webservices.admin.cam.ac.uk", "University events programme: permission withdrawn (source-research §10)")` back into `NEVER_FETCH_HOSTS`; take `uni_events` out of `GROUPS["events"]` and comment out its `Stage` in `STAGES` (the weekly `full` group runs every registry stage); say so in PLAN.md and source-research §10. Install that commit on the host (§3, `install.sh --revision <sha>`), or stop both timers until it is in.
2. **Staging and cache on the host:** as `camsocs` in `/opt/camsocs`, delete `pipeline/var/staging/uni_events_api.events/` (otherwise `load` re-posts it) and `pipeline/var/cache/webservices.admin.cam.ac.uk/`.
3. **Published events:** suppress every event whose `source` is `uni_events_api` (the broker's suppression list, data-model §3: an event suppression hides it from every public query and keeps the pipeline from posting it again). Then check that the events page's University view lists nothing.
4. Tell the two offices it is done.

## 6. Status, logs and alerts

- **Timers and units:** `systemctl list-timers 'camsocs-*'`, `systemctl status camsocs-harvest@events`, `journalctl -u 'camsocs-harvest@*' --since today` (the script's own lines and systemd's), `journalctl -u 'camsocs-alert@*'`.
- **Status file:** `/var/lib/camsocs/status.json` is the latest run of either group, `status-<group>.json` each group's latest; both are rewritten whole on every exit after the lock, and when the weekly run never had it (a skipped daily tick leaves them alone).

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
- **Run telemetry (PostHog, ENG-8):** with `POSTHOG_KEY` in `/opt/camsocs/pipeline/.env.prod`, each run sends `harvest_run_started`, one `harvest_stage_completed` per stage and `harvest_run_finished` to the EU project, as the personless id `camsocs-harvester`, tagged `environment` from `POSTHOG_ENV` (`production` here; unset it is `development`, which the project's internal filter hides). Counts, durations, statuses (the run's as `success`/`partial`/`failed`, like `harvestRuns`), stage names and exception class names only — never a stage's error text, notes, warnings, titles or URLs (`pipeline/src/camsocs_pipeline/telemetry.py`); the SDK adds only its library name and version (the host's OS and Python version are stripped). The values are read by the pipeline from the env file like `PIPELINE_API_KEY`: no unit, script or `install.sh` change, and the next run picks them up. Telemetry never fails a run; an unreachable, slow or rate-limiting PostHog adds at most about 6 seconds at the end of it (the final flush and SDK shutdown run on a background thread the pipeline waits for at most 6 s; events still queued then are dropped, and the SDK may log an upload error without the token). A run killed by the time limit or `systemctl stop` sends no finish event: the status file (`timed_out`, `stopped`) and the Slack alert are the record for those, as for lock and update failures, which happen before the pipeline starts. Check with `sudo -u camsocs -H bash -lc 'cd /opt/camsocs && pixi run pipeline -- --env prod status'` (`PostHog key: set`, host and `production`).
- **LLM analytics (PostHog, ENG-9):** with the same key, every request the pipeline makes to cliproxy (`extract/llm.py`) is sent as one `$ai_generation` (PostHog LLM analytics), as `camsocs-harvester` without a person profile: the model id, `$ai_provider` `cliproxy`, input and output tokens as cliproxy reports them, the final attempt's latency, the HTTP status (none for a connection failure), `$ai_is_error`, the run key as `$ai_trace_id`, the stage as `$ai_span_name`, the tier, the prompt version, the attempt count, `fallback` and, on failure, the exception's class name. It is captured by hand, not through the SDK's OpenAI wrapper, and **never** carries the prompt (`$ai_input`), the reply (`$ai_output_choices`), error text (`$ai_error`), the base URL or any scraped text: the properties are allow-listed in `telemetry.py`. A transient failure that recovers is one generation with its attempts counted; the corrective retry after a reply fails validation is a second one. **Sol fallback (ENG-23):** a bulk (`gpt-6-luna`) request that fails is asked once more, as a fresh request with its own retries, on the strong model (`gpt-6.1-sol`) when the failure may be the model's: a reply that still fails validation after the corrective retry, 429/5xx/timeouts that outlast their retries, or any other HTTP error cliproxy answered (400 context length, 404 unknown model, 422). Not after a plain connection failure (cliproxy is down for both models), a 401/403 (the same key) or a request that was on the strong tier already. The failed bulk request stays its own generation with its `errorType`; the strong requests are reported with tier `strong` and `fallback: true` (filter on it in LLM analytics to see how often Luna needs Sol), and the reply's provenance and LLM cache entry name the strong model, cached under the bulk request's key so the next run does not repeat the failing call. If the strong model fails too, the bulk error is raised (the journal has a warning with both model ids and both exception classes), so stages fail or skip exactly as before. No setting turns it off; `LLMClient(..., fallback=False)` exists for tests. A reply answered from the LLM cache (`var/cache/llm/`) makes no request and is not a generation. The talks stages (`talks_cam`, `talks`) never call the model, so they send none (a test runs each for real, not as a dry run, with every way to a model wired to fail, from asking the settings for the LLM configuration to the completion request; the `talks` one feeds a source of every department parser kind). Cost in PostHog is indicative only: cliproxy runs on a subscription, and its model ids match no public price list, so PostHog may show no cost or an estimate unrelated to what is paid; no custom pricing is configured. Same rules as run telemetry: nothing without `POSTHOG_KEY`, never fails or slows a call, flushed within the same bounded close at the end of the run.

### Alerts

`camsocs-harvest@<group>.service` has `OnFailure=camsocs-alert@<group>.service`: any non-zero exit, a timeout or a kill starts `/usr/local/lib/camsocs-ops/camsocs-alert.py <group>` (standard library only, the host's `python3`, root-owned), modelled on `mya-backup`'s `send_alert`:

- **Who.** `DynamicUser=yes`: a user of its own for each alert, not `camsocs`, in the `camsocs` group only to read the status file. It cannot read the checkout (with the pipeline's keys), the logs, `/docker` or `/root`.
- **Credentials.** `install.sh` copies `SLACK_BOT_TOKEN`, `SLACK_HOME_CHANNEL` and `SLACK_ALLOWED_USERS` — and nothing else — from Mya's env file (`/docker/hermes-agent-vspa/data/.env`) into `/etc/camsocs/alert.env` (`0600` root); the alert unit has `LoadCredential=slack-env:/etc/camsocs/alert.env`, so systemd hands it a read-only copy only it can read while it runs. After Mya's token changes: `bash /usr/local/lib/camsocs-ops/install.sh --refresh-alert-env`.
- **Destination.** `SLACK_HOME_CHANNEL` when set; otherwise the first user in `SLACK_ALLOWED_USERS`, whose DM `conversations.open` opens; then `chat.postMessage` (Slack Web API, Bearer token).
- **Message: structured facts only.** Group, exit status and how the unit ended (systemd's `MONITOR_SERVICE_RESULT` / `MONITOR_EXIT_CODE` / `MONITOR_EXIT_STATUS`), and — only if the status file is this run's (its `invocationId` must match `MONITOR_INVOCATION_ID`) and only values of a known shape — the phase, commit, run key, start and finish times and the failed stages' names, then the log's path on the host. The status file is the harvest's and so untrusted: a value of any other shape is not shown. No log line, no error text and no warning is sent: those carry scraped titles and server errors, which must not reach Slack (or Mya's channel). The message is still masked as a last line of defence (Slack, OpenAI-style, GitHub and Google keys, `Bearer …`, secret-looking `NAME=value`, credentials in URLs, long opaque strings).
- **Not alerted:** a skipped daily tick, and a run's warnings (stale inputs) — those are in the status file and the run log.
- **The monitor's alerts** (`camsocs-alert@monitor.service`, from `camsocs-monitor.service`'s `OnFailure=`) are built from `status-monitor.json` instead: the failing checks' names with their value, threshold, window and named counts (numbers only, shape-checked), the checks PostHog could not answer, and where to look. When the monitor wrote no status this run (pixi or Python failed, a timeout), the message says the monitor itself failed, with the exit status.
- **Testing.** Print the message without sending (no credential needed): `sudo -u camsocs python3 -I /usr/local/lib/camsocs-ops/camsocs-alert.py --dry-run events`. Send a real DM: `systemctl start camsocs-alert@events.service` (it reports the last events run as failed; say so in Slack if anyone else reads the channel). If nothing arrives: `journalctl -u camsocs-alert@events` shows Slack's error code (`not_in_channel`, `missing_scope` — `conversations.open` needs `im:write`, posting needs `chat:write`) and never the token.

### Monitor

`camsocs-monitor.timer` starts `camsocs-monitor.service` hourly (at a random point in the first 15 minutes): `pixi run --as-is … pipeline -- --env prod monitor --status-json /var/lib/camsocs/status-monitor.json` as `camsocs` (`pipeline/src/camsocs_pipeline/monitor.py`, ENG-10). It runs four HogQL counts through PostHog's query API with the personal key from `pipeline/.env.prod` and exits 1 when a check fails, which `OnFailure=camsocs-alert@monitor.service` turns into a Slack DM. The key has no alert scopes, so PostHog's own alerts are not used. Production events only (`environment = 'production'`), and the visitor-side checks (all but `stale_harvest`) leave out the in-app Claude browser (`$browser = 'Claude'`), as the project's internal/test filter does, so an agent's QA session on camsocs.uk neither pages nor keeps the heartbeat alive (`NOT_INTERNAL`). The project's internal cohort is not applied: a maintainer's own consented browsing still counts:

| Check | Fails when | Constant (`monitor.py`) |
|---|---|---|
| `error_spike` | more than 20 `$exception` events (browser and server) in the last 60 minutes | `ERROR_SPIKE_MAX`, `ERROR_SPIKE_MINUTES` |
| `stale_harvest` | no `harvest_run_finished` with status `success` or `partial` (dry runs excluded) in the last 26 hours | `HARVEST_STALE_HOURS` |
| `zero_result_rate` | over the last 24 hours, at least 20 `search_performed` and more than 50 % of that many `search_zero_results` | `ZERO_RESULT_HOURS`, `ZERO_RESULT_MAX_RATE`, `ZERO_RESULT_MIN_SEARCHES` |
| `pageview_heartbeat` | no `$pageview` in 48 hours (only consented visitors send one, hence the long window) | `HEARTBEAT_HOURS` |

- **`stale_harvest` needs run telemetry.** It counts the harvester's own `harvest_run_finished` events, so `POSTHOG_KEY` must be set in `pipeline/.env.prod` too (§6 "Run telemetry"); without it the check fails every time. On Sundays the daily tick is skipped while the full run holds the lock, so a full run that ends more than about 26 hours after Saturday's events run (it may take up to 6 hours) trips it once, then clears when the full run's success arrives.
- **Facts only.** The queries select counts; the output (journal) and the status file hold check names, counts, thresholds and windows, never an event property.
- **PostHog trouble does not page.** A query that fails (network, timeout, HTTP error, rate limit) makes its check `unknown`: a warning in the journal, `unknownChecks` in the status file, exit 0. The price: a revoked or wrong key (HTTP 401/403 on every check) shows only there, so look at `journalctl -u camsocs-monitor` after a key change.
- **Reminders.** A check that keeps failing alerts again only every 6 hours (`REALERT_AFTER`); a newly failing check alerts at once. Meanwhile the run exits 0 and the status file says `"result": "failed", "paged": false`. A paged check is forgotten only once it is seen `ok` again: an hour in which PostHog did not answer for it (`unknown`) keeps the page in memory, and a check that recovered and then fails again alerts at once, even while another check is still failing.
- **Without the key** (`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` unset) it prints "nothing checked" and exits 0.
- **The key.** A personal API key is a user's key, not the ingest-only `phc_` token: it can read the project's events. The host uses the project-scoped key from the 1Password Mya vault, item `PostHog` (camsocs project only; insight and dashboard write, query read, error tracking write) — Joshua's decision on 2026-11-02, because coming features need more than `query:read`. Keep it scoped to the camsocs project. It lives only in `/opt/camsocs/pipeline/.env.prod` (`0600 camsocs`, readable by the harvest and monitor units only); `status` shows it as `set`, never its value.
- **Sandbox.** Like the harvest (same address and system-call restrictions), but the checkout is read-only for it except `.pixi` (pixi records a task cache there and fails without it); it writes only `/var/lib/camsocs`. `--as-is` runs in the environment the harvest installed and never installs, so it cannot race a harvest's `pixi install`; on the rare run right after a pull that changed dependencies it may fail once (and alert as "the monitor itself failed"). Unlike the harvest it cannot reach the loopback except the DNS stub (`IPAddressDeny=localhost`, `IPAddressAllow=127.0.0.53`), so not cliproxy, and the harvest's deploy key (`/var/lib/camsocs/.ssh`) and logs are hidden from it. If the host's resolver is not the stub, the queries fail as `unknown` (journal only): check `journalctl -u camsocs-monitor` after the first run. A checkout without `pipeline/src/camsocs_pipeline/monitor.py` (not yet pulled, or pinned before ENG-10) skips the run without an alert.
- **Status file** `/var/lib/camsocs/status-monitor.json` (`0640`, group `camsocs`): `checkedAt`, `invocationId`, `result` (`ok`, `failed`, `unknown`), `paged`, `failedChecks`, `unknownChecks`, `alertedChecks`, `lastAlertAt`, and `checks` (name, status, value, threshold, `op` `gt`/`lt`, `windowHours`, `detail` counts, `reason` for an unknown).
- **By hand:** `systemctl start camsocs-monitor.service` (blocks; the result in `journalctl -u camsocs-monitor -n 20`), or without the unit `sudo -u camsocs -H bash -lc 'cd /opt/camsocs && pixi run pipeline -- --env prod monitor'`. The alert's text without sending it: `sudo -u camsocs python3 -I /usr/local/lib/camsocs-ops/camsocs-alert.py --dry-run monitor`.
- **Changing a threshold** is a code change in `monitor.py` (a reviewed commit on main). The monitor never pulls: it runs the checkout as the last harvest left it, so a merged change reaches it after the next harvest.

## 7. Rotating keys

Do it outside the run windows (not 02:00–08:00 on Sundays, not 04:30–06:30 daily) or with the timers stopped; a run between the two halves fails with 401 and alerts.

- **Production `PIPELINE_API_KEY`:** `openssl rand -hex 32`; *laptop*: `cd webapp && unset CONVEX_DEPLOY_KEY && bunx convex env set --prod PIPELINE_API_KEY` (prompts for the value); on the host `sudoedit /opt/camsocs/pipeline/.env.prod` (it stays `0600 camsocs`); then `sudo -u camsocs -H bash -lc 'cd /opt/camsocs && pixi run pipeline -- --env prod health'`; update the laptop's `pipeline/.env.prod` too.
- **The camsocs cliproxy key:** add the new key to cliproxy's client keys (§8), restart it, change `LLM_API_KEY` in `/opt/camsocs/pipeline/.env`, check with `pixi run pipeline -- --env prod status` (shows `LLM key: set`) and a manual `sync --stages website_events --limit 1`, then remove the old key from cliproxy.
- **The deploy key:** a new pair (§2 step 2), add it in GitHub, `bash /usr/local/lib/camsocs-ops/install.sh --revision "$(cat /usr/local/lib/camsocs-ops/REVISION)" --deploy-key <new private key>` (it installs root's and the harvest's copy and leaves the timers as they are), check `sudo -u camsocs git -C /opt/camsocs fetch`, delete the old key in GitHub.
- **Slack:** the bot token is Mya's; after it changes in her env file, `bash /usr/local/lib/camsocs-ops/install.sh --refresh-alert-env` copies the three values again.
- **Meta token** (about every 60 days) and **Camdram key:** in `/opt/camsocs/pipeline/.env`.
- **PostHog project token** (`POSTHOG_KEY`): after rotating it in PostHog, `sudoedit /opt/camsocs/pipeline/.env.prod` (it stays `0600 camsocs`) and update the laptop's `pipeline/.env.prod` and the 1Password item. Removing the line turns run telemetry off.
- **The monitor's personal API key** (`POSTHOG_PERSONAL_API_KEY`): create the new key in PostHog (camsocs project only, the same scopes), update the 1Password item, `sudoedit /opt/camsocs/pipeline/.env.prod`, run `systemctl start camsocs-monitor.service` and check `journalctl -u camsocs-monitor -n 10` shows no `unknown`, then delete the old key in PostHog (the dashboards script and the Vercel source-map upload use the same key: update `POSTHOG_PERSONAL_API_KEY` in Vercel Production too). Removing the two lines turns the checks off.

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
- run as root: the harvest and the monitor run as `camsocs` (the alert as a dynamic user of its own; the monitor writes only `/var/lib/camsocs` and the checkout's `.pixi`) with `NoNewPrivileges`, `ProtectSystem=strict` (writable: `/opt/camsocs` — the run's own `git pull` and `pixi install` write the checkout — `/var/lib/camsocs`, `/var/log/camsocs`), `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ProtectProc=invisible`, a system-call filter and an empty capability set;
- reach the host's private networks: the fetcher refuses any URL whose host resolves to a loopback, private, link-local, CGNAT or other non-public address, at every redirect and again when it connects (pipeline `sources/base.py`), and the unit denies the private, CGNAT and link-local ranges (`IPAddressDeny`); cliproxy is reached by the LLM client on the loopback, which no scraped URL can use;
- let root run anything from the checkout: the installer, units, logrotate config, alert and harvest script come from a reviewed commit in root's own mirror.
