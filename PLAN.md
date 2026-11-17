# Plan

## Done (before this plan)
- Scaffold, config.json + .env validation (zod), SQLite schema (events, sent_reminders, kv).
- Google OAuth script (`npm run auth`), Calendar client, sync job every 2 min.
- Dockerfile (Node 22; not yet built because Docker is not installed on the dev Mac).
- Reminder job every minute, WAHA client, live re-check before sending, missed-reminder logging + email alert, reschedule handling via first_seen_utc.

## Tasks (all done 2026-11-15; each passed the reviewer)
1. **docker-compose.yml**: app + WAHA containers; volumes for SQLite data, WAHA session and config.json; env_file; restart policy; WAHA API key; log rotation.
2. **Health endpoint**: `GET /health` on a local port, reporting last_successful_sync age and WAHA session status; used as the Docker healthcheck.
3. **Operational alerts** (rate-limited email): sync stale > 10 min, Google `invalid_grant`, WAHA session not WORKING. (A reminder that keeps failing until its grace window closes is already covered: it becomes a 'missed' row and is alerted.)
4. **Startup checks**: WAHA reachable and session WORKING, each calendar readable; log a clear one-line summary, alert via task 3, keep running.
5. **README runbook**: OAuth, WhatsApp QR scan, finding group IDs, config, deploy, end-to-end test.

## Later change (user request, 2026-11-15)
- Google auth switched from the OAuth refresh token (`npm run auth`) to a service account JSON key. The OAuth items above are historical; see DECISIONS.md "Service account switch".

## Admin front end (user request, 2026-11-15, deploy today)
6. **Admin UI + API** (done 2026-11-15, passed review round 2; WhatsApp group list verified live against WAHA): closers, clients, reminder offsets and admin users managed in a web UI backed by SQLite (config.json only seeds the first start). Login: superadmin password from .env now; Google Sign-In when GOOGLE_OAUTH_CLIENT_ID is set. Status page, WhatsApp group picker, test message, audit log.
7. **Deploy** to the user's server (needs host/domain from the user).
8. **WhatsApp page in the admin UI** (done 2026-11-15, passed review round 2; read-only endpoints verified live against WAHA): status + linked number, QR code to link, log out / switch number, restart/start session, pairing code if GOWS supports it. Superadmin only, audited. Starts after the UI redesign review.

## Tasks product "Nudge" (separate product at nudge.grittaai.com, same codebase/server; user request 2026-11-17)
Mobile-first, offline-capable PWA where every person has their own task page; WhatsApp nudges 10 min before due and every 10 min until done/snoozed, batched per person; admin-controlled access to other people's lists.
9.  **Phase 1, backend** (done 2026-11-17, passed review round 2; call reminders verified unaffected): people directory (replaces admin_users), member login (email one-time code via existing SMTP; Google when configured), roles + access grants, tasks API (sync-friendly, offline-safe), task nudge engine (lead/repeat, per-person digest, snooze, done), task links in messages.
10. **Phase 2, PWA** (done 2026-11-17, passed review round 3): mobile-first app at nudge.grittaai.com/ (My tasks, person switcher, task page with status/priority/due/notes/checklist/activity, quick add, done/snooze), installable, offline (service worker + IndexedDB + outbox sync).
11. **Phase 3, admin (inside Nudge)** (done 2026-11-17, passed final review round 3): People & roles, access rules (who can view/edit whose list), task notification settings (default group, per-person target, lead/repeat, quiet hours), audit.
12. **Phase 4, WhatsApp replies** (optional): reply "done 2" / "snooze 2 1h" in WhatsApp via WAHA webhook, authorised by sender number.

13. **Deploy Nudge** to nudge.grittaai.com on the existing EC2 instance (second container, behind the n8n Caddy).
14. **Polish backlog**: single toast stack so an error never overlaps a standing update prompt + Undo (rare visual overlap; accepted at Phase 3 sign-off).
