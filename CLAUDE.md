Project: Pushup call-reminder service.

Goal: read Google Calendar events for several client calendars, work out which "closers" (sales staff) are guests on each upcoming call, and post timed reminders into WhatsApp groups, @mentioning those closers.

Stack: Node.js 22 + TypeScript, SQLite via better-sqlite3, node-cron, googleapis, zod for config validation, nodemailer for alerts, Docker Compose to run the app and a WAHA (WhatsApp HTTP API) container. Keep dependencies minimal. Write clean, small modules.

Dependency notes:
- better-sqlite3 13.x (requires Node >= 22) bundles prebuilt binaries for linux/darwin/win32 x64/arm64 and loads them when nothing was compiled, so its install script (npm's implicit `node-gyp rebuild`) is NOT approved in "allowScripts" (npm 11 blocks dependency install scripts by default). Do not approve packages unless needed, and never disable script blocking globally.
- The Docker image installs npm 11.19.0 (node:22 ships npm 10, which ignores allowScripts) and fails the build if better-sqlite3 does not load.

Domain rules:
- There are ~5 client calendars (owned by free Gmail accounts), each shared (See all event details) with one Google service account. The app authenticates as that service account with a JSON key (calendar.readonly scope) and reads each calendar by its calendarId.
- The key comes from GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_SERVICE_ACCOUNT_JSON (exactly one), is mounted read-only in Docker, and is never baked into the image or committed.
- Configuration (closers [{name, email, whatsapp}], clients [{name, calendarId, whatsappGroupId}], reminder offsets, admin users) lives in SQLite, is managed in the admin UI, validated with zod on every write, and is read on every run so edits need no restart. config.json only seeds an empty database on first start (CONFIG_PATH) and is never read again.
- A closer gets reminders for an event ONLY if their email is in the event's attendees list. Match emails case-insensitively.
- Reminder offsets in minutes before start: the defaults are 60, 30, 10, 5 and they are configurable in the admin UI.
- Send one WhatsApp group message per event + offset, tagging ALL matching closers on that event.
- Timezone: store everything in UTC, display times in Asia/Kolkata.
- Rescheduled events must fire fresh reminders. Cancelled events must send nothing more.
- Reliability matters more than features: no duplicate sends, no missed sends, clear logs.

SQLite schema (src/db.ts, created on startup; all times are ISO-8601 UTC text):
- events(event_id, calendar_id, client_name, title, start_utc, end_utc, status, meet_link, attendees_json, updated_at, first_seen_utc); primary key (event_id, calendar_id).
  first_seen_utc means "when the current start_utc was first seen". All event writes go through upsertEvent() in src/sync.ts (used by sync and by the live re-check before sending): it sets first_seen_utc to now on insert or when start_utc changes, and leaves it alone when start_utc is unchanged. (Rows that existed before the column was added got updated_at.) Used to decide whether a reminder was missed (first_seen_utc < due) or we learned of the time too late: offsets due before first_seen_utc are skipped silently (no row, no alert), e.g. a long-booked call moved to start soon. Earlier sent_reminders rows keep the old start_utc in their key, so they never block reminders for the new time.
  status is Google's (confirmed | tentative | cancelled) or "removed" when sync no longer sees a stored future event in the 26h window (rescheduled far ahead, moved, or hard-deleted). Reminders must fire only for confirmed/tentative.
- sent_reminders(event_id, calendar_id, start_utc, offset_min, sent_at, status); unique key (event_id, calendar_id, start_utc, offset_min).
  status is 'sent' (default) or 'missed'. A 'missed' row is written once when an offset is more than 3 minutes past due, the call hasn't started, nothing was recorded, and first_seen_utc < due; it is logged and alerted by email once. Both statuses go into sentKeys, so missed reminders are never retried.
  calendar_id is in the key because one invite can be on several client calendars with the same event_id, and each client group gets its own reminder.
- kv(key, value, updated_at); holds last_successful_sync (set only when every active calendar synced).
- closers(id, name, email UNIQUE lowercased, whatsapp digits, active, created_at, updated_at); clients(id, name, calendar_id UNIQUE, whatsapp_group_id, active, created_at, updated_at); settings(key, value JSON, updated_at; reminder_offsets default [60,30,10,5]); admin_users(email, role, added_by, created_at; the superadmin comes from env and is not stored); admin_sessions(token_hash, email, created_at, expires_at); audit_log(id, at, actor, action, details JSON). Missed-reminder detection uses max(first_seen_utc, the offset's own added-at time); settings stores each offset with its addedAt. kv also holds config_seeded_at (the config.json import runs at most once).
  In reminders.ts, the "already sent" check and the insert must both include calendar_id, and the sentKeys passed to computeDueReminders must be built from event_id + calendar_id + start_utc + offset_min.

## How we work (lead session rules)
- The main session is the lead. It plans, decides, delegates and verifies. It does not write application code itself.
- For each task in PLAN.md: delegate to the coder subagent with a precise brief, then to the reviewer subagent. If the reviewer returns FAIL, send the exact fixes back to the coder. Repeat up to 3 rounds, then stop and report to the user.
- The lead makes all design decisions itself and records each one (decision and one-line reason) in DECISIONS.md. Prefer the conservative option that avoids missed reminders.
- Ask the user ONLY for: credentials or secrets, steps only the user can do (OAuth login, scanning the WhatsApp QR code), changes that contradict PLAN.md or CLAUDE.md, or anything destructive or irreversible. Batch these questions into one message.
- After each task, give the user a 3-line status: done, decisions made, what is next.

Working style: make only the changes I ask for in each step, keep earlier code unless a step says otherwise, and tell me briefly what you did and how to run/test it.
