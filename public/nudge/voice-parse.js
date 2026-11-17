// Voice task parser: turns a spoken sentence (English or common Hinglish) into { title, dueIso, priority }.
// Pure (no DOM, no clock reads: `nowMs` is passed in), so it is unit-tested with a fixed clock. All dates are IST.
// It never guesses silently into the past: an explicit time that has already gone is returned with `past: true`.

const IST = 330 * 60_000;
const DAY = 86_400_000;

const WEEKDAYS = [
  ['sunday', 'sun', 'ravivar', 'raviwar', 'itvaar', 'itwar'],
  ['monday', 'mon', 'somvar', 'somvaar', 'somwar'],
  ['tuesday', 'tue', 'tues', 'mangalvar', 'mangalwar'],
  ['wednesday', 'wed', 'budhvar', 'budhwar'],
  ['thursday', 'thu', 'thur', 'thurs', 'guruvar', 'guruwar', 'brihaspativar'],
  ['friday', 'fri', 'shukravar', 'shukrawar'],
  ['saturday', 'sat', 'shanivar', 'shaniwar'],
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, ek: 1, do: 2, teen: 3, char: 4, paanch: 5 };
const NUM_RE = '(\\d{1,3}|forty five|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|ek|do|teen|char|paanch)';
const num = (w) => (/^\d+$/.test(w) ? Number(w) : NUM_WORDS[w]);

/** IST calendar parts of an instant. */
function parts(ms) {
  const d = new Date(ms + IST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), wd: d.getUTCDay() };
}
/** Epoch ms of an IST wall-clock time (month may overflow; Date.UTC normalises). */
const istMs = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - IST;

/** Strips filler words and dangling connectors from the left-over text and tidies it into a title. */
function tidyTitle(text) {
  let t = text.replace(/\s+/g, ' ').trim();
  const edge = /^(?:at|on|by|for|ko|ke|ka|ki|baje|the|this|next|coming|and|to|of|in|se|tak|,|-|–|\.)\s+|\s+(?:at|on|by|for|ko|ke|ka|ki|baje|the|this|next|coming|and|to|of|in|se|tak|hai|h)$|^[,.\-–:;]+|[,.\-–:;]+$/i;
  for (let i = 0; i < 6; i++) {
    const next = t.replace(edge, '').trim();
    if (next === t) break;
    t = next;
  }
  t = t.replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/**
 * Parses a spoken task. Returns:
 *   { title, dueIso | null, priority | null, understood, past }
 * `understood` is true when any date, time or duration was recognised (otherwise a smarter parser may help).
 */
export function parseVoiceTask(input, nowMs) {
  const original = String(input || '').replace(/\s+/g, ' ').trim();
  const s = original.toLowerCase();
  const used = new Array(s.length).fill(false);
  const free = (i, len) => { for (let k = i; k < i + len; k++) if (used[k]) return false; return true; };
  /** First match of `re` (global, word-bounded by the caller) over text not yet consumed; consumes it. */
  const take = (re) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(s)) !== null) {
      if (m[0].length === 0) { g.lastIndex++; continue; }
      if (free(m.index, m[0].length)) {
        for (let k = m.index; k < m.index + m[0].length; k++) used[k] = true;
        return m;
      }
      g.lastIndex = m.index + 1; // overlaps used text: retry from the next character (a shorter match may fit)
    }
    return null;
  };

  // ---- filler at the start ("remind me to", "create a task to", "mujhe yaad dilana ki") ----
  take(/^(?:ok(?:ay)?\s+|hey\s+nudge,?\s+|please\s+)*(?:remind me (?:to |about |that )?|create (?:a |an )?(?:new )?(?:task|event|reminder|to-?do)(?: to| for| called| named| that|:)?|add (?:a |an )?(?:new )?(?:task|event|reminder|to-?do)(?: to| for| called| named| that|:)?|set (?:a |an )?reminder(?: to| for)?|new (?:task|event|reminder)(?: to| for|:)?|mujhe yaad dila(?:na|o|ye|iye)?(?: ki| ke)?|yaad dila(?:na|o)?(?: ki| ke)?)\s*/);
  take(/\s*(?:please|plz)\s*$/);

  // ---- priority ----
  let priority = null;
  let m;
  if ((m = take(/(?:,?\s*(?:it'?s |this is |mark (?:it )?(?:as )?)?)\b(?:very urgent|super urgent|urgent(?:ly)?|asap|bahut zaruri|bahut jaruri|top priority|highest priority)\b/))) priority = 'urgent';
  else if ((m = take(/(?:,?\s*(?:it'?s |this is |mark (?:it )?(?:as )?)?)\b(?:high priority|important|zaruri|jaruri|zaroori|jaroori)\b/))) priority = 'high';
  else if ((m = take(/(?:,?\s*(?:mark (?:it )?(?:as )?)?)\b(?:low priority|not urgent|no rush|whenever)\b/))) priority = 'low';
  else if ((m = take(/\b(?:medium|normal) priority\b/))) priority = 'medium';

  // ---- relative duration: "in 2 hours", "in half an hour", "30 minute baad", "2 ghante mein" ----
  let relMs = null;
  let dayOffset = null; // explicit day: 0 today, 1 tomorrow, ...
  if ((m = take(/\b(?:in |after )?(?:half an hour|half hour|aadha ghanta|adha ghanta)(?: (?:baad|mein|me|later))?\b/))) relMs = 30 * 60_000;
  else if ((m = take(/\b(?:in |after )?(?:an hour and a half|one and a half hours?|dedh ghant[ae])(?: (?:baad|mein|me|later))?\b/))) relMs = 90 * 60_000;
  else if ((m = take(new RegExp(`\\b(?:in|after) ${NUM_RE} (minutes?|mins?|hours?|hrs?|ghant[ae]|ghanton|minat)\\b(?: (?:from now|later))?`)))
    || (m = take(new RegExp(`\\b${NUM_RE} (minutes?|mins?|hours?|hrs?|ghant[ae]|ghanton|minat) (?:baad|mein|me|later|from now)\\b`)))) {
    const n = num(m[1]);
    if (n) relMs = n * (/^(h|g)/.test(m[2]) ? 3_600_000 : 60_000);
  } else if ((m = take(new RegExp(`\\b(?:in|after) ${NUM_RE} (days?|din)\\b`))) || (m = take(new RegExp(`\\b${NUM_RE} (days?|din) (?:baad|mein|me|later)\\b`)))) {
    const n = num(m[1]);
    if (n) dayOffset = n;
  }

  // ---- day words ----
  let period = null; // 'morning' | 'afternoon' | 'evening' | 'night'
  if (dayOffset === null && take(/\b(?:the )?day after tomorrow\b|\bparso(?:n)?\b|\bparson\b/)) dayOffset = 2;
  if (dayOffset === null && (m = take(/\b(?:tonight|aaj raat(?: ko)?|aaj ki raat)\b/))) { dayOffset = 0; period = 'night'; }
  if (dayOffset === null && take(/\b(?:today|aaj)\b/)) dayOffset = 0;
  if (dayOffset === null && take(/\b(?:tomorrow|tmrw|tmr|kal)\b/)) dayOffset = 1;

  // ---- weekday ----
  let weekday = null;
  for (let i = 0; i < 7 && weekday === null; i++) {
    const names = WEEKDAYS[i].join('|');
    if ((m = take(new RegExp(`\\b(?:on |this |coming |next |agle |aane wale )?(?:${names})\\b(?: ko)?`)))) {
      weekday = i;
    }
  }

  // ---- calendar dates ----
  let date = null; // { d, m?, y? }
  const monthIdx = (w) => MONTHS.indexOf(w.slice(0, 3)) + 1;
  if ((m = take(/\b(?:on )?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/))) {
    const d = +m[1], mo = +m[2];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) date = { d, m: mo, y: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null };
  }
  if (!date && (m = take(new RegExp(`\\b(?:on )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}(?:,? (\\d{4}))?\\b`)))) date = { d: +m[1], m: monthIdx(m[2]), y: m[3] ? +m[3] : null };
  if (!date && (m = take(new RegExp(`\\b(?:on )?${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?\\b`)))) date = { d: +m[2], m: monthIdx(m[1]), y: m[3] ? +m[3] : null };
  if (!date && (m = take(/\b(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)\b(?: ko)?/))) date = { d: +m[1] };
  if (!date && (m = take(/\b(\d{1,2}) (?:tarikh|taarikh|tareekh)(?: ko)?\b/))) date = { d: +m[1] };
  if (!date && (m = take(/\bon (\d{1,2})\b(?!\s*(?::|\.\d|am|pm|a\.m|p\.m|baje|o'?clock))/))) date = { d: +m[1] };
  if (date && (date.d < 1 || date.d > 31)) date = null;

  // ---- time of day ----
  let hour = null, minute = 0, ampm = null;
  const setPeriodFrom = (w) => {
    if (/^(morning|subah|subha|savere|sawere)/.test(w)) period = 'morning';
    else if (/^(afternoon|dopahar|dopehar|dopher)/.test(w)) period = 'afternoon';
    else if (/^(evening|shaam|sham)/.test(w)) period = 'evening';
    else if (/^(night|raat|rat)/.test(w)) period = 'night';
  };
  const PERIOD_RE = /\b(?:in the |this |kal |aaj )?(morning|subah|subha|savere|sawere|afternoon|dopahar|dopehar|dopher|evening|shaam|sham|night|raat)\b(?: (?:ko|ke|mein|me))?/;
  if ((m = take(/\b(?:at |by |around |@ ?)?(saadhe|saade|sadhe|sade|sava|savva|sawa|paune|pone)\s+(\d{1,2})(?:\s*baje)?\b/))) {
    const base = +m[2];
    const kind = m[1];
    if (/^pa|^po/.test(kind)) { hour = base - 1; minute = 45; }
    else if (/^sav|^saw/.test(kind)) { hour = base; minute = 15; }
    else { hour = base; minute = 30; }
  } else if ((m = take(/\b(?:at |by |around |@ ?)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\s|$|[,.!?])/))) {
    hour = +m[1]; minute = m[2] ? +m[2] : 0; ampm = m[3].startsWith('a') ? 'am' : 'pm';
  } else if ((m = take(/\b(?:at |by |around )?(\d{1,2})(?:[:.](\d{2}))?\s*(?:baje|o'?clock|bajkar|bajke)\b/))) {
    hour = +m[1]; minute = m[2] ? +m[2] : 0;
  } else if ((m = take(/\b(?:at|by|around|@)\s*(\d{1,2})(?:[:.](\d{2}))?\b/))) {
    hour = +m[1]; minute = m[2] ? +m[2] : 0;
  } else if ((m = take(/\b(\d{1,2}):(\d{2})\b/))) {
    hour = +m[1]; minute = +m[2];
  } else if ((m = take(/\b(?:at )?(noon|midday|dopahar 12)\b/))) {
    hour = 12; minute = 0; ampm = 'pm';
  } else if ((m = take(/\b(?:at )?midnight\b/))) {
    hour = 23; minute = 59;
  }
  if ((m = take(PERIOD_RE))) setPeriodFrom(m[1]);
  // a period word can also come before the day word was taken ("kal subah"): already handled by take order
  if (hour !== null && (hour > 23 || minute > 59)) { hour = null; minute = 0; ampm = null; }

  const title = tidyTitle(original.split('').map((c, i) => (used[i] ? ' ' : c)).join(''));
  const understood = relMs !== null || dayOffset !== null || weekday !== null || date !== null || hour !== null || period !== null;
  if (!understood) return { title, dueIso: null, priority, understood: false, past: false };

  const now = parts(nowMs);
  if (relMs !== null) return { title, dueIso: new Date(nowMs + relMs).toISOString(), priority, understood: true, past: false };

  // ---- which day ----
  let day = null; // { y, m, d }
  const explicitDay = dayOffset !== null || weekday !== null || date !== null;
  if (dayOffset !== null) {
    const p = parts(istMs(now.y, now.m, now.d) + dayOffset * DAY + 12 * 3_600_000);
    day = { y: p.y, m: p.m, d: p.d };
  } else if (weekday !== null) {
    let add = (weekday - now.wd + 7) % 7;
    if (add === 0) add = 7; // a weekday name means the coming one, never today
    const p = parts(istMs(now.y, now.m, now.d) + add * DAY + 12 * 3_600_000);
    day = { y: p.y, m: p.m, d: p.d };
  } else if (date) {
    const todayStart = istMs(now.y, now.m, now.d);
    if (date.m) {
      let y = date.y || now.y;
      if (!date.y && istMs(y, date.m, date.d) < todayStart) y += 1;
      day = { y, m: date.m, d: date.d };
    } else {
      // "on 13th": this month if not passed, else the next month that has that day
      let y = now.y, mo = now.m;
      for (let i = 0; i < 13; i++) {
        const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        if (date.d <= daysIn && istMs(y, mo, date.d) >= todayStart) break;
        mo += 1; if (mo > 12) { mo = 1; y += 1; }
      }
      day = { y, m: mo, d: date.d };
    }
  }

  // ---- which time ----
  const PERIOD_DEFAULT = { morning: [9, 0], afternoon: [14, 0], evening: [18, 0], night: [21, 0] };
  const to24 = (h, ap) => (ap === 'am' ? (h === 12 ? 0 : h) : ap === 'pm' ? (h === 12 ? 12 : h + 12) : h);
  let h24 = null, m24 = minute;
  if (hour !== null) {
    if (ampm) h24 = to24(hour, ampm);
    else if (hour === 0 || hour >= 13) h24 = hour;
    else if (period === 'morning') h24 = hour === 12 ? 0 : hour;
    else if (period === 'afternoon' || period === 'evening') h24 = hour === 12 ? 12 : hour + 12;
    else if (period === 'night') h24 = hour === 12 ? 23 : hour <= 4 ? hour : hour + 12;
    else h24 = null; // ambiguous "at 9": decided below
  } else if (period) {
    [h24, m24] = PERIOD_DEFAULT[period];
  }
  if (hour === 23 && minute === 59 && !ampm) { h24 = 23; m24 = 59; }

  const at = (d, h, mi) => istMs(d.y, d.m, d.d, h, mi);
  let due;
  if (h24 === null && hour !== null) {
    // "at 9" with no am/pm: today -> the next one that has not passed; another day -> 7-11 am, 12-6 pm
    const guess = hour >= 7 && hour <= 11 ? hour : hour === 12 ? 12 : hour + 12;
    if (day) due = at(day, guess, minute);
    else {
      const today = { y: now.y, m: now.m, d: now.d };
      const hours = hour === 12 ? [12] : [hour, hour + 12];
      const cands = hours.map((x) => at(today, x, minute)).filter((x) => x > nowMs).sort((a, b) => a - b);
      if (cands.length) due = cands[0];
      else { const t = parts(istMs(now.y, now.m, now.d) + DAY + 12 * 3_600_000); due = at({ y: t.y, m: t.m, d: t.d }, guess, minute); }
    }
  } else if (h24 !== null) {
    if (day) due = at(day, h24, m24);
    else {
      due = at({ y: now.y, m: now.m, d: now.d }, h24, m24);
      if (due <= nowMs) { const t = parts(istMs(now.y, now.m, now.d) + DAY + 12 * 3_600_000); due = at({ y: t.y, m: t.m, d: t.d }, h24, m24); }
    }
  } else {
    // a day but no time: 9:00 AM; "today" with no time: 6 PM, or in an hour if that has passed
    if (dayOffset === 0) {
      due = at(day, 18, 0);
      if (due <= nowMs) due = Math.ceil((nowMs + 3_600_000) / 900_000) * 900_000;
    } else due = at(day, 9, 0);
  }
  const past = explicitDay && due < nowMs - 60_000;
  return { title, dueIso: new Date(due).toISOString(), priority, understood: true, past };
}

/** True when the text has Devanagari (Hindi script), which the rule parser does not read. */
export const hasDevanagari = (text) => /[ऀ-ॿ]/.test(String(text || ''));
