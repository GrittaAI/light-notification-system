# Decisions

Format: decision. Reason.

## Earlier steps (made with the user)
- better-sqlite3 13.x on Node 22, install script not approved. Its bundled prebuilt binaries cover macOS and Linux; compiling fails on the dev Mac.
- sent_reminders key includes calendar_id. One invite can be on several client calendars with the same event_id.
- Sync marks stored future events no longer returned in the 26h window as "removed". Prevents reminders firing at an old time after a far reschedule, move or hard delete.
- Broken config.json at runtime: keep using the last valid config and log an error. A typo must not stop all reminders.
- Insert sent_reminders only after a successful send (no "sending" state). User's choice; accepts a rare duplicate on timeout.
- Live events.get just before sending; on failure, send from stored data. A Google hiccup must not block reminders.
- first_seen_utc = when the current start_utc was first seen. Long-booked calls moved to start soon must not raise false "missed" alerts.
- Missed-reminder alerts are batched into one email per reminder run. Avoids an email flood after an outage.

## Lead decisions for PLAN.md tasks
- PLAN.md created from the lead's draft, approved by the user. The file was missing.
- Task 1: WAHA port published on 127.0.0.1 only. The dashboard/QR page and API must not be reachable from the internet; use an SSH tunnel on a server.
- Task 1: App reaches WAHA at http://waha:3000 on the compose network; compose overrides WAHA_URL. Avoids a wrong .env value breaking sends.
- Task 1: WAHA session data on a named volume; WAHA restarts existing sessions on boot. Avoids re-scanning the QR code after every restart.
- Task 1: restart: unless-stopped and json-file log rotation (10 MB x 5) for both services. Survive crashes and reboots without filling the disk.
- Task 1: Pin the WAHA image to a specific version tag if one can be found, otherwise `latest` with a comment. Unplanned WAHA upgrades could break sending.
- Task 2: Health server uses node:http (no new dependency), port HEALTH_PORT (default 8080), not published by compose. Keep dependencies minimal; health is for Docker, not the internet.
- Task 2: /health returns 503 if the last fully successful sync is older than 10 minutes or the WAHA session is not WORKING. Either one means reminders may be missed.
- Task 3: Alerts fire on entering a failing state, repeat at most every 60 min while it persists, and send one "recovered" email. Enough to notice without spamming.
- Task 3: Alert state stored in the kv table. Rate limiting survives restarts (no alert storm on crash loops).
- Task 3: If an alert email fails, its state is not updated, so the next check retries. A failed email must not silence an ongoing problem.
- Task 3/4: The monitor job runs every minute and once at startup; task 4 adds a one-line startup summary on top of it. Avoids two code paths checking the same things.
- Task 1: Pinned WAHA to `devlikeapro/waha:latest-2026.10.1` (amd64; ARM servers need `arm-2026.10.1`). No plain version tags exist; this tag has the same digest as `latest`.
- Task 1: The app does NOT wait for WAHA to be healthy (no `condition: service_healthy`). If WAHA or its session is down, the app must still sync, retry sends and raise missed/ops alerts; blocking its start would make failures silent.
- Task 1: Reviewer notes (ARM tag, shell WAHA_API_KEY overriding .env, create config.json before `up`) go into the task 5 runbook rather than config changes. They are operator pitfalls, not defects.
- Task 2: Health logic is a testable function (`checkHealth`) separate from the HTTP server; the compose healthcheck uses `node -e fetch(...)` because the slim image has no curl.
- Task 2: The WAHA check in /health is a live GET of the session status with a 5 s timeout; errors report status UNREACHABLE. A cached value could hide an outage.
- Task 2: A health server error (e.g. EADDRINUSE) is logged and ignored; it must never stop sync or reminders. Docker then reports unhealthy, so the problem stays visible.
- Task 3: WAHA "not WORKING" alerts only after it has been failing for 3 minutes (debounce). WAHA reports STARTING for ~1 min after every restart; alerting on that would train people to ignore alerts. 3 min is still well inside the 5-min reminder offset.
- Task 3: Google invalid_grant alerts immediately (no debounce). It never fixes itself and blocks every calendar.
- Task 3: Sync-stale alert also covers "never synced since startup" once the process has run 10 min, and lists the calendars that failed in the last sync. One failing calendar blocks last_successful_sync, so the email must say which one.
- Task 3: invalid_grant is detected through a `reason` field added to describeGoogleError's output. Matching on hint text would be brittle.
- Task 3: The WAHA debounce counts only failures seen by the current process (failingSince is clamped to process start); alertedAt still persists. Otherwise every reboot would alert immediately on WAHA's normal STARTING phase.
- Task 3: google_auth is not evaluated until the first SyncResult exists. Prevents a false RECOVERED email after a restart.
- Task 3: The sync_stale email mentions a failed config.json reload as a possible cause instead of plumbing a new field through sync.ts. Keeps sync.ts unchanged; the logs have the detail.
- Task 4: The startup summary is a single log line built by a pure function from the startup SyncResult and a live WAHA status; info level when all OK, warn otherwise. Alerting stays with the task 3 monitor (no second alert path), and the app always keeps running.
- Task 5: `npm run auth` is documented to run on the operator's laptop (it needs a browser for the loopback redirect); only the resulting token goes to the server's .env. Servers are usually headless.
- Task 5: In-container checks use `node dist/sync-once.js` (tsx is a dev dependency and is not in the production image).
- Task 5: The runbook includes an end-to-end test (event 15 min ahead in a test group) and an alert drill (stop WAHA) before going live. Proves sending and alerting work before real calls depend on them.
- Task 5: Backups stop app and waha first (short stop). Copying a live WAL-mode SQLite file can produce a corrupt backup that loses the sent-reminders record.
- Task 5: The runbook says to keep WAHA_SESSION=default. The free WAHA Core image supports only a session named "default".
