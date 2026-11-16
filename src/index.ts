import cron from 'node-cron';
import { configPath, loadEnv } from './config.js';
import { startAdminServer } from './admin/server.js';
import { openDb } from './db.js';
import { startHealthServer } from './health.js';
import { createAlerts } from './alerts.js';
import { createCalendarClient, createEventFetcher } from './google.js';
import { logger } from './logger.js';
import { runReminders } from './reminders.js';
import { runMonitor } from './monitor.js';
import { logStartupSummary } from './startup.js';
import { loadRuntimeConfig, seedFromConfigFile } from './store.js';
import { type SyncResult, runSync } from './sync.js';
import { createWhatsApp } from './whatsapp.js';

const SYNC_SCHEDULE = '*/2 * * * *'; // every 2 minutes
const REMINDER_SCHEDULE = '* * * * *'; // every minute
const MONITOR_SCHEDULE = '* * * * *'; // every minute

/** Wraps a job so a slow run is never overlapped by the next tick; errors are logged, never thrown. */
function guarded(name: string, job: () => Promise<unknown>) {
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

async function main(): Promise<void> {
  const env = loadEnv();
  const db = openDb(env.DB_PATH);
  logger.info('db ready', { path: env.DB_PATH });

  // First start only: import config.json into the empty tables. Never read again afterwards.
  seedFromConfigFile(db, configPath());
  const runtime = loadRuntimeConfig(db);
  logger.info('configuration loaded from database', {
    closers: runtime.closers.length,
    clients: runtime.clients.length,
    offsets: runtime.offsets,
  });

  const whatsapp = createWhatsApp(env);
  const { calendar, clientEmail } = createCalendarClient(env);
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

  const alerts = createAlerts(env);
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
    cron.schedule(SYNC_SCHEDULE, () => sync.tick('cron')),
    cron.schedule(REMINDER_SCHEDULE, () => reminders.tick('cron')),
    cron.schedule(MONITOR_SCHEDULE, () => monitor.tick('cron')),
  ];
  logger.info('jobs scheduled', { sync: SYNC_SCHEDULE, reminders: REMINDER_SCHEDULE, monitor: MONITOR_SCHEDULE });

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    await Promise.all(tasks.map((t) => t.stop()));
    await Promise.all([sync.idle(), reminders.idle(), monitor.idle()]);
    await Promise.all(
      [healthServer, adminServer].map(
        (server) =>
          new Promise<void>((resolve) => {
            // A server that never started listening has nothing to close.
            if (!server.listening) return resolve();
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('startup failed', { err });
  process.exit(1);
});
