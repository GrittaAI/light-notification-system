// The two products run from one codebase, one process each (SERVICE_ROLE):
//   reminders: call reminders (sync, reminders, monitor jobs, health server, admin console)
//   tasks:     Nudge (HTTP server with API + PWA, nudge job, its own health server)
// Each role starts ONLY its own jobs and servers. A crash or load in one cannot reach the other.

import type http from 'node:http';
import type { calendar_v3 } from 'googleapis';
import type { Mailer } from './admin/auth.js';
import { startAdminServer } from './admin/server.js';
import type { Alerts } from './alerts.js';
import { configPath, type Env } from './config.js';
import type { DB } from './db.js';
import { createEventFetcher } from './google.js';
import { startHealthServer } from './health.js';
import { logger } from './logger.js';
import { runMonitor } from './monitor.js';
import { startNudgeServer } from './nudge/server.js';
import { type NudgeTracker, startNudgeHealthServer } from './nudge/health.js';
import { runReminders } from './reminders.js';
import { logStartupSummary } from './startup.js';
import { loadRuntimeConfig, seedFromConfigFile } from './store.js';
import { runSync, type SyncResult } from './sync.js';
import { runTaskNudges } from './tasks/nudges.js';
import type { WhatsApp } from './whatsapp.js';

export const SYNC_SCHEDULE = '*/2 * * * *'; // every 2 minutes
export const REMINDER_SCHEDULE = '* * * * *'; // every minute
export const MONITOR_SCHEDULE = '* * * * *'; // every minute
export const NUDGE_SCHEDULE = '* * * * *'; // every minute

/** node-cron's schedule(), injectable so tests can see which jobs a role registers. */
export type Schedule = (expression: string, job: () => unknown) => { stop(): unknown };

/** Wraps a job so a slow run is never overlapped by the next tick; errors are logged, never thrown. */
export function guarded(name: string, job: () => Promise<unknown>) {
  let running: Promise<unknown> | undefined;
  const tick = async (trigger: string) => {
    if (running) {
      logger.warn(`previous ${name} run still running; skipping tick`, { trigger });
      return;
    }
    running = job()
      .catch((err) => logger.error(`${name} crashed`, { trigger, err }))
      .finally(() => { running = undefined; });
    await running;
  };
  return { tick, idle: () => running };
}

export interface ServiceHandle {
  role: 'reminders' | 'tasks';
  /** Names of the scheduled jobs this role started. */
  jobs: string[];
  servers: http.Server[];
  /** Stops the schedules, waits for running jobs and closes the servers (does not close the database). */
  stop(): Promise<void>;
}

function closeServers(servers: http.Server[]): Promise<unknown> {
  return Promise.all(
    servers.map((server) => new Promise<void>((resolve) => {
      // A server that never started listening has nothing to close.
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    })),
  );
}

// ---------- reminders ----------

export interface RemindersDeps {
  db: DB;
  whatsapp: WhatsApp;
  alerts: Alerts;
  calendar: calendar_v3.Calendar;
  clientEmail: string;
  schedule: Schedule;
}

export async function startRemindersService(env: Env, deps: RemindersDeps): Promise<ServiceHandle> {
  const { db, whatsapp, alerts, calendar, clientEmail, schedule } = deps;

  // First start only: import config.json into the empty tables. Never read again afterwards.
  seedFromConfigFile(db, configPath());
  const runtime = loadRuntimeConfig(db);
  logger.info('configuration loaded from database', {
    closers: runtime.closers.length, clients: runtime.clients.length, offsets: runtime.offsets,
  });

  const startedAt = new Date();
  let lastSyncResult: SyncResult | undefined;
  const getLastSyncResult = () => lastSyncResult;

  // Up before the startup sync so Docker can probe during startup.
  const healthServer = startHealthServer(db, whatsapp, env.HEALTH_PORT);
  const adminServer = startAdminServer(
    { db, env, whatsapp, getLastSyncResult, serviceAccountEmail: clientEmail },
    env.ADMIN_PORT,
    env.ADMIN_HOST,
  );

  const fetchEvent = createEventFetcher(calendar);
  const sync = guarded('sync', async () => { lastSyncResult = await runSync(db, calendar, { serviceAccountEmail: clientEmail }); });
  const reminders = guarded('reminders', () => runReminders(db, { whatsapp, fetchEvent, alerts }));
  const monitor = guarded('monitor', () => runMonitor({ db, whatsapp, alerts, getLastSyncResult, startedAt }));

  await sync.tick('startup');
  await reminders.tick('startup');
  await monitor.tick('startup');
  try {
    await logStartupSummary(getLastSyncResult, whatsapp);
  } catch (err) {
    logger.error('startup check failed', { err });
  }

  const tasks = [
    schedule(SYNC_SCHEDULE, () => sync.tick('cron')),
    schedule(REMINDER_SCHEDULE, () => reminders.tick('cron')),
    schedule(MONITOR_SCHEDULE, () => monitor.tick('cron')),
  ];
  logger.info('jobs scheduled', { sync: SYNC_SCHEDULE, reminders: REMINDER_SCHEDULE, monitor: MONITOR_SCHEDULE });

  return {
    role: 'reminders',
    jobs: ['sync', 'reminders', 'monitor'],
    servers: [healthServer, adminServer],
    async stop() {
      await Promise.all(tasks.map((t) => t.stop()));
      await Promise.all([sync.idle(), reminders.idle(), monitor.idle()]);
      await closeServers([healthServer, adminServer]);
    },
  };
}

// ---------- tasks (Nudge) ----------

export interface TasksDeps {
  db: DB;
  whatsapp: WhatsApp;
  mailer: Mailer;
  schedule: Schedule;
  verifyIdToken?: Parameters<typeof startNudgeServer>[0]['verifyIdToken'];
}

export async function startTasksService(env: Env, deps: TasksDeps): Promise<ServiceHandle> {
  const { db, whatsapp, mailer, schedule } = deps;
  const tracker: NudgeTracker = {};

  const healthServer = startNudgeHealthServer(whatsapp, tracker, env.TASKS_HEALTH_PORT);
  const nudgeServer = startNudgeServer(
    { db, env, mailer, whatsapp, appName: env.APP_NAME, verifyIdToken: deps.verifyIdToken },
    env.TASKS_PORT,
    env.TASKS_HOST,
  );

  const nudges = guarded('task-nudges', async () => {
    const result = await runTaskNudges(db, { whatsapp, appName: env.APP_NAME });
    tracker.lastRunAt = new Date();
    tracker.lastRunOk = result.ok;
  });
  await nudges.tick('startup');
  const task = schedule(NUDGE_SCHEDULE, () => nudges.tick('cron'));
  logger.info('nudge job scheduled', { schedule: NUDGE_SCHEDULE, app: env.APP_NAME });

  return {
    role: 'tasks',
    jobs: ['task-nudges'],
    servers: [healthServer, nudgeServer],
    async stop() {
      await task.stop();
      await nudges.idle();
      await closeServers([healthServer, nudgeServer]);
    },
  };
}
