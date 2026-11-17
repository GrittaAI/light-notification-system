# Pushup call reminders

## 1. Overview

This service reads your clients' Google Calendars, works out which closers (sales staff) are invited to each upcoming call, and posts reminders into the client's WhatsApp group, @mentioning those closers.

- By default reminders go out 60, 30, 10 and 5 minutes before the call starts (configurable in the admin UI). One message per call and reminder time, tagging every closer invited to that call.
- A closer is tagged only if their email is on the event's guest list (matched ignoring upper/lower case).
- Rescheduled calls get fresh reminders; cancelled calls get nothing more. Times are shown in IST (Asia/Kolkata).
- If something breaks (calendar sync stale, Google key problem, WhatsApp disconnected) it sends an email alert, and a "RECOVERED" email when it is fixed. Missed reminders are reported once by email.

It runs as two Docker containers: the app, and WAHA (a WhatsApp HTTP API) that holds the WhatsApp login. Closers, clients and reminder times are managed in a web admin UI (section 5).

## 2. Prerequisites

- A Linux server with Docker and the Docker Compose plugin (`docker compose version` must work).
- CPU type. By default `docker-compose.yml` uses `devlikeapro/waha:gows-2026.10.1` (GOWS engine, no browser), which is for amd64 (Intel/AMD). On an ARM machine (Apple Silicon Mac, AWS Graviton, Raspberry Pi), add `WAHA_IMAGE=devlikeapro/waha:gows-arm-2026.10.1` to `.env`. Do not edit `docker-compose.yml`.
- An "ops" WhatsApp account on a phone, which must be a member of every client WhatsApp group. Reminders are posted as this account.
- An SMTP account for alert emails. For Gmail use `smtp.gmail.com`, port `587`, and an App Password (not the normal password). App Passwords require 2-step verification to be turned on for that Google account.

## 3. Google setup

The app reads the calendars as a Google **service account** (a robot account with a JSON key). Do the Google Cloud steps once.

1. In Google Cloud Console create a project and enable the **Google Calendar API** in it.
2. Go to *IAM & Admin > Service Accounts* and create a service account (no roles are needed). Note its email address; it looks like `name@project-id.iam.gserviceaccount.com` and is the `client_email` in the key file.
3. Open the service account > *Keys* > *Add key* > *Create new key* > **JSON**. A `.json` file downloads.
4. On the server, in the project folder, save that file as `secrets/google-service-account.json`:

   ```bash
   mkdir -p secrets
   # copy the downloaded key to secrets/google-service-account.json, then, on the server (Docker):
   sudo chown 1000:1000 secrets/google-service-account.json && sudo chmod 400 secrets/google-service-account.json
   ```

   Create the file **before** running `docker compose up`: if it does not exist, Docker creates a directory named `secrets/google-service-account.json` in its place and the app cannot read it. The file is mounted read-only into the app container, is excluded from git and from the Docker image, and must never be shared.
5. Each client shares their calendar with the service account's `client_email`, with permission **See all event details**. Send them these steps:
   1. Open Google Calendar on a computer (calendar.google.com).
   2. In the left list under *My calendars*, hover over the calendar, click the three dots > *Settings and sharing*.
   3. Scroll to *Share with specific people or groups* and click *Add people and groups*.
   4. Enter the service account's email address, set the permission to **See all event details**, and click *Send*.

   Each calendar's `calendarId` (set when adding the client in the admin UI) is usually the owner's Gmail address. The admin dashboard shows the service account email with a copy button.

## 4. Configure

On the server, get the project files, then create the files below **before** running `docker compose up`.

```bash
cp .env.example .env
cp config.example.json config.json   # optional: only seeds the first start (see below)
```

Create `config.json` first, even as an empty-ish example: if the file does not exist when you start Docker Compose, Docker creates a directory named `config.json` in its place (harmless now: the app logs that there is nothing to import and starts empty, but remove it with `sudo rmdir config.json` if you want a clean tree). The same applies to `secrets/google-service-account.json` (section 3), which is required.

### .env

| Variable | Required | Meaning |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | one of two | Path to the service account JSON key (`secrets/google-service-account.json`). Docker Compose overrides it to the mounted path `/run/secrets/google-service-account.json` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | one of two | The JSON key contents on one line, instead of a file. Set exactly one of the two variables; both or neither stops the app at start. Not usable with Docker Compose: compose always sets `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, so setting this in `.env` too makes the app stop with "set only one". With Docker, use the key file |
| `WAHA_URL` | yes | Leave as `http://waha:3000`. Compose overrides it for the app anyway; use `http://127.0.0.1:3000` only when running outside Docker |
| `WAHA_SESSION` | yes | Keep it as `default`. The free WAHA version only supports a session named `default` |
| `WAHA_API_KEY` | yes | A long random secret. Used by WAHA and by the app to talk to it |
| `WAHA_DASHBOARD_USERNAME` | no | WAHA dashboard login (default `admin`) |
| `WAHA_IMAGE` | no | WAHA Docker image. Default is the pinned amd64 GOWS image `devlikeapro/waha:gows-2026.10.1`. On ARM (Apple Silicon Mac, ARM server) set `devlikeapro/waha:gows-arm-2026.10.1` |
| `WAHA_DASHBOARD_PASSWORD` | yes | WAHA dashboard password. Choose your own |
| `ALERT_EMAIL_TO` | yes | Where alert emails are sent |
| `SMTP_HOST`, `SMTP_PORT` | yes | Mail server, e.g. `smtp.gmail.com` and `587` |
| `SMTP_USER`, `SMTP_PASS` | yes | Mail login. For Gmail, `SMTP_PASS` is the App Password |
| `HEALTH_PORT` | no | Port of the internal health endpoint (default `8080`, not published outside Docker) |
| `DB_PATH` | no | SQLite file path (default `data/app.db`; Docker keeps it on a volume) |
| `SUPERADMIN_EMAIL` | yes | Email of the superadmin of the admin UI (always allowed to sign in; manages other admins) |
| `ADMIN_PASSWORD` | one of two | Password for the superadmin (at least 12 characters; generate with `openssl rand -base64 18`) |
| `GOOGLE_OAUTH_CLIENT_ID` | one of two | Google Web OAuth client ID to enable "Sign in with Google" (see "Admin UI"). At least one of `ADMIN_PASSWORD` / `GOOGLE_OAUTH_CLIENT_ID` is required |
| `ADMIN_PORT` | no | Admin UI port (default `8081`). Under Docker Compose it is the host port, published on `127.0.0.1` only |
| `ADMIN_HOST` | no | Interface the admin server binds to (default `127.0.0.1`; compose sets `0.0.0.0` inside the container) |
| `ADMIN_COOKIE_SECURE` | no | `true` when the UI is served over HTTPS: marks the session cookie `Secure` (default `false`) |
| `ADMIN_TRUST_PROXY` | no | `true` behind a reverse proxy you control: the login rate limit uses the last `X-Forwarded-For` entry (the last hop: the address your proxy saw; earlier entries are client-controlled) (default `false`) |
| `CONFIG_PATH` | no | First-start import only: path to config.json (default `config.json`). Do not change it when using Docker (the file is mounted at /app/config.json) |
| `LOG_LEVEL` | no | Log verbosity (default `info`) |
| `SERVICE_ROLE` | no | `reminders` (default: call reminders) or `tasks` (Nudge). The `nudge` compose service sets `tasks` itself. The `tasks` role does not need the Google key |
| `TASKS_PUBLIC_URL` | no | Nudge only: public base URL, e.g. `https://nudge.grittaai.com`. Used for the links in WhatsApp messages (`<url>/#/t/<id>`, `<url>/#/my`). Unset: messages carry no links |
| `APP_NAME` | no | Nudge only: product name in the sign-in email subject (default `Nudge`) |
| `TASKS_PORT` / `TASKS_HEALTH_PORT` | no | Nudge only: host port of the Nudge server (default `8082`, published on `127.0.0.1`) and the in-container health port (default `8083`) |

> **Warning:** Do not `export WAHA_API_KEY` (or put it in your shell profile). A value exported in the shell overrides `.env` for the `waha` container but not for the app. The two keys then differ and every send fails with 401. Keep the key only in `.env`.

### Configuration lives in the database

Closers, clients, the reminder times and admin users are stored in SQLite and edited in the admin UI (section 5). The jobs read them on every run, so changes apply without a restart, and every edit is validated before it is saved.

`config.json` is now an **import-only seed**. On startup, if there are no closers and no clients yet and `config.json` exists and is valid, it is imported once (and logged). After that it is never read again; editing it has no effect. A missing or invalid file is logged and the app starts empty. The format is the same as before:

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

- Closer `email` must be the address the closer is invited with. `whatsapp` is the international number with country code (a leading `+`, spaces and dashes are allowed), e.g. `+91 98765 43210`. A number without the country code will not tag the right person.
- Client `calendarId` is the calendar owner's Gmail address; `whatsappGroupId` ends in `@g.us`. Emails and calendar IDs must not be duplicated.

## 5. Start, link WhatsApp and use the admin UI

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

The login is kept on a Docker volume, so restarts normally do not need a re-scan. Switching WAHA engines (for example from the old WEBJS image to GOWS) needs a new QR scan, because sessions are not shared between engines.

### Admin UI

After `docker compose up -d --build` the admin UI is at http://127.0.0.1:8081 (`ADMIN_PORT`; published on the server's localhost only, so use an SSH tunnel `ssh -L 8081:127.0.0.1:8081 user@server`, or put HTTPS in front, below).

**First login.** Sign in with `SUPERADMIN_EMAIL` and `ADMIN_PASSWORD` (superadmin only), or with Google if configured. Then:

1. *Clients*: add each client calendar (calendar ID, WhatsApp group chosen from the list, or typed as `...@g.us`). Use *Send test message* to check the group.
2. *Closers*: add each closer (name, email as invited, WhatsApp number with country code).
3. *Reminder settings*: change the offsets if you do not want 60/30/10/5 (whole minutes 1-1440, at most 10). An offset added later never raises "missed" alerts for calls already known.
4. *Dashboard*: health, WAHA status, per-calendar sync status, the service account email to share calendars with, upcoming calls with matched closers and recent reminders.

*Disable* keeps a closer or client (and history) but stops reminders; *Delete* removes it for good. Every change is recorded in the *Audit log*.

**Adding admins.** The superadmin opens *Admins* and adds a Google account email. Admins sign in with Google, can manage closers, clients and settings, and cannot manage other admins. Removing an admin signs them out at once. The superadmin comes from `.env` and cannot be removed.

**Google login setup (optional).**

1. Google Cloud Console > *APIs & Services* > *OAuth consent screen*: choose **Internal** (Google Workspace only) or **External** (add the admins as test users while the app is in Testing).
2. *Credentials* > *Create credentials* > *OAuth client ID* > **Web application**. Add *Authorised JavaScript origins*, e.g. `https://admin.example.com` and `http://localhost:8081`. No redirect URI is needed.
3. Put the client ID in `.env` as `GOOGLE_OAUTH_CLIENT_ID`, then `docker compose up -d`. Google sign-in only works from an HTTPS origin (or localhost) that is in the authorised list.

**HTTPS with Caddy.** Point a DNS name at the server and use this `Caddyfile`; Caddy gets the certificate automatically:

```
admin.example.com {
    reverse_proxy 127.0.0.1:8081
}
```

Set `ADMIN_COOKIE_SECURE=true` and `ADMIN_TRUST_PROXY=true` in `.env` (only because Caddy sets `X-Forwarded-For`), then `docker compose up -d`. With `ADMIN_COOKIE_SECURE=true` the app also sends `Strict-Transport-Security: max-age=31536000`. Keep port 8081 closed to the internet (compose already binds it to 127.0.0.1).

### Nudge (tasks, preview)

Nudge is a second product in this repo: personal task lists with WhatsApp nudges 10 minutes before a task is due and every 10 minutes until it is done or snoozed (one batched message per person). It runs as its own container (`nudge`, `SERVICE_ROLE=tasks`) from the same image and the same SQLite file as the call reminders, so a crash or restart of one never stops the other. This release is the **backend and API only**; `/` serves a placeholder page until the app (PWA) is built.

- **Containers.** `docker compose up -d --build` starts `waha`, `app` (call reminders, admin console on 8081) and `nudge` (API + nudge job on `127.0.0.1:8082`, health on its own port 8083). `nudge` needs the WAHA, SMTP and `SUPERADMIN_EMAIL` settings but not the Google key. Both containers share the `app-data` volume.
- **People.** The `people` table (email, name, WhatsApp number, role `admin` or `member`, notification target) replaces the old admin list; existing admins are copied over on first start (name = the part of the email before `@`). `/api/admins` in the call-reminder console keeps working and is backed by `people`. Removing an admin there makes them a member (their tasks stay).
- **Login methods (Nudge).** Email code: `POST /api/auth/email-code {email}` mails a 6-digit code (10 minutes, 5 attempts, 3 codes per email and 10 requests per IP per 15 minutes; the answer is the same for unknown emails), then `POST /api/auth/email-code/verify {email, code}`. Google Sign-In for active people when `GOOGLE_OAUTH_CLIENT_ID` is set. The superadmin can still use the password. Members stay signed in for 30 days (extended when used); admins and the superadmin for 12 hours. Nudge uses its own cookie `nudge_session`; a call-reminder console session is never valid in Nudge, or the other way round.
- **API.** Members use `/api/me` and `/api/app/*` (owners, tasks sync pull `GET /api/app/tasks?since=`, `PUT /api/app/tasks/:id` with `baseVersion`, `done`, `reopen`, `snooze`, `unsnooze`, `DELETE`, activity). Admins also get `/api/people`, `/api/access-grants` and `/api/task-settings` (default group, lead and repeat minutes, quiet hours). Every call is checked against the access rules: owners edit their own list, admins edit all, other members only what an access grant gives them.
- **Where nudges go.** The default WhatsApp group from the task settings (tagging the person by number), or per person another group or a direct message. A person with no usable target (no group set, or no WhatsApp number) is skipped and logged at most once an hour. WAHA is an unofficial WhatsApp client: a dedicated number for these messages is recommended.
- **HTTPS with Caddy.** Put Nudge on its own host next to the reminders console. Use the compose service name or the published port:

```
reminders.grittaai.com {
    reverse_proxy 127.0.0.1:8081
}
nudge.grittaai.com {
    reverse_proxy 127.0.0.1:8082
}
```

  If Caddy itself runs in the same compose project, use `reverse_proxy nudge:8082` (the container's network alias). Set `TASKS_PUBLIC_URL=https://nudge.grittaai.com`, and `ADMIN_COOKIE_SECURE=true` / `ADMIN_TRUST_PROXY=true` as above (both products read them).

## 6. Finding group IDs

The admin UI lists your WhatsApp groups in the client form. To look them up by hand, with the tunnel from section 5 open, list the groups of the session (replace YOUR_WAHA_API_KEY with the value from .env):

```bash
curl -s -H "X-Api-Key: YOUR_WAHA_API_KEY" \
  "http://127.0.0.1:3000/api/default/groups?exclude=participants"
```

Find the group by its name; its `id` ends in `@g.us` (for example `120363000000000001@g.us`). Enter it as the client's WhatsApp group in the admin UI. The ops WhatsApp account must be a member of the group. If `id` is shown as an object, use its `_serialized` value (it ends in `@g.us`).

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
2. In the admin UI add a temporary client pointing at a test calendar and this test group (use *Send test message*). Make sure a closer has your test email/number. The test calendar must be shared with the service account (section 3, step 5).
3. In that calendar, create an event starting about 15 minutes from now with that closer as a guest.
4. Expect the 10-minute and 5-minute reminders in the test group, tagging the closer. (The 60 and 30 minute ones are skipped silently because the event was created too late.)
5. Delete or disable the temporary client in the admin UI.

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
| `ALERT: calendar sync is stale` | No fully successful sync for over 10 minutes; reminders may be missed. The email lists which calendars failed | Read `docker compose logs app`. Common causes: a calendar not shared with the service account, a revoked Google key, or a database error (see the app logs) |
| `ALERT: Google authorization expired or revoked (invalid_grant)` | Google rejected the service account key (deleted, revoked, or the server clock is wrong); nothing can sync | Create a new JSON key for the service account, replace `secrets/google-service-account.json` (same owner and mode as in section 3), then `docker compose restart app`. Check the server clock (`timedatectl`) |
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

Upgrading WAHA: change the pinned default tag in `docker-compose.yml` (`gows-<version>`) and, if you use it, the `gows-arm-<version>` tag in `WAHA_IMAGE` in `.env`. Keep both at the same version. Then

```bash
docker compose pull waha && docker compose up -d waha
```

An upgrade may require re-scanning the QR code. Repeat the section 8 test afterwards.

Updating the app: pull the new files, then `docker compose up -d --build`.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Calendar X is not shared with the service account ... (See all event details)` | The calendar is not shared with the service account (404/403), or `calendarId` is wrong | Have the calendar owner share it with that email using *See all event details* (section 3, step 5); check the client's calendar ID in the admin UI |
| `invalid_grant` | The service account key was deleted or revoked, or the server clock is wrong | Create a new JSON key, replace `secrets/google-service-account.json`, `docker compose restart app`; check the server clock |
| `invalid_client` | The service account key is invalid or damaged | Download a fresh JSON key and replace the file |
| `accessNotConfigured` (403), hint "enable the Google Calendar API" | The Calendar API is not enabled in the service account's project | Enable the Google Calendar API in that project (section 3, step 1); wait a minute |
| App fails at start: `GOOGLE_SERVICE_ACCOUNT_KEY_FILE ... is a directory` | `docker compose up` was run before `secrets/google-service-account.json` existed, so Docker created a folder | `docker compose down`, `sudo rmdir secrets/google-service-account.json`, save the real key file there (section 3), `docker compose up -d` |
| App fails at start about the Google key (not valid JSON, missing `client_email` / `private_key`, "set only one" / "set one of") | Wrong or damaged key file, or both/neither of the two key variables set | Re-download the JSON key; set exactly one of `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` / `GOOGLE_SERVICE_ACCOUNT_JSON`; under Docker Compose, remove `GOOGLE_SERVICE_ACCOUNT_JSON` from `.env` |
| `no matching manifest for linux/arm64/v8` | amd64 WAHA image on an ARM machine | Set `WAHA_IMAGE=devlikeapro/waha:gows-arm-2026.10.1` in `.env`, then `docker compose up -d waha` |
| Session `FAILED` with `Waiting failed: 30000ms exceeded` in `docker compose logs waha` | WEBJS (browser) engine image in use | Use the GOWS image: unset `WAHA_IMAGE` on amd64, or set it to `devlikeapro/waha:gows-arm-2026.10.1` on ARM; `docker compose up -d waha`; delete the failed session and start a new `default` session, then scan the QR |
| 401 from WAHA when sending | `WAHA_API_KEY` differs between the waha container and the app (often a key exported in the shell) | `unset WAHA_API_KEY` in the shell, make sure `.env` has the only copy, then `docker compose up -d --force-recreate` |
| WAHA status `SCAN_QR_CODE` | WhatsApp was logged out or never linked | Open the dashboard through the tunnel and scan the QR code |
| Log says no config.json import / config.json is a directory | `config.json` is only a first-start seed; it was missing (Docker may have created a folder) or invalid | Harmless: add closers and clients in the admin UI. To clean up: `docker compose down`, `sudo rmdir config.json` |
| App does not start: `invalid environment` mentioning `SUPERADMIN_EMAIL` / `ADMIN_PASSWORD` | Missing superadmin email, password shorter than 12 characters, or neither `ADMIN_PASSWORD` nor `GOOGLE_OAUTH_CLIENT_ID` set | Fix `.env` (section 4) |
| Admin UI not reachable / Google button missing or fails | Port 8081 is bound to localhost only; the origin is not in the OAuth client's authorised JavaScript origins; or HTTPS is missing | Use an SSH tunnel or Caddy (section 5); add the exact origin in Google Cloud |
| Google login says "not authorised" | The Google account is not the superadmin and not in *Admins* | The superadmin adds the email under *Admins* |
| Login returns 429 | 5 failed password attempts from one address in 15 minutes | Wait 15 minutes. Behind Caddy make sure `ADMIN_TRUST_PROXY=true` so the real client address is used |
| No reminder for a call | The closer's email is not on the event's guest list, or differs from the closer's email in the admin UI (alias, different address) | Add the closer as a guest using the exact email shown under *Closers*; check with `docker compose exec app node dist/sync-once.js` which attendees were seen |
| Reminder sent but closer not tagged / wrong person | `whatsapp` number missing country code or wrong | Use the full international number, e.g. `+919876543210` |
| Message not posted to a group | Wrong WhatsApp group, or the ops account is not in the group | Use *Send test message* on the client; re-check the group (section 6) and membership |

## 11. Known limitations

- Rarely, a reminder can be sent twice: if WAHA delivers a message but the reply times out, the app does not know it was sent and tries again.
- If WAHA is down for longer than the 3-minute grace window after a reminder is due, that reminder is not sent late. It is recorded as missed and you get an email.
- A reminder is not sent if the app only learned of the call's (new) start time after the reminder was due, for example a long-booked call moved to start soon. This is silent by design.
- Just before sending, the app re-checks the event with Google and skips the reminder if the call was cancelled or moved. Other changes (for example a closer removed from the guest list) are only picked up by the 2-minute sync, so a change made within about 2 minutes of a reminder may not be reflected. If the re-check itself fails, the reminder is sent from the last synced data.

## 12. Development

```bash
npm install
cp .env.example .env
cp config.example.json config.json   # optional first-start seed
# put the service account key at secrets/google-service-account.json (section 3, steps 1-4);
# for local runs keep it owned by your own user: chmod 600 secrets/google-service-account.json
# (the chown 1000:1000 / chmod 400 step is for the Docker server only)
```

| Command | What it does |
|---|---|
| `npm run dev` | Run the service with auto-reload |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run sync:once` | Sync once and print the upcoming events stored (times in IST) |
| `npm test` | Run unit tests (vitest) |

Set `SUPERADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`; the admin UI is then at http://localhost:8081. The service syncs at startup and then every 2 minutes. The Docker build uses better-sqlite3's bundled prebuilt binary and fails early if it does not load. In the container, use `node dist/sync-once.js` instead of `npm run sync:once` (the production image has no dev tools).
