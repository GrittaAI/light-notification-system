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
