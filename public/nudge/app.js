// Nudge PWA (Material 3). Vanilla JS, no build. All user/API text is inserted with textContent or text nodes (never HTML strings).
// Icons are Lucide symbols from icons.svg (ISC licence). Every time shown is Asia/Kolkata (see sync-core.js).
// Layout: compact (< 840px) top app bar + FAB; expanded (>= 840px) navigation drawer; large (>= 1200px) list + detail pane.
import * as idb from './idb.js';
import { renderAdminPage, renderNudgeSettingsPage } from './admin.js';
import { hasDevanagari, parseVoiceTask } from './voice-parse.js';
import {
  applyActionLocal, applyPushed, calendarMonth, checklistProgress, DAY_MS, dayKey, dayKeyStart, fmtDayKey, shiftMonth, tasksOnDay, diffOutbox, dueChip, enqueue, mergeOutbox, newOwnerIds, fmtDateTime, fmtRelative, fmtTime, groupTasks,
  isoToIstInput, isSnoozed, istAt, istInputToIso, istParts, mergePull, newTask, pendingTaskIds, pruneInvisible, pushOutbox, putBody,
  reconcileOutbox, toastReplaces, MAX_CHECKLIST,
} from './sync-core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');
const $alerts = document.getElementById('alerts');
const $sheetRoot = document.getElementById('sheet-root');
const mqExpanded = window.matchMedia('(min-width: 840px)');
/** Browser speech recognition (Chrome, Edge, Safari); absent in Firefox, where the mic buttons are hidden. */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceSupported = !!SpeechRec;
const mqLarge = window.matchMedia('(min-width: 1200px)');

// ---------- DOM helpers ----------
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
/** Replaces node's children; flattens arrays and skips null/false (native append would print them). */
const fill = (node, ...kids) => { clear(node).append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); return node; };

function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '/icons.svg#' + name);
  svg.append(use);
  return svg;
}
const initials = (name) => (String(name).trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('') || '?').toUpperCase();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
/** A Material list item. `opts.onclick` makes it a button; `opts.href` a link. */
function listItem({ lead, head, sub, trail, onclick, href, cls, disabled, label, attrs }) {
  const tag = onclick ? 'button' : href ? 'a' : 'div';
  return h(tag, {
    class: 'list-item' + (sub ? ' two' : '') + (onclick || href ? ' clickable' : '') + (cls ? ' ' + cls : ''),
    ...(onclick && { type: 'button', onclick, disabled }), ...(href && { href }), ...(label && { 'aria-label': label }), ...(attrs || {}),
  },
  lead && h('span', { class: 'li-lead' }, lead),
  h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, head), sub && h('span', { class: 'li-sub' }, sub)),
  trail && h('span', { class: 'li-trail' }, trail));
}
/** Grows a textarea with its content without inline styles (rows only). */
function autoRows(el, max = 8) {
  el.rows = 1;
  while (el.scrollHeight > el.clientHeight + 2 && el.rows < max) el.rows += 1;
}

// ---------- toasts ----------
/**
 * Toasts: a new passive toast replaces the previous passive one; toasts with an action (Undo, the update prompt) are never
 * removed by a passive toast (see toastReplaces). Errors use the role=alert region, the rest the polite one.
 */
function toast(text, opts = {}) {
  const kind = opts.action ? (opts.timeout === 0 ? 'sticky' : 'undo') : 'passive';
  for (const box of [$toasts, $alerts]) {
    for (const old of [...box.children]) if (toastReplaces(kind, old.dataset.kind)) { clearTimeout(Number(old.dataset.timer)); old.remove(); }
  }
  const box = opts.kind === 'error' ? $alerts : $toasts;
  const el = h('div', { class: 'toast' + (opts.kind === 'error' ? ' error' : ''), 'data-kind': kind }, h('span', {}, text));
  const remove = () => { clearTimeout(Number(el.dataset.timer)); el.remove(); };
  if (opts.action) {
    el.append(h('button', { type: 'button', onclick: () => { remove(); opts.action.fn(); } }, opts.action.label));
  }
  box.append(el);
  if (opts.timeout !== 0) el.dataset.timer = String(setTimeout(remove, opts.timeout || (opts.kind === 'error' ? 7000 : 4000)));
  return remove;
}

// ---------- API ----------
async function rawFetch(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}
/** Throws {status, message} for non-2xx, {network: true} when the network failed. */
async function api(method, path, body) {
  let r;
  try { r = await rawFetch(method, path, body); } catch { S.online = false; renderStatus(); throw Object.assign(new Error('You are offline'), { network: true }); }
  S.online = true;
  if (r.status >= 200 && r.status < 300) return r.body;
  throw Object.assign(new Error((r.body && r.body.error) || `Request failed (${r.status})`), { status: r.status, body: r.body });
}

// ---------- state ----------
const S = {
  me: null, tasks: new Map(), owners: [], outbox: [], meta: {}, ownerId: null,
  online: navigator.onLine, syncing: false, syncAgain: false, loaded: false, forceFull: false, storageOk: true,
  showDone: false, active: true, epoch: 0, wiping: false,
  homeView: store.get('nudge.view') === 'calendar' ? 'calendar' : 'list', cal: null, // 'list' | 'calendar'; cal = { year, month, sel: 'YYYY-MM-DD' } (IST)
};
let writeChain = Promise.resolve();
function persist(changes) {
  if (!S.storageOk || S.wiping || !S.active) return writeChain;
  writeChain = writeChain.then(() => idb.write(changes)).catch(() => { S.storageOk = false; });
  return writeChain;
}
/** Sets the outbox and returns the per-entry storage change for it (put by seq, delete by seq; never clear-and-replace). */
function setOutbox(next) {
  const diff = diffOutbox(S.outbox, next);
  S.outbox = next;
  return { outbox: diff };
}

const ownerOf = (id) => S.owners.find((o) => o.id === id);
const canEditOwner = (id) => { const o = ownerOf(id); return !!o && o.level === 'edit'; };
const myOwnerId = () => (S.me && S.me.personId !== null ? S.me.personId : null);
const pendingFor = (taskId) => S.outbox.some((e) => e.taskId === taskId);
const isAdmin = () => !!S.me && (S.me.role === 'admin' || S.me.role === 'superadmin');
const openCount = (ownerId) => [...S.tasks.values()].filter((t) => t.ownerPersonId === ownerId && !t.deleted && t.status !== 'done').length;
const listTitle = () => {
  const o = ownerOf(S.ownerId);
  if (!o) return 'Tasks';
  return o.id === myOwnerId() ? 'My tasks' : `${o.name}’s tasks`;
};

function chooseOwner() {
  const saved = Number(store.get('nudge.owner'));
  const mine = myOwnerId();
  if (S.owners.some((o) => o.id === saved)) S.ownerId = saved;
  else if (S.owners.some((o) => o.id === mine)) S.ownerId = mine;
  else S.ownerId = S.owners.length ? S.owners[0].id : null;
}
function selectOwner(id) {
  S.ownerId = id;
  store.set('nudge.owner', String(id));
  if (route().name !== 'home') location.hash = '#/';
  else { view.route = null; renderAll(false); }
}

// ---------- local writes (instant, then outbox) ----------
function mutate(task, op) {
  if (!S.active) return;
  S.tasks.set(task.id, task);
  persist({ tasks: { put: [task] }, ...setOutbox(enqueue(S.outbox, { taskId: task.id, ...op })) });
  afterLocalWrite(task.id);
}
function afterLocalWrite(taskId) {
  renderStatus();
  renderHomeList();
  renderDrawerCounts();
  updateTaskPageState(taskId);
  scheduleSync();
}
function createTask({ title, dueAt, priority }) {
  if (!S.active) return undefined;
  const t = newTask({ id: crypto.randomUUID(), ownerPersonId: S.ownerId, title, dueAt, priority, createdBy: S.me.email }, nowIso());
  mutate(t, { kind: 'put', body: putBody(t), baseVersion: null, isCreate: true });
  return t;
}
function editTask(id, patch) {
  if (!S.active) return;
  const t = S.tasks.get(id);
  if (!t || !canEditOwner(t.ownerPersonId)) return;
  const nt = { ...t, ...patch, updatedAt: nowIso() };
  mutate(nt, { kind: 'put', body: putBody(nt), baseVersion: t.version || null, isCreate: t.version === 0 });
}
function actOn(id, action, minutes) {
  if (!S.active) return;
  const t = S.tasks.get(id);
  if (!t || !canEditOwner(t.ownerPersonId)) return;
  mutate(applyActionLocal(t, action, nowIso(), minutes), { kind: 'action', action, ...(minutes !== undefined && { minutes }) });
}
function deleteTask(id) {
  if (!S.active) return;
  const t = S.tasks.get(id);
  if (!t || !canEditOwner(t.ownerPersonId)) return;
  S.tasks.delete(id);
  persist({ tasks: { remove: [id] }, ...setOutbox(enqueue(S.outbox, { taskId: id, kind: 'delete' })) });
  renderStatus();
  renderHomeList();
  renderDrawerCounts();
  scheduleSync();
}
function markDone(id) {
  if (!S.active) return;
  actOn(id, 'done');
  toast('Task completed', { timeout: 5000, action: { label: 'Undo', fn: () => actOn(id, 'reopen') } });
}
function snoozeTo(id, minutes) {
  actOn(id, 'snooze', minutes);
  toast(`Snoozed until ${fmtDateTime(nowMs() + minutes * 60_000, nowMs())}`, { timeout: 5000, action: { label: 'Undo', fn: () => actOn(id, 'unsnooze') } });
}

// ---------- sync ----------
let syncTimer = null;
function scheduleSync(ms = 800) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync('write'), ms);
}

function sync() {
  if (!S.me || !S.active) return Promise.resolve();
  if (S.syncing) { S.syncAgain = true; return Promise.resolve(); }
  S.syncing = true;
  renderStatus();
  // one sync at a time across tabs (defence in depth; the active-tab lock already keeps a second tab idle)
  const run = () => doSync();
  const p = navigator.locks ? navigator.locks.request('nudge-sync', run) : run();
  return p.finally(() => {
    S.syncing = false;
    renderAll(true);
    if (S.syncAgain) { S.syncAgain = false; scheduleSync(300); }
  });
}

async function doSync() {
  const epoch = S.epoch;
  const stale = () => epoch !== S.epoch || !S.me;
  const ownerBefore = S.ownerId;
  try {
    // the stored outbox is the truth: wait for our own queued writes, then merge in anything another writer left
    await writeChain;
    if (S.storageOk) {
      try { const stored = await idb.getAll('outbox'); if (!stale()) S.outbox = mergeOutbox(stored, S.outbox); } catch { /* keep memory */ }
    }
    if (stale()) return;
    const snapshot = S.outbox.slice();
    let needFull = S.forceFull;
    if (snapshot.length) {
      const result = await pushOutbox(snapshot, async (req) => {
        const r = await rawFetch(req.method, req.path, req.body);
        S.online = true;
        return r;
      });
      if (stale()) return;
      const outboxChange = setOutbox(reconcileOutbox(snapshot, result.remaining, S.outbox, result));
      applyPushResults(result);
      if (result.conflicts.length && document.activeElement) document.activeElement.blur(); // the server copy must show, even over a field being edited
      if (result.conflicts.length) toast('This task was changed elsewhere; showing the latest version', { kind: 'error' });
      if (result.rejected.length) {
        needFull = true;
        toast(`A change could not be saved: ${result.rejected[0].error}`, { kind: 'error' });
      }
      persist(outboxChange);
      if (result.state === 'unauthorized') return signedOut('Your session expired. Sign in to continue; your changes are kept.');
      if (result.state !== 'ok') {
        if (result.state === 'offline') S.online = false;
        return;
      }
    }
    // owners first, so a newly granted list is noticed before the pull
    const owners = await api('GET', '/api/app/owners');
    if (stale()) return;
    const freshOwners = newOwnerIds(S.owners, owners);
    const since = S.meta.lastSync;
    const full = needFull || !since;
    const pulled = await api('GET', '/api/app/tasks' + (full ? '' : `?since=${encodeURIComponent(since)}`));
    if (stale()) return;
    const merged = mergePull([...S.tasks.values()], pulled.tasks, { pendingIds: pendingTaskIds(S.outbox), full });
    for (const t of merged.put) S.tasks.set(t.id, t);
    for (const id of merged.remove) S.tasks.delete(id);
    S.meta.lastSync = pulled.serverTime;
    S.forceFull = false;
    persist({ tasks: { put: merged.put, remove: merged.remove }, meta: { lastSync: pulled.serverTime } });
    // a list that became visible since the last sync has never been pulled: fetch it whole (not just changes since lastSync)
    if (!full) {
      for (const id of freshOwners) {
        const list = await api('GET', `/api/app/tasks?owner=${id}`);
        if (stale()) return;
        const m = mergePull([...S.tasks.values()], list.tasks, { pendingIds: pendingTaskIds(S.outbox) });
        for (const t of m.put) S.tasks.set(t.id, t);
        persist({ tasks: { put: m.put } });
      }
    }
    // only now commit the owners (a failed pull above retries the new owners next time), then drop tasks of owners no longer visible
    const ownersChanged = JSON.stringify(S.owners) !== JSON.stringify(owners);
    S.owners = owners;
    const gone = pruneInvisible([...S.tasks.values()], S.owners);
    for (const id of gone) S.tasks.delete(id);
    persist({ owners: { replace: S.owners }, tasks: { remove: gone } });
    if (!S.owners.some((o) => o.id === S.ownerId)) chooseOwner();
    if (ownersChanged) view.shellKey = null; // the drawer lists the owners: rebuild it
    S.loaded = true;
  } catch (e) {
    if (e.status === 401 && !stale()) signedOut('Your session expired. Sign in to continue; your changes are kept.');
    else if (!e.network) console.error('sync failed', e);
  } finally {
    if (S.me && S.ownerId !== ownerBefore) view.route = null; // the list changed: rebuild the page
  }
}

function applyPushResults(result) {
  const pend = pendingTaskIds(S.outbox);
  const puts = [];
  const removes = [];
  for (const item of result.applied) {
    const r = applyPushed(item, S.tasks.get(item.taskId), pend.has(item.taskId));
    if (r.put) { S.tasks.set(r.put.id, r.put); puts.push(r.put); }
    if (r.remove) { S.tasks.delete(r.remove); removes.push(r.remove); }
  }
  for (const c of result.conflicts) {
    if (c.task && !c.task.deleted) { S.tasks.set(c.task.id, c.task); puts.push(c.task); }
    else { S.tasks.delete(c.taskId); removes.push(c.taskId); }
  }
  for (const r of result.rejected) if (r.status === 404 || r.status === 403) S.forceFull = true;
  persist({ tasks: { put: puts, remove: removes } });
}

let loopStarted = false;
function startSyncLoop() {
  sync('start');
  if (loopStarted) return;
  loopStarted = true;
  setInterval(() => { if (!document.hidden) sync('tick'); }, 30_000);
  setInterval(() => { if (!document.hidden) renderHomeList(); }, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync('visible'); });
  window.addEventListener('online', () => { S.online = true; renderStatus(); sync('online'); });
  window.addEventListener('offline', () => { S.online = false; renderStatus(); });
}

// ---------- sheets (bottom sheets on phones, dialogs on larger screens) ----------
let closeSheet = null;
/** While a sheet or dialog is open, everything behind it is inert (no Tab, no taps, hidden from screen readers). */
function setBackgroundInert(on) {
  const shell = document.querySelector('.app');
  if (shell) shell.inert = on;
}
/** `keepOpen`: for forms, a tap on the backdrop must not discard what was typed (Esc and the buttons still close). */
function openSheet(content, { label, keepOpen }) {
  if (closeSheet) closeSheet();
  const opener = document.activeElement;
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, h('div', { class: 'sheet-grip' }), content);
  const back = h('div', { class: 'backdrop' }, panel);
  const focusables = () => [...panel.querySelectorAll('button, input, select, textarea, a[href]')].filter((el) => !el.disabled && !el.hidden && el.tabIndex >= 0);
  const onKey = (ev) => {
    if (ev.key === 'Escape') return close();
    if (ev.key !== 'Tab') return undefined;
    // keep Tab inside the dialog: wrap from the last control to the first and back
    const list = focusables();
    if (list.length === 0) { ev.preventDefault(); return undefined; }
    const first = list[0];
    const last = list[list.length - 1];
    const inside = panel.contains(document.activeElement);
    if (ev.shiftKey && (!inside || document.activeElement === first)) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (!inside || document.activeElement === last)) { ev.preventDefault(); first.focus(); }
    return undefined;
  };
  function close() {
    document.removeEventListener('keydown', onKey);
    back.remove();
    closeSheet = null;
    setBackgroundInert(false);
    if (opener && opener.isConnected && opener !== document.body) {
      opener.focus();
      if (document.activeElement !== opener) requestAnimationFrame(() => opener.focus()); // style update after un-inert
    }
  }
  if (!keepOpen) back.addEventListener('click', (ev) => { if (ev.target === back) close(); });
  document.addEventListener('keydown', onKey);
  $sheetRoot.append(back);
  setBackgroundInert(true);
  closeSheet = close;
  const first = panel.querySelector('[data-autofocus], input, textarea, select, button');
  if (first) first.focus();
  return close;
}
const sheetHead = (title, sub, extra) => [h('div', { class: 'sheet-head' }, h('h2', { class: 'headline' }, title), extra), sub && h('p', { class: 'sheet-sub' }, sub)].filter(Boolean);

/** Named snooze/due times in IST, Gmail style: each shows exactly when. */
function namedTimes(now, { forSnooze }) {
  const p = istParts(now);
  const out = [];
  const add = (key, ic, label, iso) => { const ms = Date.parse(iso); if (ms > now + 14 * 60_000) out.push({ key, ic, label, ms, iso }); };
  if (forSnooze) add('1h', 'timer', 'In 1 hour', new Date(Math.ceil((now + 3_600_000) / 60_000) * 60_000).toISOString());
  if (p.hour < 17) add('later', 'sun', 'Later today', istAt(now, 0, 18));
  else if (p.hour < 20) add('evening', 'moon', 'This evening', istAt(now, 0, 21));
  add('tomorrow', 'sunrise', 'Tomorrow', istAt(now, 1, 9));
  const toMonday = ((8 - p.weekday) % 7) || 7;
  if (toMonday > 1) add('nextweek', 'calendar-days', 'Next week', istAt(now, toMonday, 9));
  if (!forSnooze) add('1h', 'timer', 'In 1 hour', new Date(Math.ceil((now + 3_600_000) / 60_000) * 60_000).toISOString());
  return forSnooze ? out.filter((x) => x.ms - now <= 10_080 * 60_000) : out;
}
const whenText = (ms, now) => fmtDateTime(ms, now).replace(/^(Today|Tomorrow) /, '');

function snoozeSheet(taskId) {
  const t = S.tasks.get(taskId);
  if (!t) return;
  const content = h('div', {});
  const close = openSheet(content, { label: 'Snooze' });
  const now = nowMs();
  const pick = (ms) => { close(); snoozeTo(taskId, Math.ceil((ms - nowMs()) / 60_000)); };
  const custom = () => {
    const input = h('input', { class: 'input', type: 'datetime-local', id: 'snooze-custom', 'aria-label': 'Snooze until (IST)', 'data-autofocus': true });
    const err = h('p', { class: 'error-text', hidden: true });
    clear(content).append(...sheetHead('Pick date & time', 'No nudges until then. Times are IST.'),
      h('div', { class: 'sheet-body' }, h('div', { class: 'field' }, h('label', { for: 'snooze-custom' }, 'Snooze until'), input, err)),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn text', onclick: () => snoozeSheet(taskId) }, 'Back'),
        h('button', { type: 'button', class: 'btn', onclick: () => {
          const iso = istInputToIso(input.value);
          const m = iso ? Math.ceil((Date.parse(iso) - nowMs()) / 60_000) : NaN;
          if (!Number.isFinite(m) || m < 15 || m > 10_080) { err.textContent = 'Pick a time between 15 minutes and 7 days from now.'; err.hidden = false; return; }
          close(); snoozeTo(taskId, m);
        } }, 'Snooze')));
    input.focus();
  };
  const snoozed = isSnoozed(t, now);
  content.append(
    ...sheetHead('Snooze until…', snoozed ? `Snoozed until ${fmtDateTime(Date.parse(t.snoozedUntil), now)}` : 'No WhatsApp nudges until then'),
    h('div', { class: 'list' },
      snoozed && listItem({ lead: icon('rotate-ccw'), head: 'Unsnooze', sub: 'Nudge again as normal', onclick: () => { close(); actOn(taskId, 'unsnooze'); toast('Snooze cleared'); } }),
      namedTimes(now, { forSnooze: true }).map((x) => listItem({ lead: icon(x.ic), head: x.label, trail: whenText(x.ms, now), onclick: () => pick(x.ms) })),
      listItem({ lead: icon('calendar-clock'), head: 'Pick date & time', trail: icon('chevron-right', 'sm'), onclick: custom })));
}

/** Due date picker: named times, a custom date-time and Clear. `onPick(iso|null)`. */
function dueSheet(current, onPick) {
  const content = h('div', {});
  const close = openSheet(content, { label: 'Due date', keepOpen: true });
  const now = nowMs();
  const input = h('input', { class: 'input', type: 'datetime-local', id: 'due-custom', 'aria-label': 'Due date and time (IST)' });
  if (current) input.value = isoToIstInput(current);
  const err = h('p', { class: 'error-text', hidden: true });
  content.append(
    ...sheetHead('Due date', current ? `Currently ${fmtDateTime(Date.parse(current), now)} IST` : 'We nudge on WhatsApp before it is due'),
    h('div', { class: 'list' }, namedTimes(now, { forSnooze: false }).map((x) => listItem({ lead: icon(x.ic), head: x.label, trail: whenText(x.ms, now), onclick: () => { close(); onPick(x.iso); } }))),
    h('div', { class: 'sheet-body' }, h('div', { class: 'field' }, h('label', { for: 'due-custom' }, 'Or pick a date and time (IST)'), input, err)),
    h('div', { class: 'sheet-actions' },
      current && h('button', { type: 'button', class: 'btn danger-text', onclick: () => { close(); onPick(null); } }, icon('x'), 'Clear date'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn text', onclick: close }, 'Cancel'),
      h('button', { type: 'button', class: 'btn', onclick: () => {
        const iso = istInputToIso(input.value);
        if (!iso) { err.textContent = 'Pick a date and time.'; err.hidden = false; return; }
        close(); onPick(iso);
      } }, 'Set')));
}

const PRIO = [['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
function prioritySheet(current, onPick) {
  const content = h('div', {});
  const close = openSheet(content, { label: 'Priority' });
  content.append(...sheetHead('Priority'),
    h('div', { class: 'list', role: 'radiogroup', 'aria-label': 'Priority' }, PRIO.map(([p, l]) => listItem({
      lead: icon('flag', `p-${p}-c`), head: l, trail: current === p ? icon('check', 'sm') : null,
      attrs: { role: 'radio', 'aria-checked': String(current === p) }, onclick: () => { close(); onPick(p); },
    }))));
}

function confirmDelete(taskId, after) {
  const t = S.tasks.get(taskId);
  if (!t) return;
  const content = h('div', {});
  const close = openSheet(content, { label: 'Delete task' });
  content.append(
    ...sheetHead('Delete task?', `“${t.title}” will be deleted for everyone who can see this list.`),
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn text', onclick: close, 'data-autofocus': true }, 'Cancel'),
      h('button', { type: 'button', class: 'btn danger', onclick: () => { close(); deleteTask(taskId); toast('Task deleted'); if (after) after(); } }, 'Delete')));
}

function taskActions(taskId) {
  const t = S.tasks.get(taskId);
  if (!t) return;
  const content = h('div', {});
  const close = openSheet(content, { label: 'Task actions' });
  const now = nowMs();
  const done = t.status === 'done';
  const sub = t.dueAt ? `Due ${fmtDateTime(Date.parse(t.dueAt), now)}` : 'No due date';
  content.append(...sheetHead(t.title, sub),
    h('div', { class: 'list' },
      done ? listItem({ lead: icon('rotate-ccw'), head: 'Reopen', onclick: () => { close(); actOn(taskId, 'reopen'); } })
        : listItem({ lead: icon('circle-check-big'), head: 'Mark as done', onclick: () => { close(); markDone(taskId); } }),
      !done && listItem({ lead: icon('alarm-clock'), head: 'Snooze', trail: icon('chevron-right', 'sm'), onclick: () => snoozeSheet(taskId) }),
      listItem({ lead: icon('square-pen'), head: 'Open details', onclick: () => { close(); location.hash = '#/t/' + encodeURIComponent(taskId); } }),
      h('div', { class: 'sheet-divider' }),
      listItem({ lead: icon('trash-2'), head: 'Delete', cls: 'danger', onclick: () => confirmDelete(taskId) })));
}

/**
 * New task sheet. `opts`: { dueIso } (calendar day) or a voice result { title, dueIso, priority, voice: { transcript, past, source } }.
 * A voice result is only a draft: nothing is created until Add is tapped.
 */
function newTaskSheet(opts) {
  if (S.ownerId === null || !canEditOwner(S.ownerId)) return;
  if (!opts || opts instanceof Event) opts = {};
  const voice = opts.voice || null;
  const st = { due: opts.dueIso ? { key: 'pick', iso: opts.dueIso } : null, priority: opts.priority || 'medium' };
  const content = h('div', {});
  const close = openSheet(content, { label: 'New task', keepOpen: true });
  const title = h('textarea', { class: 'title-input', id: 'nt-title', rows: '1', maxlength: '200', placeholder: 'What needs doing?', 'aria-label': 'Task title', 'data-autofocus': !voice });
  if (opts.title) title.value = String(opts.title).slice(0, 200);
  const dueRow = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Due date' });
  const prioRow = h('div', { class: 'chip-row', role: 'radiogroup', 'aria-label': 'Priority' });
  const addBtn = h('button', { type: 'button', class: 'btn', id: 'nt-add' }, 'Add task');
  const draw = () => {
    const now = nowMs();
    fill(dueRow,
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!!st.due && st.due.key === 'pick'),
        onclick: () => dueSheetInline() }, icon('calendar'), st.due && st.due.key === 'pick' ? fmtDateTime(Date.parse(st.due.iso), now) : 'Pick date'),
      namedTimes(now, { forSnooze: false }).slice(0, 3).map((x) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!!st.due && st.due.key === x.key),
        onclick: () => { st.due = st.due && st.due.key === x.key ? null : { key: x.key, iso: x.iso }; draw(); } }, icon(x.ic), `${x.label} · ${fmtTime(x.ms)}`)));
    fill(prioRow, PRIO.slice().reverse().map(([p, l]) => h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(st.priority === p), 'aria-pressed': String(st.priority === p),
      onclick: () => { st.priority = p; draw(); } }, icon('flag', `p-${p}-c`), l)));
    addBtn.disabled = !title.value.trim();
  };
  const inlinePick = h('div', { class: 'field', hidden: true });
  const dueSheetInline = () => {
    const input = h('input', { class: 'input', type: 'datetime-local', id: 'nt-due', 'aria-label': 'Due date and time (IST)' });
    if (st.due) input.value = isoToIstInput(st.due.iso);
    input.addEventListener('change', () => { const iso = istInputToIso(input.value); st.due = iso ? { key: 'pick', iso } : null; draw(); });
    clear(inlinePick).append(h('label', { for: 'nt-due' }, 'Due date and time (IST)'), input);
    inlinePick.hidden = false;
    input.focus();
    if (typeof input.showPicker === 'function') { try { input.showPicker(); } catch { /* not allowed here */ } }
  };
  const submit = () => {
    const text = title.value.trim();
    if (!text) return;
    createTask({ title: text, dueAt: st.due ? st.due.iso : null, priority: st.priority });
    close();
    toast(st.due ? `Task added · due ${fmtDateTime(Date.parse(st.due.iso), nowMs())}` : 'Task added');
  };
  addBtn.addEventListener('click', submit);
  title.addEventListener('input', () => { autoRows(title, 4); draw(); });
  title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); } });
  const micBtn = voiceSupported && h('button', { type: 'button', class: 'icon-btn tonal', id: 'nt-mic', 'aria-label': 'Say the task instead', title: 'Say it', onclick: () => voiceSheet() }, icon('mic'));
  const pastWarn = voice && voice.past && st.due;
  content.append(...sheetHead(voice ? 'Check your task' : 'New task', ownerOf(S.ownerId) && S.ownerId !== myOwnerId() ? `In ${ownerOf(S.ownerId).name}’s list` : voice ? 'Fix anything, then tap Add task' : null, micBtn),
    h('div', { class: 'sheet-body' },
      voice && h('div', { class: 'voice-heard' }, icon(voice.source === 'ai' ? 'sparkles' : 'mic', 'sm'), h('span', {}, `“${voice.transcript}”`)),
      pastWarn && h('div', { class: 'callout warn', role: 'alert' }, icon('alert-triangle'), h('span', {}, 'That time has already passed. Pick another time below.')),
      voice && !st.due && h('div', { class: 'callout info' }, icon('calendar'), h('span', {}, voice.source === 'fallback' ? 'I could not work out a date. Pick one below, or leave it without a date.' : 'No date was said. Pick one below, or leave it without a date.')),
      title,
      h('div', { class: 'stack' }, h('span', { class: 'field-label' }, 'Due'), dueRow, inlinePick),
      h('div', { class: 'stack' }, h('span', { class: 'field-label' }, 'Priority'), prioRow)),
    h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn text', onclick: close }, 'Cancel'), addBtn));
  draw();
  autoRows(title, 4);
  if (voice) addBtn.focus(); else title.focus();
}

// ---------- voice ----------

/**
 * Voice input (Indian English, which also catches Hinglish). Keeps listening, restarting quietly when the browser
 * stops on a pause, until the person taps Done; the transcript stays on screen. Then: the server's AI first; the
 * in-app parser only when the AI is not set up, the device is offline, or the AI call fails.
 * Always ends in the New task sheet for review; nothing is created here.
 */
const VOICE_MAX_MS = 3 * 60_000;

/** Where to re-allow the microphone: a page cannot ask again once the browser has blocked it. */
function micHelp() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'On iPhone: tap “aA” in the address bar → Website Settings → Microphone → Allow. Also check Settings → Safari → Microphone.';
  if (/Android/.test(ua)) return 'On Android Chrome: tap ⋮ → Settings → Site settings → Microphone, find this site and set it to Allow. Also check Android Settings → Apps → Chrome → Permissions → Microphone.';
  if (/Edg\//.test(ua)) return 'In Edge: click the lock icon left of the address → Permissions for this site → Microphone → Allow, then reload.';
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) return 'In Safari: Safari menu → Settings for This Website → Microphone → Allow.';
  return 'In Chrome: click the icon left of the address (lock or sliders) → Microphone → Allow, then reload the page. Also check that your computer allows the browser to use the microphone.';
}

function voiceSheet() {
  if (!voiceSupported || S.ownerId === null || !canEditOwner(S.ownerId)) return;
  const content = h('div', { class: 'voice' });
  let rec = null;
  let state = 'listening'; // listening | paused | understanding | closed | error
  let sessions = 0;
  // Android Chrome only starts recognition right after a tap: a pause there waits for a tap instead of auto-restarting
  const tapToResume = /Android/.test(navigator.userAgent);
  const finals = []; // finished phrases from every recognition session
  let sessionFinals = []; // finished phrases of the current session
  let interim = '';
  const startedAt = Date.now();
  let quickEnds = 0; // sessions that ended at once without hearing anything (a broken mic must not loop forever)
  let sessionStart = 0;
  let sessionHeard = false;
  const close = openSheet(content, { label: 'Say a task', keepOpen: true });
  const live = h('p', { class: 'voice-text', 'aria-live': 'polite' });
  const status = h('p', { class: 'voice-status' }, 'Listening… tap Done when you finish');
  const doneBtn = h('button', { type: 'button', class: 'btn', id: 'voice-done', onclick: () => finish() }, icon('check'), 'Done');
  const orb = h('button', { type: 'button', class: 'voice-orb listening', 'aria-label': 'Done speaking', onclick: () => (state === 'paused' ? resume() : finish()) }, icon('mic'));
  const actions = h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn text', onclick: () => cancel() }, 'Cancel'), doneBtn);
  content.append(...sheetHead('Say a task'), h('div', { class: 'voice-body' }, orb, status, live,
    h('p', { class: 'voice-hint' }, 'Say the whole task, then tap Done. Try “Demo for Margin Sales tomorrow at 9:30 pm” or “kal shaam 6 baje client call”.')), actions);

  const transcript = () => [...finals, ...sessionFinals, interim].map((x) => x.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const show = () => { live.textContent = transcript(); doneBtn.disabled = !transcript(); };
  const stopRec = (abort) => { try { if (rec) (abort ? rec.abort() : rec.stop()); } catch { /* already stopped */ } };
  const cancel = () => { state = 'closed'; stopRec(true); close(); };

  const showError = (msg, retry = true) => {
    state = 'error';
    stopRec(true);
    orb.classList.remove('listening');
    orb.setAttribute('aria-label', 'Try again');
    orb.onclick = () => voiceSheet();
    status.textContent = msg;
    const text = transcript();
    fill(actions, h('button', { type: 'button', class: 'btn text', onclick: () => cancel() }, 'Cancel'),
      retry && h('button', { type: 'button', class: 'btn tonal', onclick: () => voiceSheet() }, icon('mic'), 'Try again'),
      text ? h('button', { type: 'button', class: 'btn', onclick: () => understand(text) }, 'Use what I said')
        : h('button', { type: 'button', class: 'btn text', onclick: () => { cancel(); newTaskSheet(); } }, 'Type instead'));
  };

  const draft = (r, text, source) => {
    if (state === 'closed') return;
    state = 'closed';
    newTaskSheet({ title: r.title || text, dueIso: r.dueIso, priority: r.priority, voice: { transcript: text, past: !!r.past, source } });
  };

  async function understand(text) {
    state = 'understanding';
    stopRec(true);
    orb.classList.remove('listening');
    orb.disabled = true;
    doneBtn.disabled = true;
    live.textContent = `“${text}”`;
    const local = () => parseVoiceTask(text, nowMs());
    if (!S.online) { draft(local(), text, 'app'); return; }
    status.textContent = 'Understanding…';
    try {
      // the AI separates the task from the date words (translated to plain English); the dates are computed here
      const r = await api('POST', '/api/app/voice-parse', { text });
      const fromWhen = r.when ? parseVoiceTask(r.when, nowMs()) : null;
      const fromText = parseVoiceTask(text, nowMs());
      const due = fromWhen && fromWhen.dueIso ? fromWhen : fromText.dueIso && !hasDevanagari(text) ? fromText : null;
      draft({ title: r.title, dueIso: due ? due.dueIso : null, priority: r.priority || fromText.priority, past: due ? due.past : false }, text, 'ai');
    } catch {
      // AI not set up (503), failing or rate limited: fall back to the in-app parser
      const r = local();
      draft(r, text, r.understood && !hasDevanagari(text) ? 'app' : 'fallback');
    }
  }

  function pause() {
    state = 'paused';
    orb.classList.remove('listening');
    orb.setAttribute('aria-label', 'Keep talking');
    status.textContent = transcript() ? 'Paused. Tap the mic to keep talking, or tap Done.' : 'Paused. Tap the mic and speak.';
  }
  function resume() {
    if (state !== 'paused') return;
    state = 'listening';
    orb.classList.add('listening');
    orb.setAttribute('aria-label', 'Done speaking');
    status.textContent = 'Listening… tap Done when you finish';
    startSession(); // runs inside the tap, so Android allows it
  }

  function finish() {
    if (state !== 'listening' && state !== 'paused') return;
    const text = transcript();
    if (!text) { status.textContent = 'I haven’t heard anything yet. Speak, then tap Done.'; return; }
    understand(text);
  }

  const startSession = () => {
    if (!window.isSecureContext) {
      showError('The microphone only works on a secure page. Open Nudge over https (or at http://localhost on this computer), not a plain http network address.', false);
      return;
    }
    try {
      rec = new SpeechRec();
      rec.lang = 'en-IN';
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
    } catch {
      showError('Voice input is not available in this browser.', false);
      return;
    }
    sessions += 1;
    sessionFinals = [];
    sessionHeard = false;
    sessionStart = Date.now();
    rec.onresult = (ev) => {
      sessionHeard = true;
      // rebuilt from the whole result list each time (Android repeats earlier text inside later results)
      const fin = [];
      let inter = '';
      for (let i = 0; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript.trim();
        if (!t) continue;
        if (ev.results[i].isFinal) {
          const last = fin[fin.length - 1];
          if (last && t.toLowerCase().startsWith(last.toLowerCase())) fin[fin.length - 1] = t;
          else fin.push(t);
        } else inter += ' ' + t;
      }
      sessionFinals = fin;
      interim = inter.trim();
      show();
    };
    rec.onerror = (ev) => {
      if (state !== 'listening') return;
      if (ev.error === 'no-speech' || ev.error === 'aborted') return; // a pause: onend restarts
      if (ev.error === 'not-allowed' && sessions > 1) { pause(); return; } // a restart without a tap was refused: not a real block
      if (ev.error === 'not-allowed') {
        showError(`Microphone access is blocked for this site, so the browser will not ask again. ${micHelp()} (code: not-allowed)`);
        return;
      }
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const homeScreen = ios && (navigator.standalone || window.matchMedia('(display-mode: standalone)').matches);
      const msg = {
        'service-not-allowed': ios
          ? `Voice input is turned off on this iPhone. Turn on Settings → General → Keyboard → Enable Dictation${homeScreen ? ', or open nudge.grittaai.com in the Safari app (the home-screen app may not allow voice)' : ''}, then try again.`
          : 'Voice input is turned off for this site or device. Check the browser’s microphone and voice settings.',
        'audio-capture': 'No microphone was found, or another app is using it.',
        network: 'Voice input needs an internet connection (speech is turned into text online).',
        'language-not-supported': 'This device does not support voice input in Indian English.',
      }[ev.error];
      showError(`${msg || 'Voice input stopped unexpectedly.'} (code: ${ev.error})`, ev.error !== 'audio-capture');
    };
    rec.onend = () => {
      // keep what this session heard (an unfinished phrase counts too), then keep listening until Done
      finals.push(...sessionFinals);
      if (interim) finals.push(interim);
      sessionFinals = [];
      interim = '';
      show();
      if (state !== 'listening') return;
      if (Date.now() - startedAt > VOICE_MAX_MS) { finish(); return; }
      if (tapToResume) { pause(); return; }
      quickEnds = !sessionHeard && Date.now() - sessionStart < 1000 ? quickEnds + 1 : 0;
      if (quickEnds >= 5) { showError('The microphone keeps stopping. Check it, then try again.'); return; }
      startSession();
    };
    try { rec.start(); } catch { showError('Could not start the microphone.'); }
  };
  show();
  startSession();
}

// ---------- sign-in ----------
let gisReady = false;
let gisHandler = () => {};
let googleLoading = null;
function loadGoogle() {
  if (window.google && window.google.accounts) return Promise.resolve();
  if (!googleLoading) {
    googleLoading = new Promise((resolve, reject) => {
      const s = h('script', { src: 'https://accounts.google.com/gsi/client', async: true, defer: true });
      s.onload = resolve;
      s.onerror = () => { googleLoading = null; reject(new Error('load failed')); };
      document.head.append(s);
    });
  }
  return googleLoading;
}

async function signedOut(message) {
  S.me = null;
  S.epoch += 1;
  clear($sheetRoot);
  closeSheet = null;
  setBackgroundInert(false);
  view.shellKey = null;
  renderSignIn(message);
}

async function renderSignIn(message) {
  clear($app);
  const msg = h('div', { class: 'stack' });
  const body = h('div', { class: 'stack' });
  const card = h('div', { class: 'login-card' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('bell')), h('h1', {}, 'Pushup Nudge'), h('span', { class: 'by-line' }, 'by Gritta AI'),
      h('p', { class: 'muted' }, 'Your tasks, with a WhatsApp nudge when they are due.')),
    msg, body);
  $app.append(h('main', { class: 'login-page' }, card));
  const showError = (text) => { clear(msg).append(h('div', { class: 'callout danger', role: 'alert' }, icon('alert-triangle'), h('span', {}, text))); };
  if (message) showError(message);

  let cfg;
  try { cfg = await api('GET', '/api/auth/config'); } catch (e) { showError(e.network ? 'You are offline. Connect to the internet to sign in.' : e.message); return; }

  const done = async () => { stopCountdown(); try { await boot(); } catch (e) { showError(e.message); } };
  let email = '';
  let resendAt = 0;
  let countdown = null;
  const stopCountdown = () => { if (countdown) { clearInterval(countdown); countdown = null; } };

  const renderEmail = () => {
    stopCountdown();
    const input = h('input', { id: 'login-email', class: 'input', type: 'email', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none', required: true, placeholder: 'you@company.com' });
    input.value = email;
    const btn = h('button', { class: 'btn block big', type: 'submit' }, icon('mail'), 'Email me a sign-in code');
    clear(body).append(h('form', { class: 'stack',
      onsubmit: async (ev) => {
        ev.preventDefault();
        email = input.value.trim().toLowerCase();
        btn.disabled = true;
        try { await requestCode(); renderCode(); }
        catch (e) { showError(codeError(e)); }
        finally { btn.disabled = false; }
      },
    }, h('div', { class: 'field' }, h('label', { for: 'login-email' }, 'Work email'), input), btn));
    if (cfg.googleClientId) {
      body.append(h('div', { class: 'divider' }, 'or'), h('div', { class: 'gsi-holder', id: 'gsi-button' }));
      gisHandler = async (resp) => {
        try { await api('POST', '/api/auth/google', { credential: resp.credential }); await done(); }
        catch (e) { showError(e.status === 403 ? 'This Google account is not authorised.' : e.message); }
      };
      loadGoogle().then(() => {
        if (!gisReady) {
          gisReady = true;
          window.google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: (r) => gisHandler(r) });
        }
        const holder = document.getElementById('gsi-button');
        if (holder) window.google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', shape: 'pill', width: 300 });
      }).catch(() => {});
    }
    if (cfg.passwordLogin) {
      body.append(h('p', { class: 'center' }, h('button', { type: 'button', class: 'link-btn', onclick: renderPassword }, 'Admin password sign-in')));
    }
    if (!cfg.emailCode && !cfg.googleClientId && !cfg.passwordLogin) showError('No sign-in method is configured.');
    input.focus();
  };

  const codeError = (e) => (e.network ? 'You are offline. Connect to the internet and try again.'
    : e.status === 429 ? 'Too many attempts, try again in a few minutes.' : e.message);

  const requestCode = async () => {
    await api('POST', '/api/auth/email-code', { email });
    resendAt = Date.now() + 30_000;
  };

  const renderCode = () => {
    clear(msg);
    const input = h('input', {
      id: 'login-code', class: 'input code-input', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      pattern: '[0-9]*', maxlength: '12', 'aria-label': '6-digit code', placeholder: '••••••',
    });
    let busy = false;
    const submit = async () => {
      const code = input.value.replace(/\D/g, '').slice(0, 6);
      if (code.length !== 6 || busy) return;
      busy = true;
      try { await api('POST', '/api/auth/email-code/verify', { email, code }); await done(); }
      catch (e) { showError(e.status === 401 ? 'That code is wrong or has expired. Check it or request a new one.' : codeError(e)); input.select(); }
      finally { busy = false; }
    };
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 6); // paste support: strips spaces and dashes
      if (input.value !== digits) input.value = digits;
      if (digits.length === 6) submit();
    });
    const resend = h('button', { type: 'button', class: 'link-btn', onclick: async () => {
      resend.disabled = true;
      try { await requestCode(); clear(msg).append(h('div', { class: 'callout info' }, icon('mail'), h('span', {}, 'A new code is on its way.'))); tick(); }
      catch (e) { showError(codeError(e)); tick(); }
    } });
    const tick = () => {
      const left = Math.ceil((resendAt - Date.now()) / 1000);
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `Resend in ${left}s` : 'Resend code';
      if (left <= 0) stopCountdown();
    };
    stopCountdown();
    countdown = setInterval(tick, 1000);
    tick();
    clear(body).append(
      h('form', { class: 'stack', onsubmit: (ev) => { ev.preventDefault(); submit(); } },
        h('p', { class: 'muted center', id: 'code-hint' }, 'We sent a 6-digit code to ', h('strong', {}, email), '. It expires in 10 minutes.'),
        h('div', { class: 'field' }, h('label', { for: 'login-code' }, 'Sign-in code'), input),
        h('button', { class: 'btn block big', type: 'submit' }, 'Sign in')),
      h('div', { class: 'row center' }, h('button', { type: 'button', class: 'link-btn', onclick: () => { clear(msg); renderEmail(); } }, 'Use a different email'), h('span', { class: 'spacer' }), resend));
    input.focus();
  };

  const renderPassword = () => {
    stopCountdown();
    clear(msg);
    const em = h('input', { id: 'pw-email', class: 'input', type: 'email', autocomplete: 'username', required: true });
    const pw = h('input', { id: 'pw-pass', class: 'input', type: 'password', autocomplete: 'current-password', required: true });
    const eye = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Show password', 'aria-pressed': 'false', onclick: () => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    } }, icon('eye'));
    const btn = h('button', { class: 'btn block big', type: 'submit' }, 'Sign in');
    clear(body).append(
      h('form', { class: 'stack', onsubmit: async (ev) => {
        ev.preventDefault();
        btn.disabled = true;
        try { await api('POST', '/api/auth/password', { email: em.value, password: pw.value }); pw.value = ''; await done(); }
        catch (e) { showError(e.status === 429 ? 'Too many attempts, try again in a few minutes.' : e.network ? 'You are offline.' : e.message); }
        finally { btn.disabled = false; }
      } },
      h('div', { class: 'field' }, h('label', { for: 'pw-email' }, 'Admin email'), em),
      h('div', { class: 'field' }, h('label', { for: 'pw-pass' }, 'Password'), h('div', { class: 'pw-wrap' }, pw, eye)), btn),
      h('p', { class: 'center' }, h('button', { type: 'button', class: 'link-btn', onclick: renderEmail }, 'Back to email code')));
    em.focus();
  };

  if (!cfg.emailCode) { renderPassword(); if (cfg.googleClientId) { renderEmail(); } } else renderEmail();
}

// ---------- shell ----------
const view = { app: null, drawer: null, header: null, title: null, status: null, content: null, detail: null, route: null, shellKey: null, fab: null };

function route() {
  const m = /^#\/t\/([^/?]+)/.exec(location.hash);
  if (m) {
    try { return { name: 'task', id: decodeURIComponent(m[1]) }; } catch { return { name: 'home' }; } // malformed escape: go home
  }
  const nm = /^#\/nudges(?:\/(\d+))?/.exec(location.hash);
  if (nm) return { name: 'nudges', person: nm[1] ? Number(nm[1]) : null };
  const am = /^#\/admin(?:\/([a-z]+))?/.exec(location.hash);
  if (am) return { name: 'admin', tab: am[1] || 'people' };
  return { name: 'home' };
}
const layout = () => (mqLarge.matches ? 'large' : mqExpanded.matches ? 'expanded' : 'compact');

function renderAll(soft) {
  if (!S.me || !S.active) return; // a signed-out or stolen tab never rebuilds the app
  const r = route();
  const key = layout() + '|' + S.owners.map((o) => o.id + o.level).join(',') + '|' + S.ownerId + '|' + S.me.personId;
  if (!view.app || !view.app.isConnected || view.shellKey !== key) { buildShell(); view.shellKey = key; view.route = null; }
  renderStatus();
  const split = layout() === 'large' && r.name === 'task';
  view.app.classList.toggle('with-detail', split);
  const pageKey = r.name + (r.id || r.tab || r.person || '') + (split ? '|split' : '');
  if (soft && view.route === pageKey) {
    renderHomeList();
    renderDrawerCounts();
    if (r.name === 'task') { if (taskPage && taskPage.id === r.id) refreshTaskPage(r.id); else renderTask(r.id); }
    return;
  }
  view.route = pageKey;
  renderNav(r);
  if (r.name === 'admin') renderAdmin(r);
  else if (r.name === 'nudges') renderNudges(r);
  else if (r.name === 'task' && !split) renderTask(r.id);
  else {
    renderHome();
    if (split) renderTask(r.id);
    else { clear(view.detail); taskPage = null; }
  }
}
window.addEventListener('hashchange', () => { if (closeSheet) closeSheet(); if (S.me && S.active) renderAll(false); });
for (const mq of [mqExpanded, mqLarge]) mq.addEventListener('change', () => { if (S.me && S.active) { view.shellKey = null; renderAll(false); } });

function buildShell() {
  clear($app);
  const admin = isAdmin();
  view.status = h('button', { type: 'button', class: 'icon-btn', onclick: () => sync('manual') });
  view.title = h('h1', {});
  const who = h('button', { type: 'button', class: 'who', onclick: ownersSheet, 'aria-label': 'Switch list' });
  const avatarBtn = h('button', { type: 'button', class: 'icon-btn avatar-btn', 'aria-label': 'Account and settings', onclick: openMenu },
    h('span', { class: 'avatar sm' }, initials(S.me.name || S.me.email)));
  view.who = who;
  view.header = h('header', { class: 'topbar' }, who, view.title, view.status, avatarBtn);
  view.content = h('main', { class: 'content', id: 'main', tabindex: '-1' });
  view.detail = h('aside', { class: 'detail', 'aria-label': 'Task details' });
  view.fab = h('div', { class: 'fab-stack' },
    voiceSupported && h('button', { type: 'button', class: 'fab-mic', id: 'fab-mic', 'aria-label': 'Say a task', title: 'Say a task', onclick: () => voiceSheet() }, icon('mic')),
    h('button', { type: 'button', class: 'fab', id: 'fab-new', onclick: () => newTaskSheet() }, icon('plus'), h('span', {}, 'New task')));

  // navigation drawer (expanded layouts)
  view.drawerLists = h('div', { class: 'stack-0' });
  view.drawer = h('nav', { class: 'drawer', 'aria-label': 'Navigation' },
    h('div', { class: 'brand-row' }, h('div', { class: 'logo' }, icon('bell')), h('span', { class: 'brand-text' }, h('span', { class: 'title-l' }, 'Pushup Nudge'), h('span', { class: 'by-line' }, 'by Gritta AI'))),
    h('div', { class: 'drawer-new', id: 'drawer-new' },
      h('button', { type: 'button', class: 'fab', id: 'fab-new-drawer', onclick: () => newTaskSheet() }, icon('plus'), h('span', {}, 'New task')),
      voiceSupported && h('button', { type: 'button', class: 'icon-btn tonal drawer-mic', id: 'drawer-mic', 'aria-label': 'Say a task', title: 'Say a task', onclick: () => voiceSheet() }, icon('mic'))),
    h('div', { class: 'nav-label' }, 'Lists'), view.drawerLists,
    h('div', { class: 'sheet-divider' }),
    admin && h('a', { class: 'nav-item', href: '#/admin', 'data-nav': 'admin' }, icon('settings'), h('span', { class: 'nav-text' }, 'Admin')),
    h('a', { class: 'nav-item', href: '#/nudges', 'data-nav': 'nudges' }, icon('bell-ring'), h('span', { class: 'nav-text' }, 'My nudges')),
    h('div', { class: 'user-card' }, h('span', { class: 'avatar' }, initials(S.me.name || S.me.email)),
      h('span', { class: 'li-body' }, h('span', { class: 'title-s' }, S.me.name || S.me.email), h('span', { class: 'small muted' }, S.me.email)),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Sign out', onclick: signOut }, icon('log-out'))));
  view.app = h('div', { class: 'app' }, view.drawer, h('div', { class: 'main-col' }, view.header, view.content, view.fab), view.detail);
  $app.append(view.app);
  const onScroll = () => view.header.classList.toggle('scrolled', window.scrollY > 4);
  window.removeEventListener('scroll', view.onScroll || (() => {}));
  view.onScroll = onScroll;
  window.addEventListener('scroll', onScroll, { passive: true });
}

function renderNav(r) {
  // drawer lists + current item
  clear(view.drawerLists);
  for (const o of S.owners) {
    const mine = o.id === myOwnerId();
    view.drawerLists.append(h('button', { type: 'button', class: 'nav-item', 'data-owner': o.id, 'aria-current': String((r.name === 'home' || r.name === 'task') && o.id === S.ownerId), onclick: () => selectOwner(o.id) },
      h('span', { class: 'avatar' }, initials(o.name)), h('span', { class: 'nav-text' }, mine ? 'My tasks' : o.name),
      o.level === 'view' && h('span', { class: 'sr-only' }, 'view only'), o.level === 'view' && icon('eye', 'xs'),
      h('span', { class: 'nav-count' }, String(openCount(o.id) || ''))));
  }
  const adm = view.drawer.querySelector('[data-nav="admin"]');
  if (adm) adm.setAttribute('aria-current', r.name === 'admin' || (r.name === 'nudges' && r.person !== null) ? 'page' : 'false');
  const nud = view.drawer.querySelector('[data-nav="nudges"]');
  if (nud) nud.setAttribute('aria-current', r.name === 'nudges' && r.person === null ? 'page' : 'false');
  // top bar: on phones the title is the list switcher
  const page = r.name === 'admin' ? 'Admin' : r.name === 'nudges' ? (r.person === null ? 'My nudges' : 'Nudge settings') : null;
  const t = page || listTitle();
  view.title.textContent = t;
  const o = ownerOf(S.ownerId);
  fill(view.who, h('span', { class: 'title-l' }, t), S.owners.length > 1 && icon('chevrons-up-down', 'sm'));
  view.who.hidden = !!page;
  view.title.hidden = !page && layout() === 'compact';
  view.header.hidden = r.name === 'task' && layout() !== 'large';
  view.fab.hidden = r.name !== 'home' && !(r.name === 'task' && layout() === 'large') || S.ownerId === null || !canEditOwner(S.ownerId);
  const fab2 = view.drawer.querySelector('#drawer-new');
  if (fab2) fab2.hidden = S.ownerId === null || !canEditOwner(S.ownerId);
}
function renderDrawerCounts() {
  if (!view.drawerLists) return;
  for (const el of view.drawerLists.querySelectorAll('[data-owner]')) {
    const c = el.querySelector('.nav-count');
    if (c) c.textContent = String(openCount(Number(el.dataset.owner)) || '');
  }
}

function renderStatus() {
  if (!view.status) return;
  const n = S.outbox.length;
  const offline = !S.online;
  const text = offline ? (n ? `Offline, ${n} change${n > 1 ? 's' : ''} waiting to sync` : 'Offline')
    : S.syncing ? 'Syncing' : n ? `${n} change${n > 1 ? 's' : ''} waiting to sync` : 'All changes saved';
  view.status.setAttribute('aria-label', `${text}. Sync now`);
  view.status.title = text;
  clear(view.status).append(icon(offline ? 'cloud-off' : S.syncing ? 'refresh-cw' : 'cloud'), h('span', { class: 'status-dot ' + (offline ? 'off' : n || S.syncing ? 'wait' : 'on') }));
}

function ownersSheet() {
  if (S.owners.length <= 1) return;
  const content = h('div', {});
  const close = openSheet(content, { label: 'Lists' });
  content.append(...sheetHead('Lists', 'Your own list and the lists shared with you'),
    h('div', { class: 'list' }, S.owners.map((o) => listItem({
      lead: h('span', { class: 'avatar' }, initials(o.name)), head: o.id === myOwnerId() ? 'My tasks' : o.name,
      sub: [`${openCount(o.id)} open`, o.level === 'view' ? ' · View only' : ''].join(''),
      trail: o.id === S.ownerId ? icon('check', 'sm') : null, attrs: { 'aria-current': String(o.id === S.ownerId) },
      onclick: () => { close(); selectOwner(o.id); },
    }))));
}

function openMenu() {
  const content = h('div', {});
  const close = openSheet(content, { label: 'Account' });
  content.append(
    h('div', { class: 'sheet-head' }, h('span', { class: 'avatar' }, initials(S.me.name || S.me.email)),
      h('div', { class: 'li-body' }, h('span', { class: 'title-m' }, S.me.name || S.me.email), h('span', { class: 'muted' }, S.me.email))),
    h('div', { class: 'list' },
      S.owners.length > 1 && listItem({ lead: icon('users'), head: 'Switch list', trail: icon('chevron-right', 'sm'), onclick: () => ownersSheet() }),
      listItem({ lead: icon('bell-ring'), head: 'My nudges', sub: 'Timing, quiet hours, where nudges go · test', onclick: () => { close(); location.hash = '#/nudges'; } }),
      isAdmin() && listItem({ lead: icon('settings'), head: 'Admin', sub: 'People, access and notification settings', onclick: () => { close(); location.hash = '#/admin'; } }),
      listItem({ lead: icon('refresh-cw'), head: 'Sync now', onclick: () => { close(); sync('manual'); } }),
      h('div', { class: 'sheet-divider' }),
      listItem({ lead: icon('log-out'), head: 'Sign out', onclick: () => { close(); signOut(); } })));
}

async function signOut() {
  if (S.outbox.length) {
    const ok = await new Promise((resolve) => {
      const content = h('div', {});
      const close = openSheet(content, { label: 'Unsynced changes' });
      content.append(
        ...sheetHead('Sign out with unsynced changes?', `${S.outbox.length} change${S.outbox.length > 1 ? 's have' : ' has'} not synced yet and will be lost if you sign out.`),
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'btn text', 'data-autofocus': true, onclick: () => { close(); resolve(false); } }, 'Stay signed in'),
          h('button', { type: 'button', class: 'btn danger', onclick: () => { close(); resolve(true); } }, 'Sign out anyway')));
    });
    if (!ok) return;
  }
  try { await api('POST', '/api/auth/logout', {}); } catch (e) {
    if (e.network) { toast('You are offline. Connect to sign out.', { kind: 'error' }); return; }
  }
  await wipeLocal();
  S.tasks = new Map(); S.outbox = []; S.owners = []; S.meta = {}; S.loaded = false;
  view.app = null;
  signedOut();
}

/** Wipes everything stored for the signed-in person. Sets a new epoch first so no in-flight sync writes after the wipe. */
async function wipeLocal() {
  S.epoch += 1;
  S.wiping = true;
  try {
    clearTimeout(syncTimer);
    try { await writeChain; } catch { /* a failed write is irrelevant now */ }
    try { await idb.clearAll(); } catch { /* nothing stored */ }
    store.remove('nudge.owner');
    await wipeCaches();
  } finally {
    S.wiping = false;
  }
}

async function wipeCaches() {
  try {
    for (const k of await caches.keys()) await caches.delete(k);
    if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'PRECACHE' });
  } catch { /* no Cache API */ }
}

// ---------- home ----------
function ownerTasks() {
  return [...S.tasks.values()].filter((t) => t.ownerPersonId === S.ownerId && !t.deleted);
}

function renderHome() {
  clear(view.content);
  view.content.className = 'content';
  const viewOnly = S.ownerId !== null && !canEditOwner(S.ownerId);
  const viewSwitch = S.ownerId !== null && h('div', { class: 'view-switch' },
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' },
      [['list', 'List', 'list-checks'], ['calendar', 'Calendar', 'calendar-days']].map(([v, l, ic]) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(S.homeView === v), 'data-view': v,
        onclick: () => { if (S.homeView === v) return; S.homeView = v; store.set('nudge.view', v); renderHome(); },
      }, icon(ic, 'xs'), l))));
  view.content.append(h('div', { class: 'list-pane' },
    viewOnly && h('div', { class: 'pad' }, h('div', { class: 'callout info' }, icon('eye'), h('span', {}, 'View only. You can read this list but not change it.'))),
    viewSwitch,
    h('div', { id: 'home-list' })));
  renderHomeList();
}

// ---------- calendar view ----------
const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Month grid (IST) with a dot on days that have tasks, and the selected day's tasks below it. */
function renderCalendar(box) {
  const now = nowMs();
  const todayKey = dayKey(now);
  if (!S.cal) { const p = istParts(now); S.cal = { year: p.year, month: p.month, sel: todayKey }; }
  const tasks = ownerTasks();
  const m = calendarMonth(S.cal.year, S.cal.month, tasks, now);
  const redraw = (focus) => {
    renderHomeList();
    if (focus) { const el = document.querySelector('.cal-day[aria-pressed="true"]'); if (el) el.focus(); }
  };
  const go = (d) => { const n = shiftMonth(S.cal.year, S.cal.month, d); S.cal.year = n.year; S.cal.month = n.month; redraw(false); };
  const select = (key, focus) => {
    const [y, mo] = key.split('-').map(Number);
    S.cal = { year: y, month: mo, sel: key };
    redraw(focus);
  };
  const moveBy = (days) => select(dayKey(dayKeyStart(S.cal.sel) + days * DAY_MS + 12 * 3_600_000), true);
  const grid = h('div', { class: 'cal-grid', role: 'group', 'aria-label': `${m.label}, choose a day`,
    onkeydown: (ev) => {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
      if (step) { ev.preventDefault(); moveBy(step); }
    } },
  m.weeks.flat().map((c) => {
    const n = c.open + c.overdue + c.done;
    const dot = c.overdue ? 'overdue' : c.open ? 'open' : c.done ? 'done' : null;
    const label = `${fmtDayKey(c.key)}${c.today ? ', today' : ''}${n ? `, ${n} task${n > 1 ? 's' : ''}${c.overdue ? `, ${c.overdue} overdue` : ''}` : ', no tasks'}`;
    return h('button', {
      type: 'button', class: 'cal-day' + (c.inMonth ? '' : ' out') + (c.today ? ' today' : '') + (c.past ? ' past' : ''),
      'aria-pressed': String(c.key === S.cal.sel), 'aria-label': label, tabindex: c.key === S.cal.sel ? '0' : '-1',
      onclick: () => select(c.key, true),
    }, h('span', { class: 'cal-num' }, String(c.day)), dot ? h('span', { class: 'cal-dot ' + dot, 'aria-hidden': 'true' }) : h('span', { class: 'cal-dot none', 'aria-hidden': 'true' }));
  }));
  const dayTasks = tasksOnDay(tasks, S.cal.sel);
  const editable = canEditOwner(S.ownerId);
  const canAddHere = editable && S.cal.sel >= todayKey;
  const addForDay = () => newTaskSheet(S.cal.sel > todayKey ? { dueIso: new Date(dayKeyStart(S.cal.sel) + 9 * 3_600_000).toISOString() } : undefined);
  const undated = tasks.filter((t) => !t.deleted && !t.dueAt && t.status !== 'done').length;
  const dayTitle = S.cal.sel === todayKey ? `Today · ${fmtDayKey(S.cal.sel)}` : fmtDayKey(S.cal.sel);
  box.append(...[
    h('div', { class: 'cal' },
      h('div', { class: 'cal-head' },
        h('h2', { class: 'cal-title', 'aria-live': 'polite' }, m.label),
        h('span', { class: 'spacer' }),
        S.cal.sel !== todayKey || S.cal.month !== istParts(now).month || S.cal.year !== istParts(now).year ? h('button', { type: 'button', class: 'btn text', id: 'cal-today', onclick: () => select(todayKey, true) }, 'Today') : null,
        h('button', { type: 'button', class: 'icon-btn', id: 'cal-prev', 'aria-label': 'Previous month', onclick: () => go(-1) }, icon('chevron-left')),
        h('button', { type: 'button', class: 'icon-btn', id: 'cal-next', 'aria-label': 'Next month', onclick: () => go(1) }, icon('chevron-right'))),
      h('div', { class: 'cal-grid cal-weekdays', 'aria-hidden': 'true' }, WEEKDAY_LETTERS.map((d) => h('span', {}, d))),
      grid,
      h('div', { class: 'cal-legend', 'aria-hidden': 'true' },
        h('span', {}, h('span', { class: 'cal-dot open' }), 'Due'), h('span', {}, h('span', { class: 'cal-dot overdue' }), 'Overdue'), h('span', {}, h('span', { class: 'cal-dot done' }), 'Done'))),
    h('section', { 'aria-label': dayTitle },
      h('h2', { class: 'subhead' }, dayTitle, h('span', { class: 'count' }, String(dayTasks.length || ''))),
      dayTasks.length
        ? h('ul', { class: 'list' }, dayTasks.map((t) => taskRow(t)))
        : h('div', { class: 'cal-empty' }, h('p', { class: 'muted' }, 'Nothing due this day.'),
          canAddHere && h('button', { type: 'button', class: 'btn tonal', id: 'cal-add', onclick: addForDay }, icon('plus'), 'Add a task')),
      dayTasks.length > 0 && canAddHere && h('div', { class: 'cal-add-row' }, h('button', { type: 'button', class: 'btn text', id: 'cal-add', onclick: addForDay }, icon('plus'), 'Add a task on this day'))),
    undated > 0 && h('p', { class: 'cal-note small muted' }, `${undated} open task${undated > 1 ? 's have' : ' has'} no date. `,
      h('button', { type: 'button', class: 'link-btn', onclick: () => { S.homeView = 'list'; store.set('nudge.view', 'list'); renderHome(); } }, 'See them in List view')),
    h('div', { class: 'cal-end', 'aria-hidden': 'true' }),
  ].filter(Boolean)); // native append would print a skipped `cond && el` as "false"
  const sel = route().name === 'task' ? route().id : null;
  if (sel) { const row = box.querySelector(`[data-id="${CSS.escape(sel)}"] .task`); if (row) row.classList.add('selected'); }
}

function section(key, title, tasks, cls, collapsible) {
  if (tasks.length === 0) return null;
  const open = !collapsible || S.showDone;
  const head = collapsible
    ? h('button', { type: 'button', class: 'subhead', 'aria-expanded': String(open), onclick: () => { S.showDone = !S.showDone; renderHomeList(); } },
      icon(open ? 'chevron-down' : 'chevron-right', 'sm'), title, h('span', { class: 'count' }, String(tasks.length)))
    : h('h2', { class: 'subhead' + (cls === 'overdue' ? ' error' : '') }, title, h('span', { class: 'count' }, String(tasks.length)));
  return h('section', { 'aria-label': title }, head, open && h('ul', { class: 'list' }, tasks.map((t) => taskRow(t))));
}

function renderHomeList() {
  const box = document.getElementById('home-list');
  if (!box || !S.me) return;
  clear(box);
  if (!S.loaded && S.tasks.size === 0 && S.online) {
    box.append(h('div', { 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
    return;
  }
  if (S.me.role === 'superadmin' && S.me.personId === null) {
    box.append(h('div', { class: 'empty' }, h('div', { class: 'icon-wrap' }, icon('list-checks', 'xl')), h('h2', {}, 'Create your task list'),
      h('p', {}, 'You manage Pushup Nudge as the owner. Create your own list to add tasks and get nudges too.'),
      h('button', { type: 'button', class: 'btn', id: 'create-self', onclick: createSelf }, icon('plus'), 'Create my task list')));
    if (S.ownerId === null) return;
  }
  if (S.homeView === 'calendar' && S.ownerId !== null) { renderCalendar(box); return; }
  const g = groupTasks(ownerTasks(), nowMs());
  const activeCount = g.overdue.length + g.today.length + g.upcoming.length + g.none.length;
  if (S.ownerId !== null && activeCount === 0) {
    const editable = canEditOwner(S.ownerId);
    box.append(h('div', { class: 'empty' }, h('div', { class: 'icon-wrap' }, icon('circle-check-big', 'xl')),
      h('h2', {}, g.done.length ? 'All done' : 'Nothing to do'),
      h('p', {}, editable ? 'Add a task with a due time and we will nudge you on WhatsApp before it is due.' : 'There are no open tasks in this list.'),
      editable && h('button', { type: 'button', class: 'btn tonal', onclick: () => newTaskSheet() }, icon('plus'), 'New task')));
  }
  const sel = route().name === 'task' ? route().id : null;
  for (const s of [
    section('overdue', 'Overdue', g.overdue, 'overdue'), section('today', 'Today', g.today, 'today'),
    section('upcoming', 'Upcoming', g.upcoming, 'upcoming'), section('none', 'No date', g.none, 'none'),
    section('done', 'Completed', g.done, 'done', true),
  ]) if (s) box.append(s);
  if (sel) { const row = box.querySelector(`[data-id="${CSS.escape(sel)}"] .task`); if (row) row.classList.add('selected'); }
  if (S.ownerId !== null && canEditOwner(S.ownerId) && activeCount > 0 && !store.get('nudge.swipeHint') && !mqExpanded.matches) {
    box.append(h('p', { class: 'small muted center pad' }, 'Tip: swipe a task right to complete it, left to snooze.'));
  }
}

/** Swipe right = done, swipe left = snooze (touch only). The row follows the finger via a CSS variable (no inline style). */
function attachSwipe(wrap, row, link, t) {
  const THRESH = 88;
  let sx = null; let sy = 0; let dx = 0; let dragging = false; let swallow = false;
  const doneBg = wrap.querySelector('.swipe-bg.done');
  const snBg = wrap.querySelector('.swipe-bg.snooze');
  const set = (x) => {
    row.style.setProperty('--dx', `${x}px`);
    const p = Math.min(1, Math.abs(x) / THRESH);
    doneBg.style.setProperty('opacity', x > 0 ? String(p) : '0');
    snBg.style.setProperty('opacity', x < 0 ? String(p) : '0');
  };
  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.button !== 0) return;
    sx = e.clientX; sy = e.clientY; dx = 0; dragging = false;
  });
  row.addEventListener('pointermove', (e) => {
    if (sx === null) return;
    const mx = e.clientX - sx; const my = e.clientY - sy;
    if (!dragging) {
      if (Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my) * 1.4) { dragging = true; row.classList.add('dragging'); try { row.setPointerCapture(e.pointerId); } catch { /* ok */ } }
      else if (Math.abs(my) > 12) { sx = null; return; }
      else return;
    }
    dx = t.status === 'done' ? Math.max(0, mx) : mx;
    set(dx);
  });
  const end = () => {
    if (sx === null) return;
    sx = null;
    if (!dragging) return;
    row.classList.remove('dragging');
    swallow = true;
    setTimeout(() => { swallow = false; }, 350);
    const go = dx;
    set(0);
    if (go > THRESH) { store.set('nudge.swipeHint', '1'); if (t.status === 'done') actOn(t.id, 'reopen'); else markDone(t.id); }
    else if (go < -THRESH && t.status !== 'done') { store.set('nudge.swipeHint', '1'); snoozeSheet(t.id); }
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', () => { sx = null; dragging = false; row.classList.remove('dragging'); set(0); });
  link.addEventListener('click', (e) => { if (swallow) { e.preventDefault(); swallow = false; } });
}

function taskRow(t) {
  const now = nowMs();
  const editable = canEditOwner(t.ownerPersonId);
  const done = t.status === 'done';
  const chip = t.dueAt && !done ? dueChip(t.dueAt, now) : null;
  const prog = checklistProgress(t);
  const today = chip && !chip.overdue && Date.parse(t.dueAt) - now < 86_400_000;
  const meta = [
    chip && h('span', { class: 'meta' + (chip.overdue ? ' overdue' : today ? ' today' : '') }, icon(chip.overdue ? 'alarm-clock' : 'calendar'), chip.text),
    t.dueAt && done && h('span', { class: 'meta' }, icon('check'), `Done ${t.completedAt ? fmtDateTime(Date.parse(t.completedAt), now) : ''}`.trim()),
    isSnoozed(t, now) && h('span', { class: 'meta' }, icon('alarm-clock'), `Snoozed · ${fmtTime(Date.parse(t.snoozedUntil))}`),
    prog && h('span', { class: 'meta' }, icon('list-checks'), `${prog.done}/${prog.total}`),
    (t.priority === 'high' || t.priority === 'urgent') && h('span', { class: 'meta' }, icon('flag', `p-${t.priority}-c`), cap(t.priority)),
    t.version === 0 && h('span', { class: 'meta' }, icon('cloud-off'), 'Not synced'),
  ];
  const href = '#/t/' + encodeURIComponent(t.id);
  const link = h('a', { class: 'task-main', href },
    h('span', { class: 'task-title' }, t.title), meta.some(Boolean) && h('span', { class: 'task-meta' }, meta),
    h('span', { class: 'sr-only' }, `${t.priority} priority${done ? ', completed' : ''}`));
  const row = h('div', { class: `task p-${t.priority}` + (done ? ' is-done' : '') },
    h('span', { class: 'ring', 'aria-hidden': 'true' }, icon('check', 'xs')),
    link,
    h('span', { class: 'task-actions' },
      editable && !done && h('button', { type: 'button', class: 'icon-btn hover-act', 'aria-label': `Snooze: ${t.title}`, title: 'Snooze', onclick: () => snoozeSheet(t.id) }, icon('alarm-clock', 'sm')),
      editable && h('button', { type: 'button', class: 'icon-btn hover-act', 'aria-label': done ? `Reopen: ${t.title}` : `Mark done: ${t.title}`, title: done ? 'Reopen' : 'Mark done',
        onclick: () => (done ? actOn(t.id, 'reopen') : markDone(t.id)) }, icon(done ? 'rotate-ccw' : 'circle-check-big', 'sm')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `More actions: ${t.title}`, disabled: !editable, onclick: () => taskActions(t.id) }, icon('ellipsis-vertical'))));
  const wrap = h('li', { class: 'task-wrap', 'data-id': t.id },
    h('div', { class: 'swipe-bg done', 'aria-hidden': 'true' }, icon(done ? 'rotate-ccw' : 'circle-check-big'), done ? 'Reopen' : 'Done'),
    h('div', { class: 'swipe-bg snooze', 'aria-hidden': 'true' }, 'Snooze', icon('alarm-clock')),
    row);
  if (editable) attachSwipe(wrap, row, link, t);
  return wrap;
}

async function createSelf() {
  if (!S.active) return;
  try {
    await api('POST', '/api/people/self', {});
    S.me = await api('GET', '/api/me');
    S.meta.me = S.me;
    persist({ meta: { me: S.me } });
    store.set('nudge.owner', '');
    S.forceFull = true;
    await sync('self');
    S.ownerId = null;
    chooseOwner();
    view.shellKey = null;
    renderAll(false);
    toast('Your task list is ready');
  } catch (e) { toast(e.network ? 'You are offline.' : e.message, { kind: 'error' }); }
}

// ---------- task detail (page on phones, pane on large screens) ----------
let taskPage = null; // { id, refs, editable, mount }

function renderTask(id) {
  const split = layout() === 'large';
  const mount = split ? view.detail : view.content;
  clear(mount);
  if (!split) view.content.className = 'content page';
  taskPage = null;
  const t = S.tasks.get(id);
  const backBtn = h('a', { class: 'icon-btn', href: '#/', 'aria-label': split ? 'Close details' : 'Back to tasks' }, icon(split ? 'x' : 'arrow-left'));
  if (!t) {
    mount.append(h('div', { class: 'page-head' }, backBtn), S.loaded || !S.online
      ? h('div', { class: 'empty' }, h('div', { class: 'icon-wrap' }, icon('info', 'xl')), h('h2', {}, 'Task not found'), h('p', {}, 'It may have been deleted, or it is not shared with you.'),
        h('a', { class: 'btn tonal', href: '#/' }, 'Back to tasks'))
      : h('div', { 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
    return;
  }
  const editable = canEditOwner(t.ownerPersonId);
  const refs = {};
  const owner = ownerOf(t.ownerPersonId);
  refs.save = h('span', { class: 'save-state', 'aria-live': 'polite' });

  const title = h('textarea', { class: 'title-input', rows: '1', maxlength: '200', 'aria-label': 'Title', disabled: !editable });
  title.value = t.title;
  title.addEventListener('input', () => { autoRows(title); if (title.value.trim()) editTask(id, { title: title.value.trim() }); });
  title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { if (!title.value.trim()) title.value = S.tasks.get(id).title; });
  refs.title = title;

  refs.status = [['todo', 'To do'], ['in_progress', 'In progress'], ['done', 'Done']].map(([v, l]) =>
    h('button', { type: 'button', role: 'radio', 'data-v': v, disabled: !editable, onclick: () => setStatus(id, v) }, h('span', { class: 'check-ic' }, icon('check', 'xs')), l));

  refs.dueVal = h('span', { class: 'li-val' });
  refs.prioVal = h('span', { class: 'li-val' });
  refs.prioIcon = h('span', {});
  refs.snoozeVal = h('span', { class: 'li-val' });
  const prop = (lead, label, val, onclick) => listItem({ lead, head: label, sub: val, onclick: editable ? onclick : undefined, trail: editable ? icon('chevron-right', 'sm') : null });

  const notes = h('textarea', { class: 'textarea', id: 'notes', maxlength: '10000', placeholder: 'Add notes…', 'aria-label': 'Notes', disabled: !editable });
  notes.value = t.notes;
  notes.addEventListener('input', () => editTask(id, { notes: notes.value }));
  refs.notes = notes;

  refs.checklist = h('div', {});
  refs.clAdd = h('input', { type: 'text', maxlength: '300', placeholder: 'Add a step', 'aria-label': 'New checklist item', disabled: !editable,
    onkeydown: (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const text = refs.clAdd.value.trim();
      const cur = S.tasks.get(id);
      if (!text || cur.checklist.length >= MAX_CHECKLIST) return;
      editTask(id, { checklist: [...cur.checklist, { id: crypto.randomUUID(), text, done: false }] });
      refs.clAdd.value = '';
      renderChecklist(id, refs, true);
    } });
  refs.clAddRow = h('label', { class: 'cl-add' }, icon('plus'), refs.clAdd);
  refs.clNote = h('span', { class: 'small muted' });
  refs.activity = h('ul', { class: 'timeline' });
  refs.doneBtn = h('button', { type: 'button', class: 'btn big', disabled: !editable, onclick: () => {
    const cur = S.tasks.get(id);
    if (cur.status === 'done') actOn(id, 'reopen'); else markDone(id);
  } });
  refs.snoozeBtn = h('button', { type: 'button', class: 'btn tonal big', disabled: !editable, onclick: () => snoozeSheet(id) }, icon('alarm-clock'), 'Snooze');

  const more = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete task', title: 'Delete task', disabled: !editable,
    onclick: () => confirmDelete(id, () => { location.hash = '#/'; }) }, icon('trash-2'));
  fill(mount,
    h('div', { class: 'page-head' }, backBtn, h('span', { class: 'spacer' }), refs.save, more),
    h('div', { class: 'detail-body' },
      !editable && h('div', { class: 'callout info' }, icon('eye'), h('span', {}, 'View only. You can read this task but not change it.')),
      title,
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Status' }, refs.status),
      h('div', { class: 'card prop-list' },
        prop(icon('calendar'), 'Due', refs.dueVal, () => dueSheet(S.tasks.get(id).dueAt, (iso) => editTask(id, { dueAt: iso }))),
        prop(refs.prioIcon, 'Priority', refs.prioVal, () => prioritySheet(S.tasks.get(id).priority, (p) => editTask(id, { priority: p }))),
        prop(icon('alarm-clock'), 'Snooze', refs.snoozeVal, () => snoozeSheet(id)),
        listItem({ lead: h('span', { class: 'avatar sm' }, initials(owner ? owner.name : '?')), head: 'List', sub: h('span', { class: 'li-val' }, owner ? (owner.id === myOwnerId() ? 'My tasks' : owner.name) : 'Unknown') })),
      h('div', {}, h('div', { class: 'block-label' }, icon('pencil', 'sm'), 'Notes'), notes),
      h('div', {}, h('div', { class: 'block-label' }, icon('list-checks', 'sm'), 'Checklist', h('span', { class: 'spacer' }), refs.clNote),
        h('div', { class: 'card' }, refs.checklist, refs.clAddRow)),
      h('div', {}, h('div', { class: 'block-label' }, icon('history', 'sm'), 'Activity'), h('div', { class: 'card' }, refs.activity))),
    editable && h('div', { class: 'detail-actions' }, refs.snoozeBtn, refs.doneBtn));
  taskPage = { id, refs, editable, mount };
  refreshTaskPage(id, true);
  autoRows(title);
  loadActivity(id, refs);
  if (!split) window.scrollTo(0, 0);
}

function setStatus(id, v) {
  const t = S.tasks.get(id);
  if (!t || t.status === v) return;
  if (v === 'done') return markDone(id);
  if (t.status === 'done') {
    actOn(id, 'reopen');
    if (v === 'in_progress') editTask(id, { status: 'in_progress' });
    return;
  }
  editTask(id, { status: v });
}

function checklistItemSheet(id, item, i, total, refs) {
  const content = h('div', {});
  const close = openSheet(content, { label: 'Checklist item' });
  const save = (items) => { close(); editTask(id, { checklist: items }); renderChecklist(id, refs); };
  const list = () => S.tasks.get(id).checklist.slice();
  content.append(...sheetHead(item.text || 'Checklist item'),
    h('div', { class: 'list' },
      i > 0 && listItem({ lead: icon('arrow-up'), head: 'Move up', onclick: () => { const a = list(); [a[i - 1], a[i]] = [a[i], a[i - 1]]; save(a); } }),
      i < total - 1 && listItem({ lead: icon('arrow-down'), head: 'Move down', onclick: () => { const a = list(); [a[i + 1], a[i]] = [a[i], a[i + 1]]; save(a); } }),
      listItem({ lead: icon('trash-2'), head: 'Delete step', cls: 'danger', onclick: () => save(list().filter((c) => c.id !== item.id)) })));
}

function renderChecklist(id, refs, focusLast) {
  const t = S.tasks.get(id);
  const editable = taskPage && taskPage.editable;
  clear(refs.checklist);
  t.checklist.forEach((item, i) => {
    const input = h('input', { class: 'cl-input', type: 'text', maxlength: '300', 'aria-label': `Step ${i + 1}`, disabled: !editable });
    input.value = item.text;
    input.addEventListener('input', () => {
      const cur = S.tasks.get(id).checklist.map((c) => (c.id === item.id ? { ...c, text: input.value } : c));
      editTask(id, { checklist: cur });
    });
    refs.checklist.append(h('div', { class: 'cl-item' + (item.done ? ' checked' : '') },
      h('button', { type: 'button', class: 'cl-check', 'aria-pressed': String(item.done), 'aria-label': item.done ? 'Mark step not done' : 'Mark step done', disabled: !editable,
        onclick: () => { editTask(id, { checklist: S.tasks.get(id).checklist.map((c) => (c.id === item.id ? { ...c, done: !c.done } : c)) }); renderChecklist(id, refs); } },
      h('span', { class: 'box' }, icon('check', 'xs'))),
      input,
      editable && h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Options for step ${i + 1}`, onclick: () => checklistItemSheet(id, item, i, t.checklist.length, refs) }, icon('ellipsis-vertical', 'sm'))));
  });
  const full = t.checklist.length >= MAX_CHECKLIST;
  refs.clAddRow.hidden = full || !editable;
  refs.clNote.textContent = full ? `Full (${MAX_CHECKLIST} steps)` : t.checklist.length ? `${t.checklist.filter((c) => c.done).length} of ${t.checklist.length}` : '';
  if (focusLast) refs.clAdd.focus();
}

/** Brings the visible controls in line with the stored task. Text fields are only touched when not focused. */
function refreshTaskPage(id, force) {
  if (!taskPage || taskPage.id !== id) return;
  const t = S.tasks.get(id);
  const { refs } = taskPage;
  if (!t) { renderTask(id); return; }
  const focused = document.activeElement;
  const setIfIdle = (el, value) => { if (el !== focused && el.value !== value) el.value = value; };
  setIfIdle(refs.title, t.title);
  setIfIdle(refs.notes, t.notes);
  refs.status.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === t.status)));
  const now = nowMs();
  if (t.dueAt) {
    const ms = Date.parse(t.dueAt);
    refs.dueVal.textContent = `${fmtDateTime(ms, now)} · ${fmtRelative(ms, now)}`;
    refs.dueVal.classList.toggle('overdue', ms < now && t.status !== 'done');
  } else { refs.dueVal.textContent = 'No due date · no nudges'; refs.dueVal.classList.remove('overdue'); }
  refs.prioVal.textContent = cap(t.priority);
  clear(refs.prioIcon).append(icon('flag', `p-${t.priority}-c`));
  const snoozed = isSnoozed(t, now);
  refs.snoozeVal.textContent = snoozed ? `Until ${fmtDateTime(Date.parse(t.snoozedUntil), now)}` : t.status === 'done' ? 'Completed' : 'Not snoozed';
  refs.snoozeBtn.hidden = t.status === 'done';
  clear(refs.doneBtn).append(icon(t.status === 'done' ? 'rotate-ccw' : 'circle-check-big'), t.status === 'done' ? 'Reopen' : 'Mark as done');
  refs.doneBtn.className = 'btn big' + (t.status === 'done' ? ' tonal' : '');
  if (force || !refs.checklist.contains(focused)) renderChecklist(id, refs);
  updateTaskPageState(id);
  // the timeline follows the server version: reload it when a sync brought a newer one
  if (!force && S.online && !pendingFor(id) && t.version > 0 && taskPage.activityVersion !== t.version) loadActivity(id, refs);
}

function updateTaskPageState(id) {
  if (!taskPage || taskPage.id !== id) return;
  const pending = S.outbox.length > 0;
  const el = taskPage.refs.save;
  el.className = 'save-state' + (pending ? ' pending' : '');
  const text = !S.online ? (pending ? 'Offline · will sync' : 'Offline') : pending || S.syncing ? 'Saving…' : 'Saved';
  clear(el).append(icon(!S.online ? 'cloud-off' : pending || S.syncing ? 'refresh-cw' : 'cloud', 'xs'), text);
}

const ACTIVITY = {
  create: ['plus', 'Created'], done: ['circle-check-big', 'Marked done'], reopen: ['rotate-ccw', 'Reopened'], snooze: ['alarm-clock', 'Snoozed'],
  unsnooze: ['bell', 'Snooze cleared'], delete: ['trash-2', 'Deleted'], undelete: ['rotate-ccw', 'Restored'], update: ['pencil', 'Edited'],
};
function activityText(a) {
  const d = a.details || {};
  if (a.action === 'update') return `Edited ${(d.fields || []).join(', ') || 'task'}`;
  if (a.action === 'snooze' && d.changes && d.changes.snoozedUntil && d.changes.snoozedUntil.to) {
    return `Snoozed until ${fmtDateTime(Date.parse(d.changes.snoozedUntil.to), nowMs())}`;
  }
  return (ACTIVITY[a.action] || [null, a.action])[1];
}
async function loadActivity(id, refs) {
  if (taskPage && taskPage.id === id) taskPage.activityVersion = S.tasks.get(id)?.version;
  const msg = (text) => clear(refs.activity).append(h('li', { class: 'muted' }, text));
  if (!S.online || S.tasks.get(id)?.version === 0) { msg('Activity is available when online.'); return; }
  try {
    const list = await api('GET', `/api/app/tasks/${encodeURIComponent(id)}/activity`);
    if (!taskPage || taskPage.id !== id) return;
    clear(refs.activity);
    if (!list.length) msg('No activity yet.');
    for (const a of list) {
      refs.activity.append(h('li', {}, h('span', { class: 'tl-icon' }, icon((ACTIVITY[a.action] || ['info'])[0])),
        h('span', { class: 'li-body' }, h('span', {}, activityText(a)), h('span', { class: 'small muted' }, `${a.actor} · ${fmtDateTime(Date.parse(a.at), nowMs())}`))));
    }
  } catch {
    msg('Activity is available when online.');
  }
}

// ---------- admin ----------
function ctxForAdmin() { return { h, clear, icon, api, toast, openSheet, sheetHead, listItem, S }; }
function renderNudges(r) {
  clear(view.detail);
  view.content.className = 'content page';
  renderNudgeSettingsPage(ctxForAdmin(), view.content, r.person === S.me.personId ? null : r.person);
}

function renderAdmin(r) {
  clear(view.detail);
  view.content.className = 'content page';
  if (!isAdmin()) {
    clear(view.content).append(h('div', { class: 'empty' }, h('div', { class: 'icon-wrap' }, icon('lock', 'xl')), h('h2', {}, 'Admins only'),
      h('p', {}, 'Ask an admin if you need access to settings.'), h('a', { class: 'btn tonal', href: '#/' }, 'Back to tasks')));
    return;
  }
  // the admin area works online only; nothing it does goes through the outbox
  renderAdminPage(ctxForAdmin(), view.content, r.tab);
}

// ---------- service worker ----------
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller; // first install claims the page: that must not reload it
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
  const offer = (worker) => toast('A new version of Pushup Nudge is ready', {
    timeout: 0, action: { label: 'Refresh', fn: () => worker.postMessage({ type: 'SKIP_WAITING' }) },
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}

// ---------- one active tab ----------
// Two tabs would each own an outbox and push it; one tab at a time holds the 'nudge-active' lock for its life.
let activeHeld = false;
function claimActive() {
  if (!navigator.locks || activeHeld) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request('nudge-active', { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return undefined; }
      activeHeld = true;
      resolve(true);
      return new Promise(() => {}); // held until the page goes away (or another tab takes it)
    }).catch(() => { activeHeld = false; goInactive(); }); // stolen by "Use here" in another tab
  });
}

function goInactive() {
  S.active = false;
  S.me = null; // nothing in this tab may render or edit again until it reloads as the active one
  S.epoch += 1;
  clearTimeout(syncTimer);
  clear($sheetRoot);
  closeSheet = null;
  setBackgroundInert(false);
  view.app = null;
  clear($app).append(h('main', { class: 'login-page' }, h('div', { class: 'login-card center' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('bell')), h('h1', {}, 'Pushup Nudge')),
    h('h2', { class: 'title-l' }, 'Nudge is open in another tab'),
    h('p', { class: 'muted' }, 'To keep your changes safe, Nudge runs in one tab at a time.'),
    h('button', { type: 'button', class: 'btn big block', id: 'use-here', onclick: () => {
      navigator.locks.request('nudge-active', { steal: true }, () => { location.reload(); return new Promise(() => {}); }).catch(() => {});
    } }, 'Use here'))));
}

// Keeps sheets and the FAB above the on-screen keyboard where the layout viewport does not shrink (iOS Safari).
function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', kb + 'px');
    document.documentElement.classList.toggle('kb-open', kb > 80);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

// ---------- boot ----------
async function boot() {
  if (!(await claimActive())) { goInactive(); return; }
  let cachedMe;
  try {
    S.tasks = new Map((await idb.getAll('tasks')).map((t) => [t.id, t]));
    S.owners = await idb.getAll('owners');
    S.outbox = (await idb.getAll('outbox')).sort((a, b) => a.seq - b.seq);
    for (const k of ['lastSync', 'me', 'nudgeTarget']) { const v = await idb.getMeta(k); if (v !== undefined) S.meta[k] = v; }
    cachedMe = S.meta.me;
  } catch {
    S.storageOk = false;
    toast('Offline storage is unavailable; changes will not survive a reload.', { kind: 'error' });
  }
  let me;
  try {
    me = await api('GET', '/api/me');
  } catch (e) {
    if (e.network && cachedMe) me = cachedMe; // offline: open with the cached profile
    else if (e.status === 401 || e.network) { renderSignIn(e.network ? 'You are offline. Connect to the internet to sign in.' : undefined); return; }
    else throw e;
  }
  if (cachedMe && cachedMe.email !== me.email) {
    // a different person signed in: nothing of the previous user's data (or unsent edits) may carry over
    await wipeLocal();
    S.tasks = new Map(); S.owners = []; S.outbox = []; S.meta = {};
  }
  S.me = me;
  S.meta.me = me;
  persist({ meta: { me } });
  S.loaded = S.meta.lastSync !== undefined;
  chooseOwner();
  view.app = null;
  renderAll(false);
  startSyncLoop();
}

registerWorker();
trackKeyboard();
boot().catch((e) => {
  console.error('boot failed', e);
  clear($app).append(h('p', { class: 'boot' }, 'Something went wrong starting Nudge. Reload to try again.'));
});
