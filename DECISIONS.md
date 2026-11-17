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

## Service account switch (user request)
- Auth: google.auth.JWT with client_email + private_key from the key, scope calendar.readonly. Replaces the OAuth refresh token.
- Key source: GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path) or GOOGLE_SERVICE_ACCOUNT_JSON (content). Exactly one must be set; both or neither fails at startup. Avoids silently using the wrong key.
- The key is validated at startup (type service_account, client_email, private_key present; a path pointing at a directory is reported as such) and the app fails fast with a clear message; the private key is never logged. A bad key would otherwise fail every sync.
- "Not shared" message: 404, and 403 except for API-disabled/quota reasons (accessNotConfigured, rateLimitExceeded, userRateLimitExceeded, quotaExceeded, dailyLimitExceeded), becomes "Calendar <name> is not shared with the service account <client_email> (See all event details)". It is set as the calendar error message, so the sync log, the startup check and the sync-stale alert all carry it. Mislabelling a disabled API or a quota error as "not shared" would send the operator the wrong way.
- 403 accessNotConfigured gets the hint "enable the Google Calendar API in the service account's project".
- invalid_grant now means the key was deleted or revoked (or the server clock is wrong); the google_auth alert tells the operator to create a new JSON key, replace the file and restart. The old "run npm run auth" text is removed.
- Docker: ./secrets/google-service-account.json is mounted read-only at /run/secrets/google-service-account.json, and compose sets GOOGLE_SERVICE_ACCOUNT_KEY_FILE to that path. The README tells the operator to give the file to uid 1000 (the container's node user) with mode 400. Never baked into the image; secrets/ is in .gitignore and .dockerignore.
- Key filename: secrets/google-service-account.json (the name the user had already used in .env.example and on disk), mounted at /run/secrets/google-service-account.json. The coder had chosen secrets/service-account.json; aligned to the user's existing file so nothing needs renaming.

## WAHA image per machine
- The WAHA image comes from `WAHA_IMAGE` in .env, defaulting to the pinned amd64 image. On Apple Silicon or other ARM machines set WAHA_IMAGE to the arm64 tag (tags now gows-2026.10.1 / gows-arm-2026.10.1; see the GOWS engine line below; originally latest-/arm-2026.10.1). The amd64 tag has no arm64 build, and emulating WAHA's Chrome is unreliable; one compose file must work on both the Mac and an amd64 server.
- WAHA engine: GOWS (no browser) instead of WEBJS. Default image devlikeapro/waha:gows-2026.10.1 (amd64); on ARM, WAHA_IMAGE=devlikeapro/waha:gows-arm-2026.10.1. On the user's Mac, WEBJS failed every QR start with "Waiting failed: 30000ms exceeded" from its embedded Chrome, while GOWS linked first time; fewer moving parts means fewer missed reminders.
- Verified on the running container: the GOWS image sets WHATSAPP_DEFAULT_ENGINE=GOWS itself (the explicit compose entry is harmless), and the GOWS login is stored at /app/.sessions/gows/default on the waha-sessions volume, so it survives restarts.

## Admin front end
- Configuration moves from config.json to SQLite tables (closers, clients, settings, admin_users) edited through the admin UI; sync/reminders/monitor read it from the DB on every run, so edits apply without restart. config.json is imported once if the tables are empty, then no longer read. A single source of truth the UI can change safely.
- Same validation rules as before (zod) on every write; invalid input is rejected with a field error, so a bad edit can never reach the running jobs (replaces the "last valid config" fallback).
- Reminder offsets become a setting (default 60/30/10/5; whole minutes 1-1440, unique, at most 10). Lookahead = largest offset + 1 min. Missed-reminder detection uses max(first_seen_utc, offsets_updated_at), so adding an offset never raises false "missed" alerts for calls already known.
- Login: SUPERADMIN_EMAIL (required) + ADMIN_PASSWORD (optional, >= 12 chars, superadmin only) and/or GOOGLE_OAUTH_CLIENT_ID (optional, Google Identity Services ID token verified server-side with the existing googleapis OAuth2 client; audience = client ID; email_verified required). At least one method must be configured. A service account cannot authenticate users.
- Sessions: random 32-byte token in an HttpOnly, SameSite=Strict cookie (Secure when ADMIN_COOKIE_SECURE=true, i.e. behind HTTPS); only its SHA-256 is stored in SQLite; 12 h expiry; every request re-checks that the user is still allowed. Password login is rate-limited (5 failures / 15 min per IP) and compared in constant time.
- CSRF: state-changing requests must be JSON and, if an Origin header is present, it must match the Host. Combined with SameSite=Strict.
- Roles: superadmin (from .env, cannot be removed) manages admin users; admins manage closers, clients and settings. Every change is written to an audit log with the actor's email.
- No new runtime dependencies: node:http server, vanilla HTML/JS/CSS UI with no build step, served from public/admin (copied into the Docker image).
- The admin server listens on ADMIN_PORT (default 8081); compose publishes it on 127.0.0.1 only and the README shows putting HTTPS (Caddy) in front. Google Sign-In requires an HTTPS origin (or localhost). /health stays internal.
- Usability for "dynamic" config: the UI picks WhatsApp groups from WAHA's group list instead of pasting IDs, shows the service account email to share calendars with, shows per-calendar sync status and upcoming calls with matched closers, and can send a test message to a client's group.
- Admin server: every request is wrapped so a malformed request becomes a 400/500 and can never throw out of the request handler. One bad request must not stop the reminder jobs.
- The config.json seed is guarded by a kv flag `config_seeded_at` (also set when the tables are already non-empty at startup), so emptying the tables never re-imports old data.
- Reminders only consider events of currently active clients; disabling, deleting or re-pointing a client stops its reminders without false "missed" alerts.
- Offsets store their own added-at time; the missed-alert suppression applies only to offsets added after an event's first_seen_utc. Removing or re-saving offsets never hides a real missed reminder (conservative option).
- Behind a proxy (ADMIN_TRUST_PROXY=true) the client IP is the LAST X-Forwarded-For entry, the one the trusted proxy appended; the first entry is client-controlled.
- Failed Google token verification logs only a fixed reason code, never the library message (it can contain the token and its claims).
- HSTS is sent when ADMIN_COOKIE_SECURE=true.
- Re-enabling a client after offsets fell due while it was disabled may raise "missed" alerts for those offsets. Accepted for now: it only errs toward alerting (conservative). Possible later fix: a per-client "active since" time, used like the per-offset added time.
- Deferred (non-blocking, reviewer notes): rewording a garbled doc comment in src/reminders.ts:80-82, and skipping the raw 400 write in clientError when a pipelined response is in flight (affects only a misbehaving client).

## Admin UI redesign (user request: "dull and confusing", more icons, better layout)
- Layout: left sidebar with icon + label navigation (collapses to a top bar + slide-in menu on phones), a page header with title, one-line description and the main action button, content in cards. Add/edit happens in a modal dialog, not inline rows. Clearer hierarchy, one primary action per page.
- Icons: a vendored subset of Lucide icons (ISC licence, attribution kept) in public/admin/icons.svg, used via <svg><use href="icons.svg#name">. No icon CDN or webfont: the CSP allows only self (+ accounts.google.com) and we add no dependencies.
- Typography: system font stack (no Google Fonts; the CSP has no font-src for external hosts).
- Reduce confusion: a "Setup checklist" card on the dashboard (calendar shared with service account, WhatsApp linked, at least one client, at least one closer, Google login configured), derived from /api/status; empty states that say what to do next; toasts for success/errors; a custom confirm dialog instead of window.confirm(); relative times ("in 12 min") next to IST times; status shown as coloured pills with icons.
- Safety rules unchanged: no innerHTML/insertAdjacentHTML/outerHTML with API data (DOM APIs + textContent only), no inline scripts or styles (CSP), no API or backend behaviour changes.

## WhatsApp management in the admin UI
- Superadmin only (changing or unlinking the company WhatsApp affects every reminder); every action is audited.
- The browser never talks to WAHA directly: the admin server proxies the few needed WAHA calls (session status/me, QR image, start, restart, logout, pairing code) with the API key kept server-side. Keeps WAHA localhost-only and the key secret.
- Log out / switch number requires an explicit confirmation stating that reminders pause until a new number is linked.
- Queued until the UI redesign review finishes, to avoid two agents editing public/admin/* at once.
- UI redesign passed review round 1. Reviewer polish items 1-8 (drawer focus trap, sent-today "+" logic, stale check from server syncOk instead of browser clock, exact status lookup, no backdrop-close on form modals, dialog close safety net, GIS initialize once, role=alert on error toasts) are folded into task 8, which edits the same files.
- Google's own GIS inline styles are blocked by our CSP (style-src without 'unsafe-inline'). Accepted for now: keeping the CSP strict matters more than pixel-perfect styling of the Google button. Revisit only if the button looks broken once GOOGLE_OAUTH_CLIENT_ID is configured.
- Task 8 passed review round 2. Session status and QR endpoints verified live against the real WAHA (read-only: status WORKING, linked number shown, QR 409 while connected). Start/restart/logout/switch were deliberately never run against the real WAHA; they are verified against a mock only, so the first real number switch should be done by the user from the UI.
- Deferred (non-blocking): move focus to #main after hash navigation; audit failed pairing-code requests; rate-limit pairing-code (superadmin-only, low risk).

## Tasks product
- Built into the same service (same SQLite, auth, WAHA, scheduler, audit, deploy) as a new module, not a separate app: one deploy, one WhatsApp link, shared security work.
- Separate frontends: the employee PWA at /app (mobile-first, offline) and the existing admin console at /. Employees never need the admin console.
- People directory: a new `people` table (email, name, whatsapp, role admin|member, active, notification target) replaces admin_users (migrated; superadmin still from env). Closers stay separate (sales domain).
- Member login without passwords: a 6-digit email code via the existing SMTP (hashed, 10 min expiry, 5 attempts, rate-limited), plus Google Sign-In once GOOGLE_OAUTH_CLIENT_ID is set. Superadmin password login unchanged. Sessions: 30 days sliding for members (phone app), 12 h for admins/superadmin.
- Access control: owner always has full access to their own list; admins/superadmin see and edit all; members see others only through explicit grants (grantee → owner, level view|edit) managed by admins. Every API call is checked server-side; the UI only hides.
- Task fields: title, notes, status (todo|in_progress|done), priority (low|medium|high|urgent), due_at (UTC, optional: no due date = no nudges), checklist (JSON), snoozed_until, owner, created_by, timestamps, version, soft delete. Every change is written to task_activity.
- Nudge rule (per owner): a task becomes "nudgeable" at due_at - lead (default 10 min) while not done, not deleted and not snoozed. A digest for an owner is sent when any task becomes nudgeable for the first time, or when the owner's repeat timer (default 10 min after the last digest) fires. A digest lists ALL of that owner's nudgeable tasks in one message (overdue first); with exactly one task it is a single-task message. This aligns tasks with different due times into one stream instead of separate pings.
- Snoozing (1 h / 2 h / 24 h / custom) or changing the due date resets the task's first-alert flag, so it alerts again on time when it becomes nudgeable; done stops it for good; reopening re-arms it.
- Where nudges go: an org default WhatsApp group set by an admin, tagging the owner; per person an admin can override with another group or a direct message to their number. Viewers with access are not nudged (MVP).
- Actions from WhatsApp: each digest has a link per task (and a "manage all" link) to the PWA task page with Done / Snooze buttons; links require login (a group link must not let anyone else complete your task). Reply commands via webhook are Phase 4.
- Quiet hours setting (default OFF): when enabled, no nudges in that window; they resume after it. Nagging every 10 min overnight is otherwise unavoidable.
- Offline: client-generated UUIDs, IndexedDB cache, an outbox replayed when online, optimistic concurrency with a per-task version (409 returns the server copy; the PWA shows a conflict notice and keeps the server version for that field set). Nudges are server-side, so they work while a phone is offline.
- Reliability: the task engine is its own guarded job and must never affect the call-reminder jobs; a digest's state is recorded only after WAHA accepts the message (retry next minute), so no duplicate or silently lost digests.
- Risk accepted and flagged: WAHA is an unofficial WhatsApp client; frequent automated messages raise the chance WhatsApp restricts the number. Batching per person keeps volume down; a dedicated ops number is recommended.
- No new runtime dependencies; vanilla JS PWA without a build step, consistent with the admin console.

## Tasks product = separate product "Nudge" (user clarification 2026-11-17)
- Name "Nudge" at nudge.grittaai.com (configurable APP_NAME / TASKS_PUBLIC_URL). The call-reminder product at reminders.grittaai.com must be unaffected.
- Same codebase and Docker image, run as a SECOND container: SERVICE_ROLE=reminders (default, today's behaviour: sync, reminders, monitor, admin console on 8081) or SERVICE_ROLE=tasks (Nudge API + PWA + nudge job on 8082). A crash, bug or load in Nudge cannot stop call reminders, and each restarts independently.
- One SQLite file on the shared app-data volume (shared people directory and superadmin); WAL + busy_timeout handle the two processes; every migration is idempotent and runs in an immediate transaction so simultaneous startups are safe. Each process runs only its own jobs.
- Nudge serves its PWA at "/" of its own host, its own session cookie name (host-only), and its own admin area (people, access rules, task notification settings) inside Nudge. The reminders admin console keeps only its current features; task routes are not exposed there.
- Shared notification layer: whatsapp.ts gains direct-message sending alongside group messages with mentions; Nudge uses it. Call reminders keep their current code path unchanged (no refactor of working, tested reminder logic).
- Env validation is role-aware: the tasks role needs WAHA, SMTP, SUPERADMIN and session settings, but not the Google Calendar service account.
- Supersedes the earlier "employee PWA at /app" and "Phase 3 admin in the admin console" decisions.
- Nudge Phase 1 review round 1: two blocking privilege bugs (admin email change escalation; superadmin email managed as a person) sent back for fixing.
- docker-compose pins SERVICE_ROLE=reminders on the app service, so a stray SERVICE_ROLE in the shared .env can never silently turn off call reminders.
- "Remove admin" in the reminders console demotes the person to a Nudge member (they keep their task list); fully removing someone is "deactivate" in Nudge's People admin. Matches how employees are managed.
- Look-ahead merge window for nudges: when a digest is sent anyway, it also includes tasks that become nudgeable within the next 5 minutes (setting tasks.merge_ahead_minutes, 0-15, default 5) and marks them alerted. Avoids separate first-alert pings minutes apart; errs toward alerting slightly early, never late.
- Accepted as-is: a re-arm made during the seconds a digest is being sent can be absorbed (bounded by the repeat interval); a failed request may extend a member session without re-issuing the cookie (harmless).
- For Phase 2: the PWA must drop cached tasks whose owner is no longer in /api/app/owners (grant revoked or task moved away).
- The superadmin may have their own person row (own task list), created only by the superadmin themselves (self-service, e.g. on first Nudge sign-in or via People admin); ordinary admins can never create, edit, rename to, change the role of, or deactivate that row. Keeps the anti-takeover protection while letting the product owner use Nudge.
- Nudge Phase 1 passed review round 2.
- Access grants whose owner is the superadmin's own list can only be created or removed by the superadmin (privacy of the product owner's list); folded into Phase 3.
- Also folded into Phase 3 (small backend items): audit the /self legacy-row repair as person_self_repair; hide the superadmin from the reminders console's Admins list.
- Accepted: the merge window can end a snooze up to 5 minutes early (consistent with "early, never late").
- Nudge shows all times in Asia/Kolkata (same as its WhatsApp messages), not the device timezone, so app and messages always agree.
- Nudge PWA data on the device (IndexedDB) is cleared on logout; the service worker caches only the app shell, never API responses.
- Nudge PWA: only one tab is active at a time (navigator.locks 'nudge-active'); a second tab shows "Nudge is open in another tab" with "Use here". Outbox writes are per entry (never clear-and-replace) and sync re-reads the outbox from IndexedDB under a 'nudge-sync' lock as defence in depth. Simplest robust protection against cross-tab loss and double pushes.
- A replayed create (409 on the client's own UUID) is rebased only if the server copy is unchanged since creation (version 1) or already contains the edit; otherwise it is a normal conflict. Never overwrite another person's edit.
- The service worker version is a content hash of the shell files injected by the Nudge server at startup; no manual bump.
- Quick add rests as one ~60 px row (title, due button, priority, add); preset chips appear only while typing; "Pick…" opens a bottom sheet.
- Accepted for now: action endpoints (done/reopen/snooze) carry no version, so a replay after a crash mid-push can override another user's later change of status; rare, idempotent, revisit if it shows up.
- Manifest without an orientation lock (tablets usable in landscape).
- Accepted: when "Use here" steals the active-tab lock during the old tab's push, the new tab may replay entries the old tab already applied (puts resolve as already-applied, actions are idempotent; a replayed snooze can extend slightly). Safe, rare, cheaper than cross-tab handshakes.
- Quick-add row: due and priority controls are icon-only until set, so the title takes most of the width; "Pick…" comes first in the chips row.
- Nudge Phase 2 entered round 3 (last allowed) for the stolen-tab bug; if round 3 fails, stop and report to the user.
- Nudge Phase 2 passed final review (round 3). Small a11y polish (focus back on the priority button, radiogroup role, task title min-height 44 px) is folded into Phase 3.
- Phase 3: Nudge admin lives inside the Nudge PWA (admin/superadmin only, mobile-first, desktop-friendly). The Nudge server gets its own admin-only WhatsApp groups endpoint (cached, same normalisation as the console) so admins pick groups by name; no cross-calls to the reminders service.
- Phase 3 includes a "Send test nudge" action per person (sends a one-line test to that person's resolved target) so admins can verify routing before relying on it; audited.
- Nudge Phase 3 review round 1: reactivating a deactivated admin is superadmin-only (was a privilege bug).
- Group picker has a manual "Enter group ID" fallback (validated @g.us) when WAHA can't list groups, so routing can still be configured during a WhatsApp outage.
- Test nudge has a 30 s cooldown per person (429) to prevent group spam; failures of test-nudge and groups listing are logged server-side (clear logs).
- Form sheets (person edit, settings) never close on backdrop click; a nested confirm returns to the form on Cancel instead of discarding it.
- One toast at a time (a new one replaces the previous); no toast when an inline field error is already shown.
- User-facing validation messages are friendly (custom zod messages), never raw library wording.
- Person-switcher chips are hidden on admin pages.
- Toasts with an action (the "New version available" refresh prompt and the "Undo" toast) are never replaced by passive toasts; only passive toasts replace each other. Keeps the one-toast rule without losing update prompts or Undo.
- Reminders console validation wording stays byte-identical (Nudge-specific type messages only on Nudge schemas).
- Nudge Phase 3 entered round 3 (last allowed); if it fails, stop and report to the user.
- Nudge Phase 3 passed final review (round 3). Shipping with one accepted cosmetic issue: when an update prompt, an Undo and an error toast coincide, the error can briefly overlap the update prompt (prompt never lost; queued as polish, PLAN 14).
- Before deploying new code to production, take an online SQLite backup (better-sqlite3 .backup()) inside the app container; no service stop needed, so no reminder is put at risk.
