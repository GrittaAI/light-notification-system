// Run one sync and print the upcoming events now stored. Run: npm run sync:once

import { loadEnv } from './config.js';
import { openDb } from './db.js';
import { createCalendarClient } from './google.js';
import { type EventRow, runSync } from './sync.js';

const fmtIst = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
});

async function main(): Promise<void> {
  const env = loadEnv();
  const db = openDb(env.DB_PATH);
  try {
    const { calendar, clientEmail } = createCalendarClient(env);
    const result = await runSync(db, calendar, { serviceAccountEmail: clientEmail });

    const rows = db
      .prepare(`SELECT * FROM events WHERE end_utc > ? ORDER BY start_utc, client_name`)
      .all(new Date().toISOString()) as EventRow[];

    console.log(`\nSync ${result.ok ? 'OK' : 'had errors'} — ${rows.length} upcoming event(s) stored (times in IST):\n`);
    for (const r of rows) {
      const attendees = JSON.parse(r.attendees_json) as string[];
      console.log(`${fmtIst.format(new Date(r.start_utc))}  [${r.status}]  ${r.client_name}: ${r.title || '(no title)'}`);
      console.log(`    id: ${r.event_id}`);
      console.log(`    attendees: ${attendees.join(', ') || '(none)'}`);
      if (r.meet_link) console.log(`    meet: ${r.meet_link}`);
    }
    for (const c of result.calendars.filter((c) => !c.ok)) {
      console.log(`\nFAILED: ${c.client} — ${JSON.stringify(c.error)}`);
    }
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
