# Pushup call reminders

## 1. Overview

This service reads your clients' Google Calendars, works out which closers (sales staff) are invited to each upcoming call, and posts reminders into the client's WhatsApp group, @mentioning those closers.

- Reminders go out 60, 30, 10 and 5 minutes before the call starts. One message per call and reminder time, tagging every closer invited to that call.
- A closer is tagged only if their email is on the event's guest list (matched ignoring upper/lower case).
- Rescheduled calls get fresh reminders; cancelled calls get nothing more. Times are shown in IST (Asia/Kolkata).
- If something breaks (calendar sync stale, Google login expired, WhatsApp disconnected) it sends an email alert, and a "RECOVERED" email when it is fixed. Missed reminders are reported once by email.

It runs as two Docker containers: the app, and WAHA (a WhatsApp HTTP API) that holds the WhatsApp login.

## 2. Prerequisites

- A Linux server with Docker and the Docker Compose plugin (`docker compose version` must work).
- CPU type. `docker-compose.yml` pins `devlikeapro/waha:latest-2026.10.1`, which is for amd64 (Intel/AMD). On an ARM server (e.g. AWS Graviton, Raspberry Pi), edit `docker-compose.yml` and change that image to `devlikeapro/waha:arm-2026.10.1`.
- A laptop with Node.js 22 for the one-time Google login step (it needs a web browser).
- An "ops" WhatsApp account on a phone, which must be a member of every client WhatsApp group. Reminders are posted as this account.
- An SMTP account for alert emails. For Gmail use `smtp.gmail.com`, port `587`, and an App Password (not the normal password). App Passwords require 2-step verification to be turned on for that Google account.

## 3. Google setup

Do the Google Cloud steps once.

1. In Google Cloud Console create a project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen, then set its publishing status to **In production**.

   > **Important:** While the consent screen is in "Testing", Google expires the refresh token after about 7 days and syncing stops with an `invalid_grant` error.
   > (An unverified app in production shows a "Google hasn't verified this app" warning during login. That is fine for this internal use: click *Advanced > Go to app*.)
3. Create an OAuth client of type **Desktop app**. Note its client ID and secret.
4. Share each client calendar with the ops Gmail (at least "See all event details"). Each calendar's `calendarId` in `config.json` is usually the owner's Gmail address.
5. On your laptop (not the server), in a copy of this project:

   ```bash
   npm install
   cp .env.example .env     # fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
   npm run auth
   ```

   Open the printed URL, sign in as the **ops Gmail**, and approve. The terminal prints a `GOOGLE_REFRESH_TOKEN=...` line. Copy that line into the `.env` file on the server.

## 4. Configure

On the server, get the project files, then create both files below **before** running `docker compose up`.

```bash
cp .env.example .env
cp config.example.json config.json
```

Create `config.json` first: if the file does not exist when you start Docker Compose, Docker creates a directory named `config.json` in its place and the app cannot read it.

### .env

| Variable | Required | Meaning |
|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID (Desktop app) from Google Cloud |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | yes | Printed by `npm run auth` |
| `WAHA_URL` | yes | Leave as `http://waha:3000`. Compose overrides it for the app anyway; use `http://127.0.0.1:3000` only when running outside Docker |
| `WAHA_SESSION` | yes | Keep it as `default`. The free WAHA version only supports a session named `default` |
| `WAHA_API_KEY` | yes | A long random secret. Used by WAHA and by the app to talk to it |
| `WAHA_DASHBOARD_USERNAME` | no | WAHA dashboard login (default `admin`) |
| `WAHA_DASHBOARD_PASSWORD` | yes | WAHA dashboard password. Choose your own |
| `ALERT_EMAIL_TO` | yes | Where alert emails are sent |
| `SMTP_HOST`, `SMTP_PORT` | yes | Mail server, e.g. `smtp.gmail.com` and `587` |
| `SMTP_USER`, `SMTP_PASS` | yes | Mail login. For Gmail, `SMTP_PASS` is the App Password |
| `HEALTH_PORT` | no | Port of the internal health endpoint (default `8080`, not published outside Docker) |
| `DB_PATH` | no | SQLite file path (default `data/app.db`; Docker keeps it on a volume) |
| `CONFIG_PATH` | no | Path to config.json (default `config.json`). Do not change it when using Docker (the file is mounted at /app/config.json) |
| `LOG_LEVEL` | no | Log verbosity (default `info`) |

> **Warning:** Do not `export WAHA_API_KEY` (or put it in your shell profile). A value exported in the shell overrides `.env` for the `waha` container but not for the app. The two keys then differ and every send fails with 401. Keep the key only in `.env`.

### config.json

```json
{
  "closers": [
    { "name": "Closer One", "email": "closer.one@example.com", "whatsapp": "+919000000001" }
  ],
  "clients": [
    { "name": "Client A", "calendarId": "client.a@gmail.com", "whatsappGroupId": "120363000000000001@g.us" }
  ]
}
```

- `closers`: `email` must be the address the closer is invited with. `whatsapp` is the international number with country code (a leading `+`, spaces and dashes are allowed), e.g. `+91 98765 43210`. A number without the country code will not tag the right person.
- `clients`: one entry per client calendar. `calendarId` is the calendar owner's Gmail address; `whatsappGroupId` ends in `@g.us` (see section 6). At least one client is required.
- Emails and calendar IDs must not be duplicated.

`config.json` is re-read on every sync (every 2 minutes), so edits apply without a restart. If an edit breaks the file, the error is logged and the last valid config keeps being used. If config.json is invalid when the app starts or restarts, the app does not start: check `docker compose logs app` for the error.

## 5. Start and link WhatsApp

```bash
docker compose up -d --build
```

The WAHA dashboard is published on the server's localhost only, so use an SSH tunnel from your laptop:

```bash
ssh -L 3000:127.0.0.1:3000 user@server
```

Leave that running, then on the laptop:

1. Open http://127.0.0.1:3000 (the dashboard is at `/dashboard`). Log in with `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`. If the dashboard asks for an API key, enter `WAHA_API_KEY`.
2. Start the session named **default** (the `WAHA_SESSION` value). If it is listed as stopped, start it.
3. When its status shows `SCAN_QR_CODE`, scan the QR code with the ops phone: WhatsApp > Linked devices > Link a device. The QR code refreshes every ~20 seconds; if it expires, the session fails and you restart it.
4. Wait until the status is `WORKING`.

The login is kept on a Docker volume, so restarts normally do not need a re-scan.

## 6. Finding group IDs

With the tunnel from section 5 open, list the groups of the session (replace YOUR_WAHA_API_KEY with the value from .env):

```bash
curl -s -H "X-Api-Key: YOUR_WAHA_API_KEY" \
  "http://127.0.0.1:3000/api/default/groups?exclude=participants"
```

Find the group by its name; its `id` ends in `@g.us` (for example `120363000000000001@g.us`). Put it in `config.json` as `clients[].whatsappGroupId`. The ops WhatsApp account must be a member of the group. If `id` is shown as an object, use its `_serialized` value (it ends in `@g.us`).

## 7. Verify

```bash
docker compose ps                                  # app should become "healthy" (allow ~3 minutes)
docker compose restart app                         # once, after linking WhatsApp in section 5
docker compose logs app | grep "startup check"     # expect "ok":true (the latest line)
docker compose exec app node dist/sync-once.js     # syncs and lists upcoming events (IST)
docker compose exec app node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"
```

`/health` reports `"ok":true` when the last full sync is under 10 minutes old and the WhatsApp session is `WORKING`. If you changed `HEALTH_PORT`, use that port.

## 8. End-to-end test before going live

1. Create a WhatsApp group containing the ops account, and find its ID (section 6).
2. Add a temporary client to `config.json` pointing at a test calendar and this test group. Make sure a closer in `closers` has your test email/number. The test calendar must be shared with the ops Gmail (section 3, step 4).
3. In that calendar, create an event starting about 15 minutes from now with that closer as a guest.
4. Expect the 10-minute and 5-minute reminders in the test group, tagging the closer. (The 60 and 30 minute ones are skipped silently because the event was created too late.)
5. Remove the temporary client from `config.json`.

Alert drill:

1. `docker compose stop waha`. After about 3 minutes you should receive an email "[pushup-reminders] ALERT: WhatsApp session not working (UNREACHABLE)".
2. `docker compose start waha`. When the session is `WORKING` again you should receive "[pushup-reminders] RECOVERED: WhatsApp session working again". (Allow a minute or two for WAHA to restart.)

## 9. Operations

Logs (one JSON object per line):

```bash
docker compose logs -f app
docker compose logs --tail 200 waha
```

Alert emails, and what to do:

| Email subject | Meaning | What to do |
|---|---|---|
| `ALERT: calendar sync is stale` | No fully successful sync for over 10 minutes; reminders may be missed. The email lists which calendars failed | Read `docker compose logs app`. Common causes: a calendar not shared with the ops Gmail, Google login expired, or a broken `config.json` |
| `ALERT: Google authorization expired or revoked (invalid_grant)` | Google rejected the refresh token; nothing can sync | On the laptop run `npm run auth`, put the new `GOOGLE_REFRESH_TOKEN` in the server's `.env`, then `docker compose up -d app`. Check the consent screen is "In production" |
| `ALERT: WhatsApp session not working (...)` | WAHA session not `WORKING` for 3+ minutes | `SCAN_QR_CODE`: open the dashboard through the tunnel and scan the QR code again. `UNREACHABLE`: `docker compose ps` and `docker compose logs waha` |
| `N call reminder(s) missed` | One or more reminders could not be sent in time (more than 3 minutes late) and are not retried | Check what was wrong (usually WhatsApp or sync down); tell the closers manually if the call is still ahead. No RECOVERED email is sent for missed reminders |
| `RECOVERED: ...` | The problem above has cleared | Nothing |

Every subject starts with [pushup-reminders]. Sync, Google and WhatsApp alerts repeat at most once an hour while the problem lasts; missed-reminder emails are sent once.

Backups: the app keeps data in two named volumes, `app-data` (SQLite database) and `waha-sessions` (WhatsApp login). Find the exact names with `docker volume ls` (they are prefixed with the project folder name). Example, run from a backup folder:

```bash
docker compose stop app waha
docker run --rm -v <project>_app-data:/data -v "$PWD":/backup busybox tar czf /backup/app-data.tgz -C /data .
docker run --rm -v <project>_waha-sessions:/data -v "$PWD":/backup busybox tar czf /backup/waha-sessions.tgz -C /data .
docker compose start waha app
```

Run it from the project folder (so docker compose finds docker-compose.yml) and keep the stop short: a reminder due while the app is stopped for more than 3 minutes is recorded as missed.

Losing `waha-sessions` only means scanning the QR code again. Losing `app-data` loses the record of which reminders were already sent.

Upgrading WAHA: change the pinned tag in `docker-compose.yml` (remember the ARM variant), then

```bash
docker compose pull waha && docker compose up -d waha
```

An upgrade may require re-scanning the QR code. Repeat the section 8 test afterwards.

Updating the app: pull the new files, then `docker compose up -d --build`.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_client` in logs or during `npm run auth` | Wrong `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, or the OAuth client is not type Desktop app | Re-copy the values from Google Cloud; recreate the client as Desktop app |
| `invalid_grant` | Refresh token expired or revoked (typically consent screen left in "Testing", or the app access was removed) | Set consent screen to In production, rerun `npm run auth` on the laptop, update `.env`, `docker compose up -d app` |
| 404 / "not found" for one calendar | Calendar not shared with the ops Gmail, or wrong `calendarId` | Share the calendar with the ops Gmail; check `calendarId` in `config.json` |
| 401 from WAHA when sending | `WAHA_API_KEY` differs between the waha container and the app (often a key exported in the shell) | `unset WAHA_API_KEY` in the shell, make sure `.env` has the only copy, then `docker compose up -d --force-recreate` |
| WAHA status `SCAN_QR_CODE` | WhatsApp was logged out or never linked | Open the dashboard through the tunnel and scan the QR code |
| App fails at start, `config.json` is a directory or cannot be read | `docker compose up` was run before `config.json` existed, so Docker created a folder | `docker compose down`, `sudo rmdir config.json`, create the real file, `docker compose up -d` |
| No reminder for a call | The closer's email is not on the event's guest list, or differs from `config.json` (alias, different address) | Add the closer as a guest using the exact email in `config.json`; check with `docker compose exec app node dist/sync-once.js` which attendees were seen |
| Reminder sent but closer not tagged / wrong person | `whatsapp` number missing country code or wrong | Use the full international number, e.g. `+919876543210` |
| Message not posted to a group | Wrong `whatsappGroupId`, or the ops account is not in the group | Re-check the ID (section 6) and group membership |

## 11. Known limitations

- Rarely, a reminder can be sent twice: if WAHA delivers a message but the reply times out, the app does not know it was sent and tries again.
- If WAHA is down for longer than the 3-minute grace window after a reminder is due, that reminder is not sent late. It is recorded as missed and you get an email.
- A reminder is not sent if the app only learned of the call's (new) start time after the reminder was due, for example a long-booked call moved to start soon. This is silent by design.
- Just before sending, the app re-checks the event with Google and skips the reminder if the call was cancelled or moved. Other changes (for example a closer removed from the guest list) are only picked up by the 2-minute sync, so a change made within about 2 minutes of a reminder may not be reflected. If the re-check itself fails, the reminder is sent from the last synced data.

## 12. Development

```bash
npm install
cp .env.example .env
cp config.example.json config.json
```

| Command | What it does |
|---|---|
| `npm run dev` | Run the service with auto-reload |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run auth` | One-time OAuth flow; prints a refresh token |
| `npm run sync:once` | Sync once and print the upcoming events stored (times in IST) |
| `npm test` | Run unit tests (vitest) |

The service syncs at startup and then every 2 minutes. The Docker build uses better-sqlite3's bundled prebuilt binary and fails early if it does not load. In the container, use `node dist/sync-once.js` instead of `npm run sync:once` (the production image has no dev tools).
