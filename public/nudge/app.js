// Nudge PWA. Vanilla JS, no build. All user/API text is inserted with textContent or text nodes (never HTML strings).
// Icons are Lucide symbols from icons.svg (ISC licence). Every time shown is Asia/Kolkata (see sync-core.js).
import * as idb from './idb.js';
import { renderAdminPage } from './admin.js';
import {
  applyActionLocal, applyPushed, checklistProgress, diffOutbox, dueChip, enqueue, mergeOutbox, newOwnerIds, fmtDateTime, fmtRelative, fmtTime, groupTasks,
  isoToIstInput, isSnoozed, istAt, istInputToIso, mergePull, newTask, pendingTaskIds, pruneInvisible, pushOutbox, putBody,
  reconcileOutbox, toastReplaces, MAX_CHECKLIST,
} from './sync-core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');
const $alerts = document.getElementById('alerts');
const $sheetRoot = document.getElementById('sheet-root');

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
const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

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
  showDone: false, qa: { due: null, priority: 'medium', title: '' },
  active: true, epoch: 0, wiping: false,
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

function chooseOwner() {
  const saved = Number(store.get('nudge.owner'));
  const mine = myOwnerId();
  if (S.owners.some((o) => o.id === saved)) S.ownerId = saved;
  else if (S.owners.some((o) => o.id === mine)) S.ownerId = mine;
  else S.ownerId = S.owners.length ? S.owners[0].id : null;
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
  scheduleSync();
}
function markDone(id) {
  if (!S.active) return;
  actOn(id, 'done');
  toast('Marked done', { timeout: 5000, action: { label: 'Undo', fn: () => actOn(id, 'reopen') } });
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
    // pull
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
    S.owners = owners;
    const gone = pruneInvisible([...S.tasks.values()], S.owners);
    for (const id of gone) S.tasks.delete(id);
    persist({ owners: { replace: S.owners }, tasks: { remove: gone } });
    if (!S.owners.some((o) => o.id === S.ownerId)) chooseOwner();
    S.loaded = true;
  } catch (e) {
    if (e.status === 401 && !stale()) signedOut('Your session expired. Sign in to continue; your changes are kept.');
    else if (!e.network) console.error('sync failed', e);
  } finally {
    if (S.me && S.ownerId !== ownerBefore) view.route = null; // the list changed: rebuild the page, quick add included
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

// ---------- sheets ----------
let closeSheet = null;
/** While a sheet or dialog is open, everything behind it is inert (no Tab, no taps, hidden from screen readers). */
function setBackgroundInert(on) {
  for (const el of [document.querySelector('.shell'), view.qa]) if (el) el.inert = on;
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
  const first = panel.querySelector('input, button, textarea, select');
  if (first) first.focus();
  return close;
}
function menuItem(iconName, text, fn, cls) {
  return h('button', { type: 'button', class: 'menu-item' + (cls ? ' ' + cls : ''), onclick: fn }, icon(iconName), text);
}

function snoozeSheet(taskId) {
  const t = S.tasks.get(taskId);
  if (!t) return;
  const content = h('div', {});
  const close = openSheet(content, { label: 'Snooze', keepOpen: true });
  const snooze = (m) => { close(); actOn(taskId, 'snooze', m); toast(`Snoozed until ${fmtTime(nowMs() + m * 60_000)}`); };
  const custom = h('input', { class: 'input', type: 'datetime-local', id: 'snooze-custom', 'aria-label': 'Snooze until (IST)' });
  const err = h('p', { class: 'error-text', hidden: true });
  clear(content).append(
    h('h2', {}, 'Snooze'),
    h('p', { class: 'sub' }, 'No nudges until then. Times are IST.'),
    h('div', { class: 'chip-row' },
      [['1 hour', 60], ['2 hours', 120], ['24 hours', 1440]].map(([l, m]) => h('button', { type: 'button', class: 'chip', onclick: () => snooze(m) }, l))),
    h('div', { class: 'field', }, h('label', { for: 'snooze-custom' }, 'Custom'), custom, err),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Cancel'),
      h('button', { type: 'button', class: 'btn', onclick: () => {
        const iso = istInputToIso(custom.value);
        const m = iso ? Math.ceil((Date.parse(iso) - nowMs()) / 60_000) : NaN;
        if (!Number.isFinite(m) || m < 15 || m > 10_080) {
          err.textContent = 'Pick a time between 15 minutes and 7 days from now.';
          err.hidden = false;
          return;
        }
        snooze(m);
      } }, 'Snooze')));
}

function confirmDelete(taskId, after) {
  const t = S.tasks.get(taskId);
  if (!t) return;
  const content = h('div', {});
  const close = openSheet(content, { label: 'Delete task' });
  content.append(
    h('h2', {}, 'Delete this task?'),
    h('p', { class: 'sub' }, t.title),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Cancel'),
      h('button', { type: 'button', class: 'btn danger', onclick: () => { close(); deleteTask(taskId); toast('Task deleted'); if (after) after(); } }, 'Delete')));
}

function rowMenu(taskId) {
  const t = S.tasks.get(taskId);
  if (!t) return;
  const content = h('div', {});
  const close = openSheet(content, { label: 'Task actions' });
  const done = t.status === 'done';
  content.append(
    h('h2', {}, t.title),
    h('div', { class: 'menu-list' },
      !done && menuItem('alarm-clock', 'Snooze 1 hour', () => { close(); actOn(taskId, 'snooze', 60); toast('Snoozed 1 hour'); }),
      !done && menuItem('alarm-clock', 'Snooze 2 hours', () => { close(); actOn(taskId, 'snooze', 120); toast('Snoozed 2 hours'); }),
      !done && menuItem('alarm-clock', 'Snooze 24 hours', () => { close(); actOn(taskId, 'snooze', 1440); toast('Snoozed 24 hours'); }),
      !done && menuItem('clock', 'Snooze custom…', () => snoozeSheet(taskId)),
      isSnoozed(t, nowMs()) && menuItem('rotate-ccw', 'Unsnooze', () => { close(); actOn(taskId, 'unsnooze'); }),
      h('div', { class: 'menu-sep' }),
      done ? menuItem('rotate-ccw', 'Reopen', () => { close(); actOn(taskId, 'reopen'); })
        : menuItem('check', 'Done', () => { close(); markDone(taskId); }),
      menuItem('trash-2', 'Delete', () => confirmDelete(taskId), 'danger')));
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
  renderSignIn(message);
}

async function renderSignIn(message) {
  clear($app);
  const msg = h('div', { class: 'stack' });
  const body = h('div', {});
  const card = h('div', { class: 'login-card' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('bell', 'lg')), h('h1', {}, 'Nudge'),
      h('p', { class: 'muted' }, 'Your tasks, with a nudge when they are due.')),
    msg, body);
  $app.append(h('main', { class: 'login-page' }, card));
  const showError = (text) => { clear(msg).append(h('div', { class: 'callout danger', role: 'alert' }, text)); };
  if (message) showError(message);

  let cfg;
  try { cfg = await api('GET', '/api/auth/config'); } catch (e) { showError(e.network ? 'You are offline. Connect to the internet to sign in.' : e.message); return; }

  const done = async () => { stopCountdown(); try { await boot(); } catch (e) { showError(e.message); } };
  let step = 'email';
  let email = '';
  let resendAt = 0;
  let countdown = null;
  const stopCountdown = () => { if (countdown) { clearInterval(countdown); countdown = null; } };

  const renderEmail = () => {
    stopCountdown();
    const input = h('input', { id: 'login-email', class: 'input', type: 'email', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none', required: true, value: email, placeholder: 'you@company.com' });
    input.value = email;
    const btn = h('button', { class: 'btn block', type: 'submit' }, 'Email me a code');
    clear(body).append(h('form', {
      onsubmit: async (ev) => {
        ev.preventDefault();
        email = input.value.trim().toLowerCase();
        btn.disabled = true;
        try { await requestCode(); step = 'code'; renderCode(); }
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
        if (holder) window.google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', width: 280 });
      }).catch(() => {});
    }
    if (cfg.passwordLogin) {
      body.append(h('p', { class: 'center' }, h('button', { type: 'button', class: 'link-btn small', onclick: renderPassword }, 'Admin password sign-in')));
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
      try { await requestCode(); clear(msg).append(h('div', { class: 'callout' }, 'A new code is on its way.')); tick(); }
      catch (e) { showError(codeError(e)); tick(); }
    } });
    const tick = () => {
      const left = Math.ceil((resendAt - Date.now()) / 1000);
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code';
      if (left <= 0) stopCountdown();
    };
    stopCountdown();
    countdown = setInterval(tick, 1000);
    tick();
    clear(body).append(
      h('form', { onsubmit: (ev) => { ev.preventDefault(); submit(); } },
        h('p', { class: 'muted', id: 'code-hint' }, `We sent a 6-digit code to ${email}. It expires in 10 minutes.`),
        h('div', { class: 'field' }, h('label', { for: 'login-code' }, 'Code'), input),
        h('button', { class: 'btn block', type: 'submit' }, 'Sign in')),
      h('p', { class: 'center' }, resend, h('button', { type: 'button', class: 'link-btn', onclick: () => { clear(msg); step = 'email'; renderEmail(); } }, 'Use a different email')));
    input.focus();
  };

  const renderPassword = () => {
    stopCountdown();
    clear(msg);
    const em = h('input', { id: 'pw-email', class: 'input', type: 'email', autocomplete: 'username', required: true });
    const pw = h('input', { id: 'pw-pass', class: 'input', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn block', type: 'submit' }, 'Sign in');
    clear(body).append(
      h('form', { onsubmit: async (ev) => {
        ev.preventDefault();
        btn.disabled = true;
        try { await api('POST', '/api/auth/password', { email: em.value, password: pw.value }); pw.value = ''; await done(); }
        catch (e) { showError(e.status === 429 ? 'Too many attempts, try again in a few minutes.' : e.network ? 'You are offline.' : e.message); }
        finally { btn.disabled = false; }
      } },
      h('div', { class: 'field' }, h('label', { for: 'pw-email' }, 'Admin email'), em),
      h('div', { class: 'field' }, h('label', { for: 'pw-pass' }, 'Password'), pw), btn),
      h('p', { class: 'center' }, h('button', { type: 'button', class: 'link-btn small', onclick: renderEmail }, 'Back to email code')));
    em.focus();
  };

  if (!cfg.emailCode) { renderPassword(); if (cfg.googleClientId) { renderEmail(); } } else renderEmail();
  void step;
}

// ---------- shell ----------
const view = { header: null, pill: null, owners: null, content: null, qa: null, menuBtn: null, route: null };

function route() {
  const m = /^#\/t\/([^/?]+)/.exec(location.hash);
  if (m) {
    try { return { name: 'task', id: decodeURIComponent(m[1]) }; } catch { return { name: 'home' }; } // malformed escape: go home
  }
  const am = /^#\/admin(?:\/([a-z]+))?/.exec(location.hash);
  if (am) return { name: 'admin', tab: am[1] || 'people' };
  return { name: 'home' };
}

function renderAll(soft) {
  if (!S.me || !S.active) return; // a signed-out or stolen tab never rebuilds the app
  const r = route();
  if (!view.header || !view.header.isConnected) buildShell();
  renderStatus();
  renderOwners();
  const key = r.name + (r.id || r.tab || '');
  if (soft && view.route === key) {
    if (r.name === 'home') renderHomeList();
    else if (r.name === 'task') { if (taskPage && taskPage.id === r.id) refreshTaskPage(r.id); else renderTaskPage(r.id); }
    return;
  }
  view.route = key;
  document.body.classList.toggle('no-qa-page', r.name !== 'home');
  if (r.name === 'home') renderHome();
  else if (r.name === 'task') renderTaskPage(r.id);
  else renderAdmin();
}
window.addEventListener('hashchange', () => { if (S.me && S.active) renderAll(false); });

function buildShell() {
  clear($app);
  view.pill = h('button', { type: 'button', class: 'sync-pill', onclick: () => sync('manual'), 'aria-label': 'Sync status. Tap to sync now' });
  view.menuBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Menu', onclick: openMenu });
  view.owners = h('div', { class: 'owners', role: 'group', 'aria-label': 'Whose tasks' });
  view.header = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-row' }, h('div', { class: 'logo' }, icon('bell')), h('h1', {}, 'Nudge'), view.pill, view.menuBtn),
    view.owners);
  view.content = h('main', { class: 'content', id: 'main' });
  view.qa = h('div', { class: 'quick-add-slot' });
  $app.append(h('div', { class: 'shell' }, view.header, view.content), view.qa);
  view.route = null;
}

function renderStatus() {
  if (!view.pill) return;
  const n = S.outbox.length;
  const offline = !S.online;
  const text = offline ? (n ? `Offline · ${n} waiting to sync` : 'Offline')
    : S.syncing ? 'Syncing…' : n ? `${n} change${n > 1 ? 's' : ''} waiting to sync` : 'Online';
  clear(view.pill).append(h('span', { class: 'dot ' + (offline ? 'off' : n || S.syncing ? 'wait' : 'on') }), h('span', {}, text));
  if (S.me && view.menuBtn) clear(view.menuBtn).append(h('span', { class: 'avatar' }, initials(S.me.name || S.me.email)));
}

function renderOwners() {
  if (!view.owners) return;
  clear(view.owners);
  view.owners.hidden = S.owners.length <= 1 || route().name === 'admin'; // no person switcher on admin pages
  for (const o of S.owners) {
    const mine = o.id === myOwnerId();
    view.owners.append(h('button', {
      type: 'button', class: 'owner-chip', 'aria-pressed': String(o.id === S.ownerId),
      onclick: () => {
        S.ownerId = o.id;
        store.set('nudge.owner', String(o.id));
        if (route().name !== 'home') location.hash = '#/';
        else { renderOwners(); renderHome(); }
      },
    }, h('span', { class: 'avatar' }, initials(o.name)), mine ? 'Me' : o.name, o.level === 'view' && h('span', { class: 'badge view' }, 'View only')));
  }
}

function openMenu() {
  const content = h('div', {});
  const close = openSheet(content, { label: 'Menu' });
  const admin = S.me.role === 'admin' || S.me.role === 'superadmin';
  content.append(
    h('div', { class: 'menu-list' },
      admin && menuItem('shield', 'Admin', () => { close(); location.hash = '#/admin'; }),
      menuItem('user', 'Profile', () => { close(); profileSheet(); }),
      menuItem('refresh-cw', 'Sync now', () => { close(); sync('manual'); }),
      h('div', { class: 'menu-sep' }),
      menuItem('log-out', 'Sign out', () => { close(); signOut(); })));
}

async function profileSheet() {
  const target = h('dd', {}, 'Loading…');
  const content = h('div', {},
    h('div', { class: 'center' }, h('span', { class: 'avatar lg' }, initials(S.me.name || S.me.email))),
    h('h2', { class: 'center' }, S.me.name || S.me.email),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Name'), h('dd', {}, S.me.name || '–'),
      h('dt', {}, 'Email'), h('dd', {}, S.me.email),
      h('dt', {}, 'Role'), h('dd', {}, S.me.role),
      h('dt', {}, 'Nudges go to'), target),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn secondary', onclick: () => close() }, 'Close'),
      h('button', { type: 'button', class: 'btn danger', onclick: () => { close(); signOut(); } }, 'Sign out')));
  const close = openSheet(content, { label: 'Profile' });
  try {
    const t = await api('GET', '/api/app/nudge-target');
    S.meta.nudgeTarget = t;
    persist({ meta: { nudgeTarget: t } });
    target.textContent = nudgeLabel(t);
  } catch {
    target.textContent = S.meta.nudgeTarget ? nudgeLabel(S.meta.nudgeTarget) : 'Available when online';
  }
}
function nudgeLabel(t) {
  if (t.target === 'none') return 'Not set up (no task list yet)';
  const where = t.target === 'dm' ? 'A direct WhatsApp message to you' : t.target === 'group' ? 'A WhatsApp group chosen by your admin' : 'The default WhatsApp group';
  return t.configured ? where : `${where} (not set up yet)`;
}

async function signOut() {
  if (S.outbox.length) {
    const ok = await new Promise((resolve) => {
      const content = h('div', {});
      const close = openSheet(content, { label: 'Unsynced changes' });
      content.append(
        h('h2', {}, 'Sign out with unsynced changes?'),
        h('p', { class: 'sub' }, `${S.outbox.length} change${S.outbox.length > 1 ? 's have' : ' has'} not synced yet and will be lost if you sign out.`),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn secondary', onclick: () => { close(); resolve(false); } }, 'Stay signed in'),
          h('button', { type: 'button', class: 'btn danger', onclick: () => { close(); resolve(true); } }, 'Sign out anyway')));
    });
    if (!ok) return;
  }
  try { await api('POST', '/api/auth/logout', {}); } catch (e) {
    if (e.network) { toast('You are offline. Connect to sign out.', { kind: 'error' }); return; }
  }
  await wipeLocal();
  S.tasks = new Map(); S.outbox = []; S.owners = []; S.meta = {}; S.loaded = false;
  S.qa = { due: null, priority: 'medium', title: '' };
  view.header = null;
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
  view.content.append(h('div', { id: 'home-list' }));
  renderQuickAdd();
  renderHomeList();
}

function sectionEl(key, title, tasks, cls, collapsible) {
  if (tasks.length === 0) return null;
  const open = !collapsible || S.showDone;
  const head = collapsible
    ? h('button', { type: 'button', class: 'section-head', 'aria-expanded': String(open), onclick: () => { S.showDone = !S.showDone; renderHomeList(); } },
      icon(open ? 'chevron-down' : 'chevron-right', 'sm'), title, h('span', { class: 'count' }, String(tasks.length)))
    : h('h2', { class: 'section-head' }, title, h('span', { class: 'count' }, String(tasks.length)));
  return h('section', { class: 'section ' + cls, 'aria-label': title }, head, open && h('ul', { class: 'task-list' }, tasks.map((t) => taskRow(t))));
}

function renderHomeList() {
  const box = document.getElementById('home-list');
  if (!box || route().name !== 'home') return;
  clear(box);
  if (!S.loaded && S.tasks.size === 0 && S.online) {
    box.append(h('div', { 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
    return;
  }
  if (S.me.role === 'superadmin' && S.me.personId === null) {
    box.append(h('div', { class: 'empty' }, icon('list-checks', 'xl'), h('h2', {}, 'You have no task list yet'),
      h('p', {}, 'Create your own list to add tasks and get nudges.'),
      h('button', { type: 'button', class: 'btn', id: 'create-self', onclick: createSelf }, 'Create my task list')));
  }
  const g = groupTasks(ownerTasks(), nowMs());
  const activeCount = g.overdue.length + g.today.length + g.upcoming.length + g.none.length;
  if (S.ownerId !== null && activeCount === 0 && g.done.length === 0) {
    const mine = S.ownerId === myOwnerId();
    const editable = canEditOwner(S.ownerId);
    box.append(h('div', { class: 'empty' }, icon('check-circle-2', 'xl'), h('h2', {}, mine ? 'All clear' : 'No tasks'),
      h('p', {}, editable ? 'Type a task below and pick when it is due. We will nudge you on WhatsApp.' : 'Nothing to show here.')));
  } else if (S.ownerId !== null && activeCount === 0) {
    box.append(h('div', { class: 'empty' }, icon('check-circle-2', 'xl'), h('h2', {}, 'All done'), h('p', {}, 'Nothing left to do. Nice work.')));
  }
  for (const s of [
    sectionEl('overdue', 'Overdue', g.overdue, 'overdue'), sectionEl('today', 'Today', g.today, 'today'),
    sectionEl('upcoming', 'Upcoming', g.upcoming, 'upcoming'), sectionEl('none', 'No date', g.none, 'none'),
    sectionEl('done', 'Done', g.done, 'done', true),
  ]) if (s) box.append(s);
}

function taskRow(t) {
  const now = nowMs();
  const editable = canEditOwner(t.ownerPersonId);
  const done = t.status === 'done';
  const chip = t.dueAt && !done ? dueChip(t.dueAt, now) : null;
  const prog = checklistProgress(t);
  const meta = [
    chip && h('span', { class: 'due-chip' + (chip.overdue ? ' overdue' : '') }, chip.text),
    t.dueAt && done && h('span', {}, fmtDateTime(Date.parse(t.dueAt), now)),
    h('span', { class: 'pdot p-' + t.priority, title: `${t.priority} priority` }), h('span', { class: 'sr-only' }, `${t.priority} priority`),
    isSnoozed(t, now) && h('span', { class: 'badge snooze' }, `Snoozed until ${fmtTime(Date.parse(t.snoozedUntil))}`),
    prog && h('span', { class: 'progress' }, icon('list-checks', 'sm'), `${prog.done}/${prog.total}`),
    t.version === 0 && h('span', { class: 'badge' }, 'Not synced'),
  ];
  return h('li', { class: 'task-row' + (done ? ' is-done' : '') + (chip && chip.overdue ? ' is-overdue' : ''), 'data-id': t.id },
    h('button', {
      type: 'button', class: 'check', 'aria-pressed': String(done), 'aria-label': done ? `Reopen: ${t.title}` : `Mark done: ${t.title}`, disabled: !editable,
      onclick: () => (done ? actOn(t.id, 'reopen') : markDone(t.id)),
    }, h('span', { class: 'ring' }, icon('check', 'sm'))),
    h('a', { class: 'row-main', href: '#/t/' + encodeURIComponent(t.id) }, h('div', { class: 'row-title' }, t.title), h('div', { class: 'row-meta' }, meta)),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': `More actions: ${t.title}`, disabled: !editable, onclick: () => rowMenu(t.id) }, icon('ellipsis')));
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
    renderAll(false);
    toast('Your task list is ready');
  } catch (e) { toast(e.network ? 'You are offline.' : e.message, { kind: 'error' }); }
}

// ---------- quick add ----------
// At rest: one row (title, due button, priority, add). The preset chips show only while the title is focused or has text.
function pickSheet() {
  const qa = S.qa;
  const content = h('div', {});
  const close = openSheet(content, { label: 'Due date', keepOpen: true });
  const input = h('input', { class: 'input', type: 'datetime-local', id: 'qa-pick', 'aria-label': 'Due date and time (IST)' });
  if (qa.due) input.value = isoToIstInput(qa.due.iso);
  const err = h('p', { class: 'error-text', hidden: true });
  const finish = () => { close(); renderQuickAdd(); const t = document.getElementById('qa-title'); if (t) t.focus(); };
  content.append(
    h('h2', {}, 'Due date and time'),
    h('p', { class: 'sub' }, 'Times are IST (India).'),
    h('div', { class: 'field' }, h('label', { for: 'qa-pick' }, 'Due'), input, err),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn secondary', onclick: () => { qa.due = null; finish(); } }, 'No date'),
      h('button', { type: 'button', class: 'btn', onclick: () => {
        const iso = istInputToIso(input.value);
        if (!iso) { err.textContent = 'Pick a date and time.'; err.hidden = false; return; }
        qa.due = { label: 'pick', iso };
        finish();
      } }, 'Set')));
}

/** "5:00 PM" today, "Tue 10 AM"-style short form otherwise (IST). */
function shortDue(ms, now) {
  const full = fmtDateTime(ms, now);
  return full.replace(/^Today /, '').replace(/^Tomorrow /, 'Tmrw ').replace(/:00 /, ' ');
}

function renderQuickAdd() {
  const hadFocus = !!document.activeElement && document.activeElement.id === 'qa-title';
  clear(view.qa);
  document.body.classList.remove('qa-open');
  if (S.ownerId === null) return;
  const editable = canEditOwner(S.ownerId);
  if (!editable) {
    view.qa.append(h('div', { class: 'quick-add' }, h('div', { class: 'qa-view' }, icon('eye', 'sm'), ' View only. You cannot add or change tasks in this list.')));
    return;
  }
  const qa = S.qa;
  const title = h('input', { id: 'qa-title', class: 'input', type: 'text', maxlength: '200', placeholder: 'Add a task…', enterkeyhint: 'done', 'aria-label': 'New task title', autocomplete: 'off' });
  title.value = qa.title;
  const dueBtn = h('button', { type: 'button', class: 'qa-due', id: 'qa-due', onclick: pickSheet });
  const addBtn = h('button', { type: 'submit', class: 'qa-add', 'aria-label': 'Add task' }, icon('arrow-up'));
  const PRIO = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']];
  const prioBtn = h('button', { type: 'button', class: 'qa-prio', id: 'qa-prio', onclick: () => {
    const content = h('div', {});
    const close = openSheet(content, { label: 'Priority' });
    content.append(h('h2', {}, 'Priority'), h('div', { class: 'menu-list', role: 'radiogroup', 'aria-label': 'Priority' }, PRIO.map(([p, l]) =>
      h('button', { type: 'button', class: 'menu-item', role: 'radio', 'aria-checked': String(qa.priority === p), onclick: () => {
        qa.priority = p; close(); renderQuickAdd();
        const pb = document.getElementById('qa-prio');
        if (pb) pb.focus(); // the old button was replaced: put focus on the new one
      } }, h('span', { class: 'pdot p-' + p }), l, qa.priority === p && icon('check', 'sm')))));
  } }, h('span', { class: 'pdot p-' + qa.priority }));
  prioBtn.setAttribute('aria-label', `Priority: ${PRIO.find(([p]) => p === qa.priority)[1]}`);
  const chipsRow = h('div', { class: 'qa-chips', hidden: true });
  const keep = (ev) => ev.preventDefault(); // tapping a chip must not blur the title (that would hide the chips before the click lands)

  const refresh = () => {
    const show = document.activeElement === title || title.value.trim() !== '';
    chipsRow.hidden = !show;
    document.body.classList.toggle('qa-open', show);
    const now = nowMs();
    // icon-only until a date is chosen, then the short date (so the title keeps most of the width)
    clear(dueBtn).append(icon('calendar', 'sm'));
    if (qa.due) dueBtn.append(h('span', {}, shortDue(Date.parse(qa.due.iso), now)));
    dueBtn.classList.toggle('has-value', !!qa.due);
    dueBtn.setAttribute('aria-label', qa.due ? `Due ${fmtDateTime(Date.parse(qa.due.iso), now)} IST. Change` : 'Set a due date');
    addBtn.disabled = !title.value.trim();
    clear(chipsRow);
    const presets = [
      { label: 'In 1h', iso: () => new Date(Math.ceil((nowMs() + 3_600_000) / 60_000) * 60_000).toISOString() },
      { label: 'Today 6 PM', iso: () => istAt(nowMs(), 0, 18), ok: () => Date.parse(istAt(nowMs(), 0, 18)) > nowMs() },
      { label: 'Tomorrow 10 AM', iso: () => istAt(nowMs(), 1, 10) },
    ];
    chipsRow.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!!qa.due && qa.due.label === 'pick'), onmousedown: keep, onclick: pickSheet },
      icon('calendar', 'sm'), 'Pick…'));
    for (const p of presets.filter((x) => !x.ok || x.ok())) {
      const on = !!qa.due && qa.due.label === p.label;
      chipsRow.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), onmousedown: keep,
        onclick: () => { qa.due = on ? null : { label: p.label, iso: p.iso() }; refresh(); title.focus(); } }, p.label));
    }
  };
  title.addEventListener('focus', refresh);
  title.addEventListener('blur', () => setTimeout(() => { if (title.isConnected) refresh(); }, 150));
  title.addEventListener('input', () => { qa.title = title.value; refresh(); });
  const form = h('form', { class: 'qa-inner', onsubmit: (ev) => {
    ev.preventDefault();
    const text = title.value.trim();
    if (!text) return;
    createTask({ title: text, dueAt: qa.due ? qa.due.iso : null, priority: qa.priority });
    qa.due = null; qa.title = ''; qa.priority = 'medium';
    renderQuickAdd();
    document.getElementById('qa-title').focus();
  } }, chipsRow, h('div', { class: 'qa-row' }, title, dueBtn, prioBtn, addBtn));
  view.qa.append(h('div', { class: 'quick-add' }, form));
  if (hadFocus) title.focus();
  refresh();
}

// ---------- task page ----------
let taskPage = null; // { id, refs }

function renderTaskPage(id) {
  clear(view.qa);
  clear(view.content);
  view.content.className = 'content no-qa';
  taskPage = null;
  const t = S.tasks.get(id);
  if (!t) {
    view.content.append(S.loaded || !S.online
      ? h('div', { class: 'empty' }, icon('info', 'xl'), h('h2', {}, 'Task not found'), h('p', {}, 'It may have been deleted, or it is not shared with you.'),
        h('a', { class: 'btn', href: '#/' }, 'Back to my tasks'))
      : h('div', { 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
    return;
  }
  const editable = canEditOwner(t.ownerPersonId);
  const refs = {};
  const owner = ownerOf(t.ownerPersonId);
  const save = h('span', { class: 'save-state', 'aria-live': 'polite' });
  refs.save = save;

  const title = h('textarea', { class: 'title-input', rows: '1', maxlength: '200', 'aria-label': 'Title', disabled: !editable });
  title.value = t.title;
  title.addEventListener('input', () => { if (title.value.trim()) editTask(id, { title: title.value.trim() }); });
  title.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { if (!title.value.trim()) title.value = S.tasks.get(id).title; });
  refs.title = title;

  const statusBtns = [['todo', 'To do'], ['in_progress', 'In progress'], ['done', 'Done']].map(([v, l]) =>
    h('button', { type: 'button', role: 'radio', 'data-v': v, disabled: !editable, onclick: () => setStatus(id, v) }, l));
  refs.status = statusBtns;
  const prioBtns = ['low', 'medium', 'high', 'urgent'].map((p) =>
    h('button', { type: 'button', role: 'radio', 'data-v': p, disabled: !editable, onclick: () => editTask(id, { priority: p }) },
      h('span', { class: 'pdot p-' + p }), p[0].toUpperCase() + p.slice(1)));
  refs.prio = prioBtns;

  refs.dueText = h('div', { class: 'due-line' });
  refs.dueInput = h('input', { class: 'input', type: 'datetime-local', id: 'due-input', 'aria-label': 'Due date and time (IST)', disabled: !editable,
    onchange: (ev) => editTask(id, { dueAt: istInputToIso(ev.target.value) }) });
  refs.dueClear = h('button', { type: 'button', class: 'btn secondary', disabled: !editable, onclick: () => editTask(id, { dueAt: null }) }, 'Clear date');

  const notes = h('textarea', { class: 'textarea', id: 'notes', maxlength: '10000', placeholder: 'Add notes…', 'aria-label': 'Notes', disabled: !editable });
  notes.value = t.notes;
  notes.addEventListener('input', () => editTask(id, { notes: notes.value }));
  refs.notes = notes;

  refs.checklist = h('ul', { class: 'checklist' });
  refs.clAdd = h('input', { class: 'input', type: 'text', maxlength: '300', placeholder: 'Add an item…', 'aria-label': 'New checklist item', disabled: !editable,
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
  refs.clNote = h('p', { class: 'small muted' });

  refs.snoozeText = h('div', { class: 'due-line' });
  refs.snoozeRow = h('div', { class: 'chip-row' });
  refs.doneBtn = h('button', { type: 'button', class: 'btn big block', disabled: !editable, onclick: () => {
    const cur = S.tasks.get(id);
    if (cur.status === 'done') actOn(id, 'reopen'); else markDone(id);
  } });
  refs.activity = h('ul', { class: 'timeline' });

  const card = (label, ...kids) => h('section', { class: 'task-card' }, h('div', { class: 'label' }, label), h('div', { class: 'stack' }, kids));
  view.content.append(
    h('div', { class: 'page-top' },
      h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Back to my tasks' }, icon('chevron-left', 'lg')),
      h('div', { class: 'spacer' }), save),
    editable ? '' : h('div', { class: 'callout' }, h('span', { class: 'badge view' }, 'View only'), ' You can read this task but not change it.'),
    h('section', { class: 'task-card' }, title),
    card('Status', h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Status' }, statusBtns)),
    card('Priority', h('div', { class: 'seg prio', role: 'radiogroup', 'aria-label': 'Priority' }, prioBtns)),
    card('Due (IST)', refs.dueText, h('div', { class: 'qa-pick' }, refs.dueInput, refs.dueClear)),
    card('Snooze', refs.snoozeText, refs.snoozeRow),
    card('Notes', notes),
    card('Checklist', refs.checklist, refs.clAdd, refs.clNote),
    card('Belongs to', h('div', {}, h('span', { class: 'avatar' }, initials(owner ? owner.name : '?')), ' ', owner ? (owner.id === myOwnerId() ? `${owner.name} (me)` : owner.name) : 'Unknown')),
    refs.doneBtn,
    h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn secondary', disabled: !editable, onclick: () => confirmDelete(id, () => { location.hash = '#/'; }) }, icon('trash-2'), 'Delete task')),
    h('section', { class: 'task-card', 'aria-label': 'Activity' }, h('div', { class: 'label' }, 'Activity'), refs.activity));
  taskPage = { id, refs, editable };
  refreshTaskPage(id, true);
  loadActivity(id, refs);
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

function renderChecklist(id, refs, focusLast) {
  const t = S.tasks.get(id);
  const editable = taskPage && taskPage.editable;
  clear(refs.checklist);
  const save = (items) => { editTask(id, { checklist: items }); renderChecklist(id, refs); };
  t.checklist.forEach((item, i) => {
    const input = h('input', { class: 'input', type: 'text', maxlength: '300', value: item.text, 'aria-label': `Checklist item ${i + 1}`, disabled: !editable });
    input.value = item.text;
    input.addEventListener('input', () => {
      const cur = S.tasks.get(id).checklist.map((c) => (c.id === item.id ? { ...c, text: input.value } : c));
      editTask(id, { checklist: cur });
    });
    refs.checklist.append(h('li', { class: 'cl-item' + (item.done ? ' checked' : '') },
      h('button', { type: 'button', class: 'check', 'aria-pressed': String(item.done), 'aria-label': item.done ? 'Uncheck item' : 'Check item', disabled: !editable,
        onclick: () => save(S.tasks.get(id).checklist.map((c) => (c.id === item.id ? { ...c, done: !c.done } : c))) },
      h('span', { class: 'ring' }, icon('check', 'sm'))),
      input,
      h('button', { type: 'button', class: 'icon-btn cl-move', 'aria-label': 'Move up', disabled: !editable || i === 0, onclick: () => { const a = S.tasks.get(id).checklist.slice(); [a[i - 1], a[i]] = [a[i], a[i - 1]]; save(a); } }, icon('arrow-up', 'sm')),
      h('button', { type: 'button', class: 'icon-btn cl-move', 'aria-label': 'Move down', disabled: !editable || i === t.checklist.length - 1, onclick: () => { const a = S.tasks.get(id).checklist.slice(); [a[i + 1], a[i]] = [a[i], a[i + 1]]; save(a); } }, icon('arrow-down', 'sm')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete item', disabled: !editable, onclick: () => save(S.tasks.get(id).checklist.filter((c) => c.id !== item.id)) }, icon('x', 'sm'))));
  });
  const full = t.checklist.length >= MAX_CHECKLIST;
  refs.clAdd.hidden = full;
  refs.clNote.textContent = full ? `Checklist is full (${MAX_CHECKLIST} items).` : t.checklist.length ? `${t.checklist.filter((c) => c.done).length} of ${t.checklist.length} done` : '';
  if (focusLast) refs.clAdd.focus();
}

/** Brings the visible controls in line with the stored task. Text fields are only touched when not focused. */
function refreshTaskPage(id, force) {
  if (!taskPage || taskPage.id !== id) return;
  const t = S.tasks.get(id);
  const { refs, editable } = taskPage;
  if (!t) { renderTaskPage(id); return; }
  const focused = document.activeElement;
  const setIfIdle = (el, value) => { if (el !== focused && el.value !== value) el.value = value; };
  setIfIdle(refs.title, t.title);
  setIfIdle(refs.notes, t.notes);
  refs.status.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === t.status)));
  refs.prio.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === t.priority)));
  const now = nowMs();
  if (t.dueAt) {
    const ms = Date.parse(t.dueAt);
    refs.dueText.textContent = `${fmtDateTime(ms, now)} IST · ${fmtRelative(ms, now)}`;
  } else refs.dueText.textContent = 'No due date. No nudges for this task.';
  setIfIdle(refs.dueInput, t.dueAt ? isoToIstInput(t.dueAt) : '');
  refs.dueClear.hidden = !t.dueAt;
  const snoozed = isSnoozed(t, now);
  refs.snoozeText.textContent = snoozed ? `Snoozed until ${fmtDateTime(Date.parse(t.snoozedUntil), now)} IST` : 'Not snoozed';
  clear(refs.snoozeRow);
  if (t.status !== 'done') {
    for (const [l, m] of [['1h', 60], ['2h', 120], ['24h', 1440]]) {
      refs.snoozeRow.append(h('button', { type: 'button', class: 'chip', disabled: !editable, onclick: () => { actOn(id, 'snooze', m); toast(`Snoozed ${l}`); } }, l));
    }
    refs.snoozeRow.append(h('button', { type: 'button', class: 'chip', disabled: !editable, onclick: () => snoozeSheet(id) }, 'Custom'));
  }
  if (snoozed) refs.snoozeRow.append(h('button', { type: 'button', class: 'chip', disabled: !editable, onclick: () => actOn(id, 'unsnooze') }, 'Unsnooze'));
  clear(refs.doneBtn).append(icon(t.status === 'done' ? 'rotate-ccw' : 'check'), t.status === 'done' ? 'Reopen' : 'Done');
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
  el.textContent = !S.online ? (pending ? 'Offline, will sync' : 'Offline') : pending || S.syncing ? 'Saving…' : 'Saved';
}

const ACTION_TEXT = {
  create: 'Created', done: 'Marked done', reopen: 'Reopened', snooze: 'Snoozed', unsnooze: 'Snooze cleared', delete: 'Deleted', undelete: 'Restored',
};
function activityText(a) {
  const d = a.details || {};
  if (a.action === 'update') return `Edited ${(d.fields || []).join(', ') || 'task'}`;
  if (a.action === 'snooze' && d.changes && d.changes.snoozedUntil && d.changes.snoozedUntil.to) {
    return `Snoozed until ${fmtDateTime(Date.parse(d.changes.snoozedUntil.to), nowMs())}`;
  }
  return ACTION_TEXT[a.action] || a.action;
}
async function loadActivity(id, refs) {
  if (taskPage && taskPage.id === id) taskPage.activityVersion = S.tasks.get(id)?.version;
  clear(refs.activity);
  if (!S.online || S.tasks.get(id)?.version === 0) {
    refs.activity.append(h('li', { class: 'muted' }, 'Activity is available when online.'));
    return;
  }
  try {
    const list = await api('GET', `/api/app/tasks/${encodeURIComponent(id)}/activity`);
    if (!taskPage || taskPage.id !== id) return;
    clear(refs.activity);
    if (!list.length) refs.activity.append(h('li', { class: 'muted' }, 'No activity yet.'));
    for (const a of list) {
      refs.activity.append(h('li', {}, h('span', { class: 'when' }, `${fmtDateTime(Date.parse(a.at), nowMs())} IST · ${a.actor}`), activityText(a)));
    }
  } catch {
    clear(refs.activity).append(h('li', { class: 'muted' }, 'Activity is available when online.'));
  }
}

// ---------- admin placeholder ----------
function renderAdmin() {
  clear(view.qa);
  view.content.className = 'content no-qa';
  const admin = S.me.role === 'admin' || S.me.role === 'superadmin';
  if (!admin) {
    clear(view.content).append(
      h('div', { class: 'page-top' }, h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Back to my tasks' }, icon('chevron-left', 'lg')), h('h2', {}, 'Admin')),
      h('div', { class: 'empty' }, h('h2', {}, 'Admins only')));
    return;
  }
  // the admin area works online only; nothing it does goes through the outbox
  renderAdminPage({ h, clear, icon, api, toast, openSheet, S }, view.content, route().tab);
}

// ---------- service worker ----------
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller; // first install claims the page: that must not reload it
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
  const offer = (worker) => toast('New version available, tap to refresh', {
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
  view.header = null;
  clear($app).append(h('main', { class: 'login-page' }, h('div', { class: 'login-card center' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('bell', 'lg')), h('h1', {}, 'Nudge')),
    h('h2', {}, 'Nudge is open in another tab'),
    h('p', { class: 'muted' }, 'To keep your changes safe, Nudge runs in one tab at a time.'),
    h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', id: 'use-here', onclick: () => {
      navigator.locks.request('nudge-active', { steal: true }, () => { location.reload(); return new Promise(() => {}); }).catch(() => {});
    } }, 'Use here')))));
}

// Keeps the quick-add bar above the on-screen keyboard where the layout viewport does not shrink (iOS Safari).
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
  view.header = null;
  renderAll(false);
  startSyncLoop();
}

registerWorker();
trackKeyboard();
boot().catch((e) => {
  console.error('boot failed', e);
  clear($app).append(h('p', { class: 'boot' }, 'Something went wrong starting Nudge. Reload to try again.'));
});
