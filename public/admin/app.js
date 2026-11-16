// Pushup admin UI. Vanilla JS, no build. All API/user text is inserted with textContent or text nodes
// (never innerHTML), so it is always escaped. Icons are Lucide symbols from icons.svg (ISC licence).
'use strict';

const app = document.getElementById('app');
const toastBox = document.getElementById('toasts');
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_OFFSETS = [60, 30, 10, 5];

// ---------- DOM helpers ----------
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style') continue; // inline styles are blocked by the CSP; use classes
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
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

/** <svg><use href="icons.svg#name"/></svg>; decorative (aria-hidden) unless a label is given. */
function icon(name, cls, label) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', 'icons.svg#' + name);
  svg.append(use);
  return svg;
}

function button(label, opts = {}) {
  return h('button', { type: opts.type || 'button', class: 'btn' + (opts.kind ? ' btn-' + opts.kind : '') + (opts.small ? ' btn-sm' : ''), onclick: opts.onclick, disabled: opts.disabled },
    opts.icon && icon(opts.icon), label);
}
function iconButton(name, label, onclick, extra) {
  return h('button', { type: 'button', class: 'btn btn-icon' + (extra ? ' ' + extra : ''), 'aria-label': label, title: label, onclick }, icon(name));
}
function pill(tone, iconName, text) {
  return h('span', { class: 'pill tone-' + tone }, iconName && icon(iconName), text);
}
function setBusy(btn, busy) {
  btn.disabled = busy;
  const old = btn.querySelector('.busy-spinner');
  if (old) old.remove();
  for (const i of btn.querySelectorAll('.icon-hidden')) i.classList.remove('icon-hidden');
  if (busy) {
    const first = btn.querySelector('svg.icon');
    if (first) first.classList.add('icon-hidden');
    const sp = icon('loader', 'spin'); sp.classList.add('busy-spinner'); btn.prepend(sp);
  }
}

// ---------- toasts ----------
function toast(kind, text) {
  const iconName = kind === 'success' ? 'check-circle-2' : kind === 'error' ? 'x-circle' : 'info';
  const node = h('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : undefined }, icon(iconName), h('div', { class: 'toast-text' }, text),
    iconButton('x', 'Dismiss notification', () => node.remove()));
  toastBox.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 9000 : 5000);
}

// ---------- API ----------
class ApiError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields || {}; }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && state.me) {
      state.me = null;
      renderLogin('Session expired, please sign in again');
    }
    throw new ApiError(res.status, (data && data.error) || `HTTP ${res.status}`, data && data.fields);
  }
  return data;
}

// ---------- state + formatting ----------
const state = { me: null, tab: 'dashboard', timer: null, groups: null, token: 0, refresh: null };
const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', desc: 'Is everything running? Setup status, upcoming calls and recent reminders.' },
  { id: 'closers', label: 'Closers', icon: 'users', desc: 'The sales staff who get tagged in reminders when they are invited to a call.' },
  { id: 'clients', label: 'Clients', icon: 'building-2', desc: 'Client calendars and the WhatsApp group each one posts reminders into.' },
  { id: 'settings', label: 'Reminder settings', icon: 'bell', desc: 'How many minutes before a call the reminders go out.' },
  { id: 'whatsapp', label: 'WhatsApp', icon: 'message-circle', desc: 'The linked WhatsApp number that posts the reminders. Check it, restart it or switch to a new number.' },
  { id: 'admins', label: 'Admins', icon: 'shield', desc: 'Who can sign in to this admin panel.' },
  { id: 'audit', label: 'Audit log', icon: 'scroll-text', desc: 'A record of every change made in the admin panel.' },
];

const WAHA_LABELS = {
  WORKING: 'Connected', SCAN_QR_CODE: 'QR scan needed', STARTING: 'Starting…', FAILED: 'Failed', STOPPED: 'Stopped',
  UNREACHABLE: 'Not reachable', PASSKEY_REQUIRED: 'Approve on phone', PASSKEY_CONFIRMATION_REQUIRED: 'Approve on phone',
};
const wahaLabel = (status) => WAHA_LABELS[status] || String(status || 'unknown');

const SUPER_ONLY = new Set(['admins', 'whatsapp']);

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
}
function rel(iso, now = Date.now()) {
  const mins = Math.round((new Date(iso).getTime() - now) / 60000);
  const abs = Math.abs(mins);
  if (abs < 1) return 'just now';
  let text;
  if (abs < 60) text = abs + ' min';
  else if (abs < 1440) { const hr = Math.floor(abs / 60); const m = abs % 60; text = hr + ' h' + (m ? ' ' + m + ' min' : ''); }
  else { const d = Math.floor(abs / 1440); text = d + (d === 1 ? ' day' : ' days'); }
  return mins > 0 ? 'in ' + text : text + ' ago';
}
const istDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
function clock(mins) {
  const day = ((mins % 1440) + 1440) % 1440;
  const hr = Math.floor(day / 60);
  return { text: ((hr + 11) % 12 + 1) + ':' + String(day % 60).padStart(2, '0'), ampm: hr < 12 ? 'AM' : 'PM' };
}

// ---------- dialogs ----------
let escGuard = false;
function focusables(root) {
  return [...root.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null && el.getAttribute('tabindex') !== '-1');
}

/** Opens a modal <dialog> (with a fallback when showModal is missing). Esc closes, Tab is trapped, focus is returned. */
function openModal({ title, lead, leadTone, body, footer, onClose, backdropClose = true }) {
  const previous = document.activeElement;
  const titleId = 'dlg-title-' + Math.random().toString(36).slice(2, 8);
  const dlg = h('dialog', { class: 'modal', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' },
      lead && h('span', { class: 'modal-lead tone-' + (leadTone || 'info') }, icon(lead, 'lg')),
      h('h2', { id: titleId }, title)),
    h('div', { class: 'modal-body' }, body),
    h('div', { class: 'modal-foot' }, footer));
  let backdrop = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (onClose) onClose();
    if (dlg.close && dlg.open && !dlg.classList.contains('fallback')) dlg.close();
    dlg.remove();
    if (backdrop) backdrop.remove();
    if (previous && previous.isConnected && previous.focus) previous.focus();
  };
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); if (escGuard) { escGuard = false; return; } close(); });
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ev.defaultPrevented) { if (escGuard) { escGuard = false; return; } ev.preventDefault(); close(); return; }
    if (ev.key !== 'Tab') return;
    const items = focusables(dlg);
    if (!items.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (ev.shiftKey && (document.activeElement === first || !dlg.contains(document.activeElement))) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (document.activeElement === last || !dlg.contains(document.activeElement))) { ev.preventDefault(); first.focus(); }
  });
  dlg.addEventListener('close', close); // safety net if the dialog is closed natively
  if (backdropClose) dlg.addEventListener('click', (ev) => { if (ev.target === dlg) close(); });
  document.body.append(dlg);
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else {
    backdrop = h('div', { class: 'modal-backdrop-fallback' });
    document.body.append(backdrop);
    dlg.classList.add('fallback');
    dlg.setAttribute('open', '');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
  }
  const auto = dlg.querySelector('[autofocus]') || dlg.querySelector('input:not([type=hidden]), select, textarea');
  (auto || focusables(dlg)[0] || dlg).focus();
  return { dlg, close };
}

/** Resolves with the chosen button's value, or null when dismissed. */
function confirmDialog({ title, message, lead, tone, buttons }) {
  return new Promise((resolve) => {
    let modal;
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); modal.close(); };
    const foot = buttons.map((b) => h('button', {
      type: 'button', class: 'btn btn-' + (b.kind || 'secondary'), autofocus: b.autofocus, onclick: () => done(b.value),
    }, b.icon && icon(b.icon), b.label));
    modal = openModal({
      title, lead, leadTone: tone, body: [].concat(message).map((m) => h('p', { class: 'muted' }, m)), footer: foot,
      onClose: () => { if (!settled) { settled = true; resolve(null); } },
    });
  });
}

// ---------- shared UI pieces ----------
function callout(kind, text, iconName) {
  return h('div', { class: 'callout callout-' + kind, role: kind === 'danger' ? 'alert' : 'status' },
    icon(iconName || (kind === 'danger' ? 'x-circle' : kind === 'warning' ? 'alert-triangle' : 'info')), h('div', {}, text));
}
function emptyState(iconName, text, action, compact) {
  return h('div', { class: 'empty' + (compact ? ' compact' : '') },
    h('div', { class: 'empty-icon' }, icon(iconName, 'xl')), h('p', {}, text), action);
}
function errorCard(message, retry) {
  return h('div', { class: 'card' }, h('div', { class: 'empty' },
    h('div', { class: 'empty-icon tone-danger' }, icon('alert-triangle', 'xl')),
    h('h2', {}, 'Something went wrong'), h('p', {}, message),
    button('Try again', { icon: 'refresh-cw', onclick: retry })));
}
function skeleton(kind) {
  const line = (w) => h('div', { class: 'skeleton sk-line' + (w ? ' ' + w : '') });
  if (kind === 'dashboard') {
    return h('div', { class: 'stack', 'aria-busy': 'true' }, h('div', { class: 'tiles' }, [1, 2, 3, 4].map(() => h('div', { class: 'skeleton sk-tile' }))),
      h('div', { class: 'skeleton sk-block' }), h('div', { class: 'skeleton sk-block' }));
  }
  return h('div', { class: 'card card-pad', 'aria-busy': 'true' }, line(), line(), line(), line());
}

/** Page header with icon, title, description and actions; returns {body, reload}. */
function mountPage(main, tab, cfg) {
  const tok = state.token;
  const meta = TABS.find((t) => t.id === tab);
  const body = h('div', {});
  const actions = h('div', { class: 'page-actions' });
  clear(main).append(h('div', { class: 'page' },
    h('header', { class: 'page-head' },
      h('div', { class: 'page-icon' }, icon(meta.icon, 'lg')),
      h('div', { class: 'page-titles' }, h('h1', {}, meta.label), h('p', {}, meta.desc)),
      actions),
    body));
  let loadedOnce = false;
  const page = {
    body,
    async reload(silent) {
      if (!silent || !loadedOnce) clear(body).append(skeleton(cfg.skeleton));
      try {
        const data = await cfg.load();
        if (tok !== state.token) return;
        loadedOnce = true;
        clear(body);
        cfg.render(body, data, page);
      } catch (e) {
        if (tok !== state.token || e.status === 401) return;
        if (silent && loadedOnce) return;
        clear(body).append(errorCard(e.message, () => page.reload()));
      }
    },
  };
  if (cfg.actions) actions.append(cfg.actions(page));
  return page;
}

function formField(f, errs, inputs) {
  const id = 'f-' + f.name + '-' + Math.random().toString(36).slice(2, 6);
  const input = f.node || h('input', {
    id, class: 'input', type: f.type || 'text', value: f.value ?? '', autocomplete: 'off', placeholder: f.placeholder,
    inputmode: f.inputmode, autofocus: f.autofocus,
  });
  const errBox = h('div', { id: id + '-err', 'aria-live': 'polite' });
  errs[f.name] = { box: errBox, input: f.node ? null : input };
  inputs[f.name] = f.get || (() => input.value);
  if (!f.node) input.setAttribute('aria-describedby', (f.help ? id + '-help ' : '') + id + '-err');
  return h('div', { class: 'field' }, f.node ? h('span', { class: 'label', id: id + '-lbl' }, f.label) : h('label', { for: id }, f.label), input,
    f.help && h('div', { class: 'help', id: id + '-help' }, f.help), errBox);
}

/** Modal form. fields: [{name,label,type,value,help,node,get}]; onSubmit(values) may throw ApiError with .fields. */
function formModal({ title, lead, fields, submitLabel, onSubmit }) {
  const errs = {}; const inputs = {};
  const topErr = h('div', {});
  const body = fields.map((f) => formField(f, errs, inputs));
  const form = h('form', { novalidate: true }, topErr, body);
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check-circle-2'), submitLabel || 'Save');
  const cancel = button('Cancel', { kind: 'secondary', onclick: () => modal.close() });
  const formId = 'form-' + Math.random().toString(36).slice(2, 8);
  form.id = formId;
  save.setAttribute('form', formId);
  const modal = openModal({ title, lead, body: form, footer: [cancel, save], backdropClose: false });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clear(topErr);
    for (const e of Object.values(errs)) { clear(e.box); if (e.input) e.input.removeAttribute('aria-invalid'); }
    const values = {};
    for (const f of fields) values[f.name] = inputs[f.name]();
    setBusy(save, true);
    try {
      await onSubmit(values);
      modal.close();
    } catch (e) {
      if (e.status === 401) { modal.close(); return; }
      let placed = false;
      for (const [k, v] of Object.entries(e.fields || {})) {
        if (!errs[k]) continue;
        placed = true;
        errs[k].box.append(h('div', { class: 'field-error' }, icon('alert-triangle', 'sm'), String(v)));
        if (errs[k].input) errs[k].input.setAttribute('aria-invalid', 'true');
      }
      if (!placed) topErr.append(callout('danger', e.message));
    } finally { setBusy(save, false); }
  });
  return modal;
}

// ---------- login ----------
function passwordField(input) {
  const toggle = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Show password', 'aria-pressed': 'false', title: 'Show password' }, icon('eye'));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    const label = show ? 'Hide password' : 'Show password';
    toggle.setAttribute('aria-label', label); toggle.title = label;
    clear(toggle).append(icon(show ? 'eye-off' : 'eye'));
  });
  return h('div', { class: 'input-wrap' }, input, toggle);
}

async function renderLogin(message) {
  stopTimer();
  state.token++;
  document.body.classList.remove('nav-open');
  clear(app);
  const msg = h('div', {});
  const box = h('div', { class: 'card login-card' },
    h('div', { class: 'login-brand' }, h('div', { class: 'logo' }, icon('bell', 'lg')), h('h1', {}, 'Pushup admin'),
      h('p', { class: 'muted' }, 'Sign in to manage call reminders')),
    msg);
  app.append(h('main', { class: 'login-page' }, box));
  const showError = (text) => { clear(msg).append(callout('danger', text)); };
  if (message) showError(message);

  let cfg;
  try { cfg = await api('GET', '/auth/config'); } catch (e) { showError(e.message); return; }

  if (cfg.googleClientId) {
    const holder = h('div', { class: 'gsi-holder', id: 'gsi-button' });
    box.append(holder);
    gisHandler = async (resp) => {
      try { await api('POST', '/auth/google', { credential: resp.credential }); await start(); }
      catch (e) { showError(e.status === 403 ? 'This Google account is not authorised.' : e.message); }
    };
    loadGoogle().then(() => {
      if (!gisInitialized) { // initialize() must run once; the handler is swapped on each login render
        gisInitialized = true;
        window.google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: (resp) => gisHandler(resp) });
      }
      window.google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', width: 336 });
    }).catch(() => showError('Could not load Google sign-in.'));
  }

  if (cfg.passwordLogin) {
    if (cfg.googleClientId) box.append(h('div', { class: 'divider' }, 'or sign in with a password'));
    const email = h('input', { id: 'login-email', class: 'input', type: 'email', autocomplete: 'username', required: true, autofocus: !cfg.googleClientId });
    const pass = h('input', { id: 'login-pass', class: 'input has-action', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn btn-block', type: 'submit' }, icon('log-in'), 'Sign in');
    const form = h('form', {
      onsubmit: async (ev) => {
        ev.preventDefault();
        setBusy(btn, true);
        try { await api('POST', '/auth/password', { email: email.value, password: pass.value }); pass.value = ''; await start(); }
        catch (e) { showError(e.status === 429 ? 'Too many failed attempts. Try again in 15 minutes.' : e.message); }
        finally { setBusy(btn, false); }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'login-email' }, 'Email'), email),
    h('div', { class: 'field' }, h('label', { for: 'login-pass' }, 'Password'), passwordField(pass)),
    btn);
    box.append(form);
    if (!cfg.googleClientId) email.focus();
  }
  if (!cfg.googleClientId && !cfg.passwordLogin) showError('No login method is configured.');
}

let googleLoading;
let gisInitialized = false;
let gisHandler = () => {};
function loadGoogle() {
  if (window.google && window.google.accounts) return Promise.resolve();
  if (!googleLoading) {
    googleLoading = new Promise((resolve, reject) => {
      const s = h('script', { src: 'https://accounts.google.com/gsi/client', async: true, defer: true });
      s.onload = resolve; s.onerror = () => { googleLoading = null; reject(new Error('load failed')); };
      document.head.append(s);
    });
  }
  return googleLoading;
}

// ---------- shell ----------
function stopTimer() { if (state.timer) { clearInterval(state.timer); state.timer = null; } state.refresh = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.refresh) state.refresh(); });

let shell = null;
function setDrawer(open) {
  document.body.classList.toggle('nav-open', open);
  if (!shell) return;
  shell.menuBtn.setAttribute('aria-expanded', String(open));
  const col = document.querySelector('.main-col');
  if (col) col.inert = open; // keeps Tab (and screen readers) inside the open drawer
  if (open) { const first = shell.nav.querySelector('a'); if (first) first.focus(); }
  else if (shell.restoreFocus) { shell.menuBtn.focus(); }
}

function renderShell() {
  clear(app);
  const visible = TABS.filter((t) => !SUPER_ONLY.has(t.id) || state.me.role === 'superadmin');
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, visible.map((t) => h('a', {
    href: '#' + t.id, 'data-tab': t.id, onclick: () => { shell.restoreFocus = false; setDrawer(false); },
  }, icon(t.icon), t.label)));
  const menuBtn = h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Open menu', 'aria-controls': 'sidebar', 'aria-expanded': 'false', title: 'Menu' }, icon('menu', 'lg'));
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Sidebar' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('bell', 'lg')), h('span', {}, 'Pushup admin')),
    nav,
    h('div', { class: 'sidebar-foot' },
      h('div', { class: 'me' }, h('div', { class: 'avatar', 'aria-hidden': 'true' }, state.me.email.charAt(0).toUpperCase()),
        h('div', { class: 'me-text' }, h('div', { class: 'me-email', title: state.me.email }, state.me.email), h('div', { class: 'me-role' }, state.me.role))),
      button('Log out', { kind: 'secondary', icon: 'log-out', onclick: logout })));
  const main = h('main', { id: 'main', tabindex: '-1' });
  const scrim = h('div', { class: 'scrim', onclick: () => { shell.restoreFocus = true; setDrawer(false); } });
  shell = { menuBtn, nav, restoreFocus: true };
  menuBtn.addEventListener('click', () => { shell.restoreFocus = true; setDrawer(true); });
  app.append(h('div', { class: 'layout' }, sidebar, scrim,
    h('div', { class: 'main-col' },
      h('header', { class: 'topbar' }, menuBtn, h('div', { class: 'brand-sm' }, h('div', { class: 'logo' }, icon('bell')), 'Pushup admin')),
      main)));
  return main;
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Tab' && document.body.classList.contains('nav-open') && shell && !document.querySelector('dialog.modal')) {
    const sidebar = document.getElementById('sidebar');
    const items = focusables(sidebar);
    if (items.length) {
      const first = items[0]; const last = items[items.length - 1];
      if (!sidebar.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
      else if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  }
  if (ev.key === 'Escape' && document.body.classList.contains('nav-open') && !document.querySelector('dialog.modal')) {
    if (shell) shell.restoreFocus = true;
    setDrawer(false);
  }
});

async function logout() {
  try { await api('POST', '/auth/logout', {}); } catch { /* ignore */ }
  state.me = null; state.groups = null;
  stopTimer();
  history.replaceState(null, '', location.pathname);
  renderLogin();
}

const VIEWS = {};
function tabFromHash() {
  const id = location.hash.replace(/^#\/?/, '');
  return TABS.some((t) => t.id === id) ? id : null;
}

function go(tab) {
  if (!state.me) return;
  if (SUPER_ONLY.has(tab) && state.me.role !== 'superadmin') tab = 'dashboard';
  state.tab = tab;
  state.token++;
  stopTimer();
  if (shell) shell.restoreFocus = false;
  setDrawer(false);
  const main = document.getElementById('main') || renderShell();
  for (const a of shell.nav.querySelectorAll('a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = TABS.find((t) => t.id === tab).label + ' - Pushup admin';
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  Promise.resolve(VIEWS[tab](main)).catch((e) => { if (state.me) clear(main).append(h('div', { class: 'page' }, errorCard(e.message, () => go(tab)))); });
}

window.addEventListener('hashchange', () => { const t = tabFromHash(); if (t && state.me && t !== state.tab) go(t); });

async function start() {
  try { state.me = await api('GET', '/me'); }
  catch (e) { if (e.status === 401) return renderLogin(); clear(app).append(h('div', { class: 'page' }, errorCard(e.message, start))); return; }
  shell = null;
  clear(app);
  go(tabFromHash() || state.tab);
}

// ---------- dashboard ----------
function tile(tone, iconName, label, value, sub) {
  return h('div', { class: 'card tile' }, h('div', { class: 'tile-icon tone-' + tone }, icon(iconName, 'lg')),
    h('div', {}, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), h('div', { class: 'tile-sub' }, sub)));
}
function card(title, iconName, content, headExtra) {
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, icon(iconName), h('h2', {}, title), headExtra), content);
}

VIEWS.dashboard = async (main) => {
  let refreshBtn;
  let timerStarted = false;
  const page = mountPage(main, 'dashboard', {
    skeleton: 'dashboard',
    actions: (p) => {
      refreshBtn = button('Refresh', {
        kind: 'secondary', icon: 'refresh-cw',
        onclick: async () => { setBusy(refreshBtn, true); await p.reload(true); setBusy(refreshBtn, false); },
      });
      return refreshBtn;
    },
    load: async () => {
      const [s, clients, closers, cfg] = await Promise.all([
        api('GET', '/status'),
        api('GET', '/clients').catch(() => null),
        api('GET', '/closers').catch(() => null),
        api('GET', '/auth/config').catch(() => null),
      ]);
      return { s, clients, closers, cfg };
    },
    render: (body, { s, clients, closers, cfg }) => {
      drawDashboard(body, s, clients, closers, cfg);
      if (!timerStarted) {
        timerStarted = true;
        state.timer = setInterval(() => { if (!document.hidden) page.reload(true); }, 60000);
      }
    },
  });
  state.refresh = () => page.reload(true);
  await page.reload();
};

function drawDashboard(body, s, clients, closers, cfg) {
  const hl = s.health;
  const cals = s.sync ? s.sync.calendars : [];
  const failing = cals.filter((c) => !c.ok);
  const today = istDay(Date.now());
  const sentToday = s.recentReminders.filter((r) => r.status === 'sent' && istDay(r.sentAt) === today).length;
  const capped = s.recentReminders.length >= 20 && s.recentReminders.every((r) => istDay(r.sentAt) === today);

  const lastOk = hl.lastSuccessfulSync;
  const stale = !!lastOk && hl.syncOk === false;
  const syncTile = lastOk
    ? tile(stale ? 'warning' : 'info', 'refresh-cw', 'Last successful sync', rel(lastOk), stale ? 'Sync is stale' : fmtTime(lastOk))
    : s.sync
      ? tile('warning', 'refresh-cw', 'Last successful sync', 'Not yet', 'Last attempt ' + rel(s.sync.startedAt) + (s.sync.ok ? '' : ' failed') + ': see Calendar sync')
      : tile('warning', 'refresh-cw', 'Last successful sync', 'Waiting for the first sync', 'No sync has run yet');
  const tiles = h('div', { class: 'tiles' },
    tile(hl.ok ? 'success' : 'danger', hl.ok ? 'check-circle-2' : 'alert-triangle', 'Overall health', hl.ok ? 'Healthy' : 'Needs attention',
      hl.ok ? 'Sync and WhatsApp are fine' : 'See the checklist below'),
    tile(hl.waha.ok ? 'success' : 'danger', 'message-circle', 'WhatsApp', wahaLabel(hl.waha.status),
      hl.waha.ok ? 'Session is linked' : 'WAHA status: ' + hl.waha.status),
    syncTile,
    tile('info', 'send', 'Reminders sent today', capped ? sentToday + '+' : String(sentToday), s.recentReminders.length ? 'IST, from the latest 20' : 'None yet'));

  // setup checklist
  const syncDetail = !clients || !clients.length ? 'Add a client first, then calendars start syncing.'
    : !s.sync ? 'Waiting for the first sync to finish.'
      : failing.length ? failing.length + ' calendar' + (failing.length > 1 ? 's' : '') + ' failing: ' + failing.map((c) => c.client).join(', ')
        : cals.length + ' calendar' + (cals.length === 1 ? '' : 's') + ' syncing with no errors.';
  const items = [
    { ok: !!clients && clients.length > 0 && !!s.sync && failing.length === 0, title: 'Calendars syncing', detail: syncDetail,
      action: failing.length ? { label: 'See details', fn: () => document.getElementById('sync-card') && document.getElementById('sync-card').scrollIntoView({ behavior: 'smooth' }) } : null },
    { ok: !!hl.waha.ok, title: 'WhatsApp linked', detail: hl.waha.ok ? 'WhatsApp is connected.' : 'WhatsApp: ' + wahaLabel(hl.waha.status) + ' (' + hl.waha.status + '). Open WhatsApp to fix it.',
      action: state.me.role === 'superadmin' ? { label: 'Manage', fn: () => { location.hash = '#whatsapp'; } } : null },
    { ok: !!clients && clients.length > 0, title: 'At least one client', detail: clients && clients.length ? clients.length + ' client' + (clients.length === 1 ? '' : 's') + ' set up.' : 'Add a client calendar and its WhatsApp group.',
      action: { label: clients && clients.length ? 'Manage' : 'Add client', fn: () => { location.hash = '#clients'; } } },
    { ok: !!closers && closers.length > 0, title: 'At least one closer', detail: closers && closers.length ? closers.length + ' closer' + (closers.length === 1 ? '' : 's') + ' set up.' : 'Add the sales staff who should be tagged.',
      action: { label: closers && closers.length ? 'Manage' : 'Add closer', fn: () => { location.hash = '#closers'; } } },
    { ok: !!cfg && !!cfg.googleClientId, title: 'Google login configured', detail: cfg && cfg.googleClientId ? 'Admins can sign in with Google.' : 'Optional. Set GOOGLE_OAUTH_CLIENT_ID so other admins can sign in with Google.' },
  ];
  const done = items.filter((i) => i.ok).length;
  const checklist = card('Setup checklist', 'check-circle-2',
    h('ul', { class: 'list' }, items.map((i) => h('li', {},
      h('span', { class: 'li-icon tone-' + (i.ok ? 'success' : 'warning') }, icon(i.ok ? 'check-circle-2' : 'alert-triangle')),
      h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, i.title), h('div', { class: 'li-sub' }, i.detail)),
      i.action && button(i.action.label, { kind: 'secondary', small: true, onclick: i.action.fn })))),
    h('span', { class: 'progress' }, done + ' of ' + items.length + ' done'));

  // service account
  const saCard = card('Google service account', 'mail', h('div', { class: 'card-body' },
    s.serviceAccountEmail
      ? h('div', { class: 'copy-row' }, h('code', {}, s.serviceAccountEmail),
        button('Copy', { kind: 'secondary', small: true, icon: 'copy', onclick: async () => {
          try { await navigator.clipboard.writeText(s.serviceAccountEmail); toast('success', 'Copied'); } catch { toast('error', 'Could not copy. Select the email and copy it manually.'); }
        } }))
      : h('p', { class: 'muted' }, 'The service account email is not available.'),
    h('p', { class: 'help' }, 'Each client calendar must be shared with this email.'),
    h('ol', { class: 'steps' },
      h('li', {}, 'In Google Calendar, open the client calendar settings.'),
      h('li', {}, 'Under "Share with specific people", add the email above.'),
      h('li', {}, 'Choose the permission "See all event details".'))));

  // per-calendar sync
  const syncCard = card('Calendar sync', 'calendar',
    !cals.length
      ? emptyState('calendar', s.sync ? 'No calendars to sync. Add a client first.' : 'No sync has run yet. The first one starts shortly after launch.', null, true)
      : h('ul', { class: 'list' }, cals.map((c) => h('li', {},
        h('span', { class: 'li-icon tone-' + (c.ok ? 'success' : 'danger') }, icon(c.ok ? 'check-circle-2' : 'x-circle')),
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, c.client),
          h('div', { class: 'li-sub' }, c.ok ? `${c.upserted} updated, ${c.cancelled} cancelled, ${c.removed} removed` : (c.error && c.error.message) || 'unknown error')),
        pill(c.ok ? 'success' : 'danger', c.ok ? 'check-circle-2' : 'x-circle', c.ok ? 'Syncing' : 'Error')))),
    s.sync ? h('span', { class: 'progress' }, 'Last run ' + rel(s.sync.startedAt)) : null);
  syncCard.id = 'sync-card';

  // upcoming
  const upcoming = card('Upcoming calls (next 24 h)', 'clock',
    !s.upcoming.length ? emptyState('calendar', 'No calls in the next 24 hours.', null, true)
      : h('ul', { class: 'list' }, s.upcoming.map((e) => h('li', {},
        h('div', { class: 'call-time' }, h('strong', {}, rel(e.startUtc)), h('span', { class: 'li-sub' }, e.startIst)),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title' }, e.title || '(no title)'),
          h('div', { class: 'li-sub' }, e.client + (e.status === 'cancelled' ? ' (cancelled)' : '')),
          h('div', { class: 'chips' }, e.closers.length
            ? e.closers.map((n) => h('span', { class: 'chip' }, icon('users', 'sm'), n))
            : h('span', { class: 'li-sub' }, 'No closer invited'))),
        e.status === 'cancelled' && pill('danger', 'x-circle', 'Cancelled')))));

  // recent reminders
  const recent = card('Recent reminders', 'send',
    !s.recentReminders.length ? emptyState('send', 'No reminders have gone out yet.', null, true)
      : h('ul', { class: 'list' }, s.recentReminders.map((r) => h('li', {},
        h('span', { class: 'li-icon tone-' + (r.status === 'sent' ? 'success' : 'danger') }, icon(r.status === 'sent' ? 'check-circle-2' : 'alert-triangle')),
        h('div', { class: 'li-main' },
          h('div', { class: 'li-title' }, (r.title || '(unknown call)') + ' (' + r.offsetMin + ' min before)'),
          h('div', { class: 'li-sub' }, (r.client ? r.client + ' · ' : '') + 'call at ' + r.callStartIst),
          h('div', { class: 'li-sub' }, rel(r.sentAt) + ' · ' + r.sentAtIst)),
        pill(r.status === 'sent' ? 'success' : 'danger', r.status === 'sent' ? 'check-circle-2' : 'alert-triangle', r.status === 'sent' ? 'Sent' : 'Missed')))));

  body.append(h('div', { class: 'stack' }, tiles, h('div', { class: 'grid-2' }, checklist, h('div', { class: 'stack' }, saCard, syncCard)), upcoming, recent));
}

// ---------- shared list helpers ----------
function searchBox(label, placeholder, onInput) {
  const input = h('input', { class: 'input has-icon', type: 'search', placeholder, autocomplete: 'off', 'aria-label': label });
  input.addEventListener('input', () => onInput(input.value.trim().toLowerCase()));
  return h('div', { class: 'input-wrap search' }, icon('search'), input);
}

async function loadGroups(refresh) {
  if (state.groups && !refresh) return state.groups;
  state.groups = await api('GET', '/whatsapp/groups' + (refresh ? '?refresh=1' : ''));
  return state.groups;
}

/** Table of rows with a search box. cols: [{label, cell(row), cls, title}] ; actions(row) -> nodes. */
function entityList({ rows, cols, actions, matches, searchLabel, searchPlaceholder, empty, countNoun }) {
  const tbody = h('tbody', {});
  const count = h('span', { class: 'muted small count' });
  const draw = (q) => {
    clear(tbody);
    const shown = rows.filter((r) => !q || matches(r).some((v) => String(v || '').toLowerCase().includes(q)));
    count.textContent = shown.length + ' of ' + rows.length + ' ' + countNoun;
    if (!shown.length) {
      tbody.append(h('tr', {}, h('td', { colspan: cols.length + 1 }, emptyState('search', 'No matches for "' + q + '".', null, true))));
      return;
    }
    for (const r of shown) {
      tbody.append(h('tr', { class: r.active ? '' : 'is-off' },
        cols.map((c) => h('td', { 'data-label': c.label, class: c.cls || '' }, c.cell(r))),
        h('td', { class: 'actions' }, actions(r))));
    }
  };
  draw('');
  return h('div', { class: 'card' },
    h('div', { class: 'toolbar' }, searchBox(searchLabel, searchPlaceholder, draw), count),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, c.label)), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))), tbody)));
}

const statusPill = (active) => active ? pill('success', 'check-circle-2', 'Active') : pill('neutral', 'power', 'Disabled');

async function deleteFlow(noun, row, setActive, hardDelete) {
  const buttons = [{ label: 'Cancel', value: null, kind: 'secondary' }];
  buttons.push({ label: 'Delete permanently', value: 'delete', kind: 'danger-outline', icon: 'trash-2' });
  if (row.active) buttons.push({ label: 'Disable instead (recommended)', value: 'disable', kind: 'primary', icon: 'power', autofocus: true });
  else buttons[0].autofocus = true;
  const choice = await confirmDialog({
    title: 'Remove ' + row.name + '?', lead: 'trash-2', tone: 'danger', buttons,
    message: [
      'Disable keeps the ' + noun + ' and its history but stops reminders. You can enable it again at any time.',
      'Delete permanently removes the ' + noun + ' for good. This cannot be undone.',
    ],
  });
  try {
    if (choice === 'disable') { await setActive(false); toast('success', row.name + ' disabled.'); return true; }
    if (choice === 'delete') { await hardDelete(); toast('success', row.name + ' deleted.'); return true; }
  } catch (e) { toast('error', e.message); }
  return false;
}

// ---------- closers ----------
VIEWS.closers = async (main) => {
  const openForm = (editing, reload) => formModal({
    title: editing ? 'Edit closer' : 'Add closer', lead: 'users',
    fields: [
      { name: 'name', label: 'Name', value: editing && editing.name, help: 'As shown in the WhatsApp reminder.', autofocus: true },
      { name: 'email', label: 'Email', type: 'email', value: editing && editing.email, help: 'Must match the address the closer is invited with.' },
      { name: 'whatsapp', label: 'WhatsApp number', type: 'tel', inputmode: 'tel', value: editing && editing.whatsapp, help: 'International number with country code, e.g. +91 98765 43210.' },
    ],
    onSubmit: async (v) => {
      const body = { ...v, active: editing ? editing.active : true };
      if (editing) await api('PUT', '/closers/' + editing.id, body); else await api('POST', '/closers', body);
      toast('success', editing ? 'Closer saved.' : 'Closer added.');
      reload();
    },
  });
  mountPage(main, 'closers', {
    actions: (p) => button('Add closer', { icon: 'plus', onclick: () => openForm(null, () => p.reload()) }),
    load: () => api('GET', '/closers'),
    render: (body, list, p) => {
      if (!list.length) {
        body.append(h('div', { class: 'card' }, emptyState('users', 'No closers yet. Add the sales staff who should be tagged in call reminders.',
          button('Add closer', { icon: 'plus', onclick: () => openForm(null, () => p.reload()) }))));
        return;
      }
      const toggle = (c, active) => api('PUT', '/closers/' + c.id, { name: c.name, email: c.email, whatsapp: c.whatsapp, active });
      body.append(entityList({
        rows: list, countNoun: 'closers', searchLabel: 'Search closers', searchPlaceholder: 'Search by name or email',
        matches: (c) => [c.name, c.email, c.whatsapp],
        cols: [
          { label: 'Name', cls: 'title-cell cell-strong', cell: (c) => c.name },
          { label: 'Email', cell: (c) => h('span', {}, icon('mail', 'sm'), ' ', c.email) },
          { label: 'WhatsApp', cell: (c) => h('span', {}, icon('phone', 'sm'), ' ', c.whatsapp) },
          { label: 'Status', cell: (c) => statusPill(c.active) },
        ],
        actions: (c) => [
          iconButton('pencil', 'Edit ' + c.name, () => openForm(c, () => p.reload())),
          iconButton('power', (c.active ? 'Disable ' : 'Enable ') + c.name, async () => {
            try { await toggle(c, !c.active); toast('success', c.name + (c.active ? ' disabled.' : ' enabled.')); p.reload(true); } catch (e) { toast('error', e.message); }
          }),
          iconButton('trash-2', 'Delete ' + c.name, async () => {
            if (await deleteFlow('closer', c, (a) => toggle(c, a), () => api('DELETE', '/closers/' + c.id + '?hard=1'))) p.reload(true);
          }, 'danger'),
        ],
        empty: '',
      }));
    },
  }).reload();
};

// ---------- group picker ----------
function groupPicker(initialId, getGroups) {
  let selectedId = initialId || '';
  let groups = [];
  let mode = 'picker'; // 'picker' | 'manual'
  let failed = false;
  let activeIdx = -1;
  const uid = Math.random().toString(36).slice(2, 7);
  const listId = 'groups-' + uid;
  const search = h('input', {
    id: 'picker-' + uid, class: 'input has-icon', type: 'text', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId,
    'aria-autocomplete': 'list', autocomplete: 'off', placeholder: 'Search your WhatsApp groups', 'aria-label': 'WhatsApp group',
  });
  const list = h('ul', { class: 'picker-list', id: listId, role: 'listbox', 'aria-label': 'WhatsApp groups', hidden: true });
  const note = h('div', { class: 'help', 'aria-live': 'polite' }, 'Loading groups...');
  const manualInput = h('input', { class: 'input mono', type: 'text', placeholder: '1203630000000000@g.us', autocomplete: 'off', 'aria-label': 'Group ID (ends in @g.us)', value: initialId || '' });
  const refreshBtn = iconButton('refresh-cw', 'Refresh groups', () => load(true), 'btn-secondary');
  const toManual = h('button', { type: 'button', class: 'btn-link small' }, 'Enter ID manually');
  const toPicker = h('button', { type: 'button', class: 'btn-link small' }, 'Pick from your groups');
  const retryBtn = button('Retry', { kind: 'secondary', small: true, icon: 'refresh-cw', onclick: () => load(true) });
  const failBox = h('div', { class: 'callout callout-warning', role: 'alert', hidden: true },
    icon('alert-triangle'), h('div', { class: 'picker-fail' }, h('div', {}, "Couldn't load your WhatsApp groups. Check that WhatsApp is connected (Dashboard), then retry."), retryBtn));
  const pickerPart = h('div', {},
    h('div', { class: 'picker-row' }, h('div', { class: 'input-wrap' }, icon('message-circle'), search), refreshBtn),
    list, note, h('div', { class: 'picker-extra' }, toManual));
  const manualPart = h('div', { hidden: true }, manualInput,
    h('div', { class: 'picker-extra' }, toPicker));

  const nameOf = (id) => { const g = groups.find((x) => x.id === id); return g ? g.name : null; };
  const showSelected = () => { search.value = selectedId ? (nameOf(selectedId) || selectedId) : ''; };
  const options = () => [...list.querySelectorAll('.picker-opt')];
  const setActive = (i) => {
    const opts = options();
    activeIdx = opts.length ? (i + opts.length) % opts.length : -1;
    opts.forEach((o, k) => { o.classList.toggle('active', k === activeIdx); });
    if (activeIdx >= 0) { search.setAttribute('aria-activedescendant', opts[activeIdx].id); opts[activeIdx].scrollIntoView({ block: 'nearest' }); }
    else search.removeAttribute('aria-activedescendant');
  };
  const openList = (open) => { list.hidden = !open; search.setAttribute('aria-expanded', String(open)); if (!open) search.removeAttribute('aria-activedescendant'); };
  const choose = (g) => { selectedId = g.id; showSelected(); openList(false); manualInput.value = g.id; };
  const fill = (filter) => {
    clear(list);
    const q = (filter || '').trim().toLowerCase();
    const shown = groups.filter((g) => !q || g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q)).slice(0, 100);
    if (!shown.length) list.append(h('li', { class: 'picker-none', role: 'presentation' }, groups.length ? 'No groups match.' : 'No groups found.'));
    shown.forEach((g, i) => {
      const opt = h('li', { class: 'picker-opt', id: listId + '-' + i, role: 'option', 'aria-selected': String(g.id === selectedId) },
        h('span', { class: 'picker-name' }, g.name), h('span', { class: 'picker-id' }, g.id));
      opt.addEventListener('mousedown', (ev) => { ev.preventDefault(); choose(g); });
      list.append(opt);
    });
    activeIdx = -1;
  };
  // Exactly one of: picker, manual field, or (groups failed) warning + manual field.
  const render = () => {
    const manual = failed || mode === 'manual';
    pickerPart.hidden = manual;
    manualPart.hidden = !manual;
    failBox.hidden = !failed;
    toPicker.hidden = failed;
  };
  search.addEventListener('focus', () => { search.select(); fill(''); openList(true); });
  search.addEventListener('click', () => { if (list.hidden) { fill(''); openList(true); } });
  search.addEventListener('input', () => { fill(search.value); openList(true); setActive(0); });
  search.addEventListener('blur', () => { openList(false); showSelected(); });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (list.hidden) { fill(search.value); openList(true); } setActive(activeIdx + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(activeIdx - 1); }
    else if (ev.key === 'Enter' && !list.hidden) {
      ev.preventDefault();
      const opts = options();
      const i = activeIdx >= 0 ? activeIdx : 0;
      if (opts[i]) opts[i].dispatchEvent(new MouseEvent('mousedown', { cancelable: true }));
    } else if (ev.key === 'Escape' && !list.hidden) {
      ev.preventDefault(); ev.stopPropagation();
      escGuard = true; setTimeout(() => { escGuard = false; }, 0);
      openList(false); showSelected();
    }
  });
  toManual.addEventListener('click', () => { mode = 'manual'; manualInput.value = selectedId; render(); manualInput.focus(); });
  toPicker.addEventListener('click', () => { mode = 'picker'; selectedId = manualInput.value.trim(); showSelected(); render(); search.focus(); });
  function load(refresh) {
    note.textContent = 'Loading groups...';
    setBusy(refreshBtn, true); setBusy(retryBtn, true);
    getGroups(refresh).then((g) => {
      groups = g; failed = false; showSelected();
      note.textContent = g.length + ' group' + (g.length === 1 ? '' : 's') + ' found. Start typing to filter.';
      render();
      if (!pickerPart.hidden && failBox.hidden && document.activeElement === retryBtn) search.focus();
    }).catch(() => {
      failed = true; render();
      manualInput.value = selectedId;
    }).finally(() => { setBusy(refreshBtn, false); setBusy(retryBtn, false); });
  }
  load(false);
  showSelected();
  render();
  const node = h('div', {}, failBox, pickerPart, manualPart);
  return { node, get: () => ((failed || mode === 'manual') ? manualInput.value.trim() : selectedId.trim()), search };
}

// ---------- clients ----------
VIEWS.clients = async (main) => {
  loadGroups(false).catch(() => {});
  const groupName = (id) => { const g = (state.groups || []).find((x) => x.id === id); return g ? g.name : null; };
  const openForm = (editing, reload) => {
    const picker = groupPicker(editing && editing.whatsappGroupId, loadGroups);
    return formModal({
      title: editing ? 'Edit client' : 'Add client', lead: 'building-2',
      fields: [
        { name: 'name', label: 'Client name', value: editing && editing.name, help: 'Used in the reminder and in this panel.', autofocus: true },
        { name: 'calendarId', label: 'Calendar ID', value: editing && editing.calendarId, help: "Calendar owner's Gmail address. The calendar must be shared with the service account." },
        { name: 'whatsappGroupId', label: 'WhatsApp group', node: picker.node, get: picker.get, help: null },
      ],
      onSubmit: async (v) => {
        const body = { ...v, active: editing ? editing.active : true };
        if (editing) await api('PUT', '/clients/' + editing.id, body); else await api('POST', '/clients', body);
        toast('success', 'Client saved. The next sync (within 2 minutes) picks it up.');
        reload();
      },
    });
  };
  const sendTest = async (c) => {
    const name = groupName(c.whatsappGroupId);
    const choice = await confirmDialog({
      title: 'Send a test message?', lead: 'send', tone: 'info',
      message: ['This posts a short test message to the WhatsApp group ' + (name ? '"' + name + '"' : c.whatsappGroupId) + ' for ' + c.name + '. Everyone in the group will see it.'],
      buttons: [{ label: 'Cancel', value: null, kind: 'secondary' }, { label: 'Send test message', value: 'send', kind: 'primary', icon: 'send', autofocus: true }],
    });
    if (choice !== 'send') return;
    try { await api('POST', '/clients/' + c.id + '/test-message', {}); toast('success', 'Test message sent to ' + (name || c.name) + '.'); } catch (e) { toast('error', e.message); }
  };
  mountPage(main, 'clients', {
    actions: (p) => button('Add client', { icon: 'plus', onclick: () => openForm(null, () => p.reload()) }),
    load: () => api('GET', '/clients'),
    render: (body, list, p) => {
      if (!list.length) {
        body.append(h('div', { class: 'card' }, emptyState('building-2', 'No clients yet. Add a client calendar and the WhatsApp group its reminders should go to.',
          button('Add client', { icon: 'plus', onclick: () => openForm(null, () => p.reload()) }))));
        return;
      }
      const toggle = (c, active) => api('PUT', '/clients/' + c.id, { name: c.name, calendarId: c.calendarId, whatsappGroupId: c.whatsappGroupId, active });
      body.append(entityList({
        rows: list, countNoun: 'clients', searchLabel: 'Search clients', searchPlaceholder: 'Search by name or calendar',
        matches: (c) => [c.name, c.calendarId, c.whatsappGroupId, groupName(c.whatsappGroupId)],
        cols: [
          { label: 'Client', cls: 'title-cell cell-strong', cell: (c) => c.name },
          { label: 'Calendar', cell: (c) => h('span', { class: 'mono' }, c.calendarId) },
          { label: 'WhatsApp group', cell: (c) => h('span', {}, groupName(c.whatsappGroupId) && h('div', { class: 'cell-strong' }, groupName(c.whatsappGroupId)), h('div', { class: 'cell-sub mono' }, c.whatsappGroupId)) },
          { label: 'Status', cell: (c) => statusPill(c.active) },
        ],
        actions: (c) => [
          iconButton('send', 'Send test message to ' + c.name, () => sendTest(c)),
          iconButton('pencil', 'Edit ' + c.name, () => openForm(c, () => p.reload())),
          iconButton('power', (c.active ? 'Disable ' : 'Enable ') + c.name, async () => {
            try { await toggle(c, !c.active); toast('success', c.name + (c.active ? ' disabled.' : ' enabled.')); p.reload(true); } catch (e) { toast('error', e.message); }
          }),
          iconButton('trash-2', 'Delete ' + c.name, async () => {
            if (await deleteFlow('client', c, (a) => toggle(c, a), () => api('DELETE', '/clients/' + c.id + '?hard=1'))) p.reload(true);
          }, 'danger'),
        ],
        empty: '',
      }));
    },
  }).reload();
};

// ---------- settings ----------
VIEWS.settings = async (main) => {
  mountPage(main, 'settings', {
    load: () => api('GET', '/settings'),
    render: (body, s) => {
      let saved = s.reminderOffsets.slice();
      let offsets = s.reminderOffsets.slice();
      const chips = h('div', { class: 'chips', role: 'list', 'aria-label': 'Reminder offsets' });
      const preview = h('div', { class: 'preview' });
      const err = h('div', { 'aria-live': 'polite' });
      const input = h('input', { id: 'offset-input', class: 'input', type: 'number', min: '1', max: '1440', step: '1', inputmode: 'numeric', placeholder: 'e.g. 15' });
      const save = button('Save', { type: 'submit', icon: 'check-circle-2' });
      const dirty = () => offsets.length !== saved.length || offsets.some((v, i) => v !== saved[i]);
      const sorted = () => offsets.slice().sort((a, b) => b - a);
      const draw = () => {
        clear(chips);
        for (const n of sorted()) {
          chips.append(h('span', { class: 'chip', role: 'listitem' }, n + ' min before',
            h('button', { type: 'button', class: 'chip-remove', 'aria-label': 'Remove ' + n + ' minutes', title: 'Remove', onclick: () => { offsets = offsets.filter((x) => x !== n); draw(); } }, icon('x', 'sm'))));
        }
        if (!offsets.length) chips.append(h('span', { class: 'muted' }, 'No reminders. Add at least one offset.'));
        clear(preview);
        const base = 17 * 60;
        const times = sorted().map((o) => ({ ...clock(base - o), prev: base - o < 0 }));
        preview.append(icon('clock'), h('div', {}, offsets.length
          ? 'For a call at 5:00 PM, reminders go out at ' + times.map((t, i) => t.text + (t.prev ? ' (day before)' : '') + (i === times.length - 1 || t.ampm !== times[i + 1].ampm ? ' ' + t.ampm : '')).join(', ') + '.'
          : 'No reminders will be sent.'));
        save.disabled = !dirty() || !offsets.length;
      };
      const add = () => {
        clear(err);
        const n = Number(input.value);
        const problem = !input.value.trim() || !Number.isInteger(n) || n < 1 || n > 1440 ? 'Enter a whole number of minutes from 1 to 1440.'
          : offsets.includes(n) ? n + ' min is already in the list.' : offsets.length >= 10 ? 'At most 10 reminders.' : null;
        if (problem) { err.append(h('div', { class: 'field-error' }, icon('alert-triangle', 'sm'), problem)); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        input.removeAttribute('aria-invalid');
        offsets.push(n); input.value = ''; draw(); input.focus();
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
      const reset = button('Reset to defaults', { kind: 'secondary', icon: 'refresh-cw', onclick: () => { offsets = DEFAULT_OFFSETS.slice(); clear(err); draw(); toast('info', 'Defaults restored (60, 30, 10, 5). Press Save to apply.'); } });
      const form = h('form', {
        onsubmit: async (ev) => {
          ev.preventDefault();
          clear(err);
          setBusy(save, true);
          try {
            const res = await api('PUT', '/settings', { reminderOffsets: sorted() });
            saved = res.reminderOffsets.slice(); offsets = res.reminderOffsets.slice();
            toast('success', 'Saved. Applies from the next reminder run (within a minute).');
          } catch (e) {
            err.append(callout('danger', (e.fields && e.fields.reminderOffsets) || e.message));
          } finally { setBusy(save, false); draw(); }
        },
      },
      h('div', { class: 'label' }, 'Send a reminder'), chips,
      h('div', { class: 'field add-row' }, h('div', { class: 'field' }, h('label', { for: 'offset-input' }, 'Minutes before the call'), input),
        button('Add', { kind: 'secondary', icon: 'plus', onclick: add })),
      err, preview,
      h('div', { class: 'form-actions' }, reset, save));
      draw();
      body.append(h('div', { class: 'stack' },
        h('div', { class: 'card card-pad' }, form),
        h('div', { class: 'callout callout-info' }, icon('info'), h('div', {},
          'One WhatsApp message goes out per call and offset, tagging every closer invited. Changes apply within a minute, no restart needed. ',
          'Whole minutes 1 to 1440, up to 10, no duplicates. An offset you add later is only sent if its time is still ahead, and is never reported as "missed" for calls already known.'))));
    },
  }).reload();
};

// ---------- whatsapp (superadmin) ----------
const whatsappTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }) + ' IST';

VIEWS.whatsapp = async (main) => {
  if (state.me.role !== 'superadmin') { clear(main).append(h('div', { class: 'page' }, callout('danger', 'Superadmin only.'))); return; }
  const confirmAndPost = async ({ title, message, label, kind, ic, path, body, done, lead }) => {
    const choice = await confirmDialog({
      title, lead: lead || 'message-circle', tone: kind === 'danger' ? 'danger' : 'warning', message,
      buttons: [{ label: 'Cancel', value: null, kind: 'secondary', autofocus: true }, { label, value: 'go', kind: kind === 'danger' ? 'danger' : 'primary', icon: ic }],
    });
    if (choice !== 'go') return;
    try { await api('POST', path, body); state.groups = null; toast('info', done); } catch (e) { toast('error', e.message); }
  };
  const page = mountPage(main, 'whatsapp', {
    actions: (p) => button('Refresh', { kind: 'secondary', icon: 'refresh-cw', onclick: () => p.reload(true) }),
    load: () => api('GET', '/whatsapp/session'),
    render: (body, first) => {
      stopTimer();
      const tok = state.token;
      let prev = first.status;
      let qrAge = 0;
      const statusBox = h('div', {});
      const qrBox = h('div', {});
      body.append(h('div', { class: 'stack' }, statusBox, qrBox));
      const qrState = { tab: 'qr', code: null };

      let lastSig = null;
      let checkedEl = null;
      const drawStatus = (s, err) => {
        const sig = err ? null : [s.status, s.me && s.me.phone, s.me && s.me.name].join('|');
        if (!err && sig === lastSig && checkedEl) { checkedEl.textContent = whatsappTime(s.checkedAt); return; } // keep focus on the buttons
        lastSig = sig;
        clear(statusBox);
        if (err) {
          statusBox.append(h('div', { class: 'card' }, h('div', { class: 'empty' },
            h('div', { class: 'empty-icon tone-danger' }, icon('alert-triangle', 'xl')),
            h('h2', {}, 'WhatsApp (WAHA) is not reachable'),
            h('p', {}, 'The admin server could not talk to the WhatsApp service. Reminders cannot be sent until it is back. ' + err),
            button('Try again', { icon: 'refresh-cw', onclick: poll }))));
          return;
        }
        const ok = s.status === 'WORKING';
        const tone = ok ? 'success' : s.status === 'FAILED' || s.status === 'STOPPED' ? 'danger' : 'warning';
        const stopped = s.status === 'STOPPED' || s.status === 'FAILED';
        statusBox.append(h('section', { class: 'card' },
          h('div', { class: 'card-head' }, icon('message-circle'), h('h2', {}, 'Connection'), pill(tone, ok ? 'check-circle-2' : 'alert-triangle', wahaLabel(s.status))),
          h('div', { class: 'card-body' },
            h('div', { class: 'tile wa-tile' },
              h('div', { class: 'tile-icon tone-' + tone }, icon('phone', 'lg')),
              h('div', {}, h('div', { class: 'tile-label' }, 'Linked number'),
                h('div', { class: 'tile-value' }, s.me ? '+' + s.me.phone : 'No number linked'),
                h('div', { class: 'tile-sub' }, (s.me && s.me.name ? s.me.name + ' · ' : '') + 'Raw status ' + s.status + ' · checked ', checkedEl = h('span', {}, whatsappTime(s.checkedAt))))),
            h('div', { class: 'form-actions wa-actions' },
              stopped && button('Start session', { kind: 'secondary', icon: 'power', onclick: () => confirmAndPost({
                title: 'Start the WhatsApp session?', message: ['Starts the session. If no number is linked, a QR code appears on this page.'], label: 'Start session', ic: 'power',
                path: '/whatsapp/start', body: {}, done: 'Starting the session…', lead: 'power' }).then(poll) }),
              button('Restart session', { kind: 'secondary', icon: 'refresh-cw', onclick: () => confirmAndPost({
                title: 'Restart the WhatsApp session?', message: ['The session is stopped and started again. Reminders may be delayed for about a minute. The linked number stays linked.'], label: 'Restart session', ic: 'refresh-cw',
                path: '/whatsapp/restart', body: {}, done: 'Restarting the session…', lead: 'refresh-cw' }).then(poll) }),
              button('Switch number', { kind: 'danger-outline', icon: 'log-out', onclick: () => confirmAndPost({
                title: 'Switch the WhatsApp number?', kind: 'danger', label: 'Log out and switch', ic: 'log-out', lead: 'alert-triangle',
                message: [
                  'This logs the current number out. Reminders pause until a new number is linked by scanning the QR code that appears here.',
                  'The new number must be a member of every client WhatsApp group. Group IDs stay the same, so no client settings need to change.',
                ],
                path: '/whatsapp/switch-number', body: { confirm: true }, done: 'Logged out. Scan the new QR code to link a number.' }).then(poll) })))));
      };

      const drawQr = (s) => {
        clear(qrBox);
        if (s.status === 'STARTING') { qrBox.append(callout('info', 'The session is starting. A QR code appears here when it is ready.')); return; }
        if (s.status !== 'SCAN_QR_CODE') return;
        const img = h('img', { class: 'qr-img', alt: 'WhatsApp QR code to scan', width: '280', height: '280', src: '/api/whatsapp/qr?ts=' + Date.now() });
        const qrNote = h('div', { class: 'help', 'aria-live': 'polite' }, 'The code refreshes automatically every 15 seconds.');
        img.addEventListener('error', () => { qrNote.textContent = 'The QR code is not ready yet. Retrying…'; });
        img.addEventListener('load', () => { qrNote.textContent = 'The code refreshes automatically every 15 seconds.'; });
        qrState.img = img;
        const steps = (items) => h('ol', { class: 'steps' }, items.map((t) => h('li', {}, t)));
        const tabBtn = (id, label, ic) => h('button', {
          type: 'button', role: 'tab', class: 'tab' + (qrState.tab === id ? ' active' : ''), 'aria-selected': String(qrState.tab === id),
          onclick: () => { qrState.tab = id; drawQr(s); },
        }, icon(ic), label);
        let panel;
        if (qrState.tab === 'qr') {
          panel = h('div', { class: 'qr-panel' }, h('div', { class: 'qr-frame' }, img),
            h('div', {}, qrNote, steps(['Open WhatsApp on the phone with the new number.', 'Tap Settings, then Linked devices.', 'Tap Link a device and scan this code.'])));
        } else {
          const phone = h('input', { id: 'pair-phone', class: 'input', type: 'tel', inputmode: 'tel', placeholder: '919876543210', autocomplete: 'off' });
          const errBox = h('div', { 'aria-live': 'polite' });
          const out = h('div', {});
          const getBtn = button('Get code', { icon: 'send', type: 'submit' });
          if (qrState.code) out.append(h('div', { class: 'pair-code', 'aria-label': 'Pairing code' }, qrState.code));
          panel = h('form', { class: 'qr-panel', onsubmit: async (ev) => {
            ev.preventDefault(); clear(errBox); clear(out); setBusy(getBtn, true);
            try {
              const r = await api('POST', '/whatsapp/pairing-code', { phoneNumber: phone.value });
              qrState.code = r.code; out.append(h('div', { class: 'pair-code', 'aria-label': 'Pairing code' }, r.code));
            } catch (e) { errBox.append(h('div', { class: 'field-error' }, icon('alert-triangle', 'sm'), (e.fields && e.fields.phoneNumber) || e.message)); }
            finally { setBusy(getBtn, false); }
          } },
          h('div', {}, h('div', { class: 'field' }, h('label', { for: 'pair-phone' }, 'Phone number to link'), phone,
            h('div', { class: 'help' }, 'Digits with the country code, e.g. 919876543210. This is the number whose WhatsApp you are linking.'), errBox), getBtn),
          h('div', {}, out, steps(['Open WhatsApp on that phone.', 'Tap Settings, then Linked devices, then Link a device.', 'Choose "Link with phone number instead" and type the code shown here.']),
            h('p', { class: 'help' }, 'If the code does not work, use the QR code instead.')));
        }
        qrBox.append(h('section', { class: 'card' },
          h('div', { class: 'card-head' }, icon('phone'), h('h2', {}, 'Link a number')),
          h('div', { class: 'card-body' },
            h('div', { class: 'tabs', role: 'tablist' }, tabBtn('qr', 'Scan QR code', 'message-circle'), tabBtn('code', 'Link with phone number instead', 'phone')),
            panel)));
      };

      let qrShown = null;
      const qrWant = (s) => (s.status === 'SCAN_QR_CODE' || s.status === 'STARTING' ? s.status : '');
      const update = (s) => {
        if (prev !== 'WORKING' && s.status === 'WORKING') toast('success', 'WhatsApp connected' + (s.me ? ' as +' + s.me.phone : '') + '.');
        prev = s.status;
        drawStatus(s);
        if (qrWant(s) !== qrShown) { qrShown = qrWant(s); qrAge = 0; drawQr(s); }
        else if (s.status === 'SCAN_QR_CODE' && ++qrAge >= 5 && qrState.tab === 'qr' && qrState.img) { qrAge = 0; qrState.img.src = '/api/whatsapp/qr?ts=' + Date.now(); }
      };
      let polling = false;
      async function poll() {
        if (polling || document.hidden) return;
        polling = true;
        try {
          const s = await api('GET', '/whatsapp/session');
          if (tok === state.token) update(s); // ignore a poll that finished after navigating away
        } catch (e) { if (e.status !== 401 && tok === state.token) drawStatus(null, e.message); }
        finally { polling = false; }
      }
      state.refresh = poll;
      state.timer = setInterval(poll, 3000);
      drawStatus(first);
      qrShown = qrWant(first);
      drawQr(first);
    },
  });
  await page.reload();
};

// ---------- admins ----------
VIEWS.admins = async (main) => {
  if (state.me.role !== 'superadmin') { clear(main).append(h('div', { class: 'page' }, callout('danger', 'Superadmin only.'))); return; }
  const openAdd = (reload) => formModal({
    title: 'Add admin', lead: 'shield', submitLabel: 'Add admin',
    fields: [{ name: 'email', label: 'Google account email', type: 'email', help: 'They sign in with Google. They can manage closers, clients and settings, but not other admins.', autofocus: true }],
    onSubmit: async (v) => { await api('POST', '/admins', { email: v.email }); toast('success', 'Admin added.'); reload(); },
  });
  mountPage(main, 'admins', {
    actions: (p) => button('Add admin', { icon: 'plus', onclick: () => openAdd(() => p.reload()) }),
    load: async () => {
      const [data, cfg] = await Promise.all([api('GET', '/admins'), api('GET', '/auth/config').catch(() => null)]);
      return { data, googleOn: !!(cfg && cfg.googleClientId) };
    },
    render: (body, { data, googleOn }, p) => {
      const parts = [];
      if (!googleOn) parts.push(callout('warning', 'Google login is not configured (GOOGLE_OAUTH_CLIENT_ID is unset), so added admins cannot sign in yet. Only the superadmin can use the password.'));
      parts.push(h('div', { class: 'card' }, h('ul', { class: 'list' },
        h('li', {}, h('span', { class: 'li-icon tone-info' }, icon('shield')),
          h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, data.superadmin), h('div', { class: 'li-sub' }, 'From the server environment, cannot be removed')),
          pill('info', 'shield', 'Superadmin')),
        data.admins.map((a) => h('li', {}, h('span', { class: 'li-icon tone-neutral' }, icon('mail')),
          h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, a.email), h('div', { class: 'li-sub' }, 'Added by ' + a.addedBy + ' · ' + fmtTime(a.createdAt))),
          pill('neutral', 'users', 'Admin'),
          iconButton('trash-2', 'Remove admin ' + a.email, async () => {
            const choice = await confirmDialog({
              title: 'Remove ' + a.email + '?', lead: 'trash-2', tone: 'danger',
              message: ['They are signed out immediately and can no longer use the admin panel.'],
              buttons: [{ label: 'Cancel', value: null, kind: 'secondary', autofocus: true }, { label: 'Remove admin', value: 'remove', kind: 'danger', icon: 'trash-2' }],
            });
            if (choice !== 'remove') return;
            try { await api('DELETE', '/admins/' + encodeURIComponent(a.email)); toast('success', 'Admin removed.'); p.reload(true); } catch (e) { toast('error', e.message); }
          }, 'danger'))),
        !data.admins.length && h('li', {}, h('div', { class: 'li-main li-sub' }, 'No other admins yet. Use "Add admin" to invite one.')))));
      body.append(h('div', { class: 'stack' }, parts));
    },
  }).reload();
};

// ---------- audit ----------
const AUDIT = {
  login: ['log-in', 'info', 'Signed in'],
  closer_create: ['users', 'success', 'Closer added'], closer_update: ['pencil', 'info', 'Closer updated'],
  closer_disable: ['power', 'warning', 'Closer disabled'], closer_hard_delete: ['trash-2', 'danger', 'Closer deleted'],
  client_create: ['building-2', 'success', 'Client added'], client_update: ['pencil', 'info', 'Client updated'],
  client_disable: ['power', 'warning', 'Client disabled'], client_hard_delete: ['trash-2', 'danger', 'Client deleted'],
  send_test_message: ['send', 'info', 'Test message sent'], settings_update: ['bell', 'info', 'Reminder settings changed'],
  whatsapp_start: ['power', 'info', 'WhatsApp session started'], whatsapp_restart: ['refresh-cw', 'warning', 'WhatsApp session restarted'],
  whatsapp_logout: ['log-out', 'danger', 'WhatsApp logged out'], whatsapp_switch_number: ['message-circle', 'danger', 'WhatsApp number switched'],
  whatsapp_pairing_code: ['phone', 'info', 'WhatsApp pairing code requested'],
  admin_add: ['shield', 'success', 'Admin added'], admin_remove: ['shield', 'danger', 'Admin removed'],
};
VIEWS.audit = async (main) => {
  mountPage(main, 'audit', {
    actions: (p) => button('Refresh', { kind: 'secondary', icon: 'refresh-cw', onclick: () => p.reload(true) }),
    load: () => api('GET', '/audit'),
    render: (body, rows) => {
      if (!rows.length) { body.append(h('div', { class: 'card' }, emptyState('scroll-text', 'Nothing recorded yet. Changes made in this panel will show up here.'))); return; }
      body.append(h('div', { class: 'card' }, h('ol', { class: 'timeline' }, rows.map((r) => {
        const [ic, tone, label] = AUDIT[r.action] || ['scroll-text', 'neutral', r.action];
        const hasDetails = r.details && Object.keys(r.details).length > 0;
        return h('li', {},
          h('span', { class: 'li-icon tone-' + tone }, icon(ic)),
          h('div', { class: 'li-main' },
            h('div', { class: 'li-title' }, label),
            h('div', { class: 'li-sub' }, 'by ' + r.actor),
            h('div', { class: 'tl-time' }, rel(r.at) + ' · ' + fmtTime(r.at)),
            hasDetails && h('details', {}, h('summary', {}, 'Details'), h('pre', {}, JSON.stringify(r.details, null, 2)))));
      }))));
    },
  }).reload();
};

start();
