import cron from 'node-cron';
import { createAlerts } from './alerts.js';
import { loadEnv } from './config.js';
import { openDb } from './db.js';
import { createCalendarClient } from './google.js';
import { logger } from './logger.js';
import { type ServiceHandle, startRemindersService, startTasksService } from './services.js';
import { createWhatsApp } from './whatsapp.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = openDb(env.DB_PATH);
  logger.info('db ready', { path: env.DB_PATH, role: env.SERVICE_ROLE });

  const whatsapp = createWhatsApp(env);
  const alerts = createAlerts(env);
  const schedule = (expr: string, job: () => unknown) => cron.schedule(expr, job);

  let service: ServiceHandle;
  if (env.SERVICE_ROLE === 'tasks') {
    service = await startTasksService(env, { db, whatsapp, mailer: alerts, schedule });
  } else {
    const { calendar, clientEmail } = createCalendarClient(env);
    service = await startRemindersService(env, { db, whatsapp, alerts, calendar, clientEmail, schedule });
  }

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    await service.stop();
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
