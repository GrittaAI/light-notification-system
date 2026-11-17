// Nudge admin area (admin and superadmin only): People, Access, Notifications, Audit. Material 3 lists, cards and sheets.
// Works online only: nothing here is queued in the outbox. The server enforces every rule; the UI only hides or
// disables what the server would refuse. All text is inserted with textContent / text nodes. Times are IST.
// Also exports nudgePreviewBlock (test a person's nudge), used by "My nudges" for every user.
import { fmtDateTime, fmtRelative, fmtTime } from './sync-core.js';

export const ADMIN_TABS = [['people', 'People', 'users'], ['access', 'Access', 'eye'], ['notifications', 'Notifications', 'bell-ring'], ['audit', 'Audit', 'history']];

const initials = (name) => (String(name).trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('') || '?').toUpperCase();
const groupState = { list: null, error: null };
/** Clears `node` and fills it with `kids`, skipping false/null (so `cond && element` is safe). */
function fill(node, ...kids) {
  while (node.firstChild) node.removeChild(node.firstChild);
  node.append(...kids.flat().filter((k) => k !== false && k !== null && k !== undefined));
  return node;
}
const errText = (e) => (e.network ? 'You are offline. Admin changes need a connection.' : e.message);

/** ctx: { h, clear, icon, api, toast, openSheet, sheetHead, listItem, S } from app.js. */
export function renderAdminPage(ctx, mount, tab) {
  const { h, clear, icon, S } = ctx;
  const t = ADMIN_TABS.some(([k]) => k === tab) ? tab : 'people';
  const body = h('div', { class: 'admin-body' });
  clear(mount).append(
    h('nav', { class: 'tabs', 'aria-label': 'Admin sections' },
      ADMIN_TABS.map(([k, label, ic]) => h('a', { class: 'tab', href: '#/admin/' + k, 'aria-current': k === t ? 'page' : false }, icon(ic, 'sm'), label))),
    body);
  const run = { people: renderPeople, access: renderAccess, notifications: renderNotifications, audit: renderAudit }[t];
  // The admin area needs a connection: offline (or a network failure) shows the message instead of a form.
  const offline = () => {
    fill(body, h('div', { class: 'empty', id: 'admin-offline' }, h('div', { class: 'icon-wrap' }, icon('cloud-off', 'xl')), h('h2', {}, 'Admin needs a connection'),
      h('p', {}, 'People, access and notification settings can only be changed online. Your tasks still work offline.'),
      h('button', { type: 'button', class: 'btn tonal', onclick: () => renderAdminPage(ctx, mount, t) }, icon('refresh-cw'), 'Try again')));
  };
  if (!navigator.onLine || !S.online) { offline(); return; }
  fill(body, h('div', { 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
  run({ ...ctx, offline, body }).catch((e) => {
    if (e.network) offline();
    else fill(body, h('div', { class: 'callout danger', role: 'alert' }, icon('alert-triangle'), h('span', {}, e.status === 403 ? 'Admins only.' : e.message)));
  });
}

// ---------- shared pieces ----------

function field(ctx, label, control, { error, help, id } = {}) {
  const { h } = ctx;
  return h('div', { class: 'field' },
    h('label', id ? { for: id } : {}, label), control,
    help && h('p', { class: 'small muted' }, help),
    error && h('p', { class: 'error-text', role: 'alert' }, error));
}
/**
 * A Material "select": a field-styled button showing the current choice; tapping opens a sheet with a radio list.
 * Replaces native <select> (whose popup is drawn by the OS, off-theme and oddly placed on phones). Use on pages only:
 * inside another sheet it would replace that sheet.
 */
function pickerField(ctx, { id, label, value, options, onChange, disabled, title }) {
  const { h, icon } = ctx;
  const current = () => options.find((o) => o.value === value);
  const btn = h('button', { type: 'button', class: 'input picker-field', id, disabled, 'aria-haspopup': 'dialog', 'aria-label': `${label}: ${current() ? current().label : 'none'}` },
    current() && current().lead, h('span', { class: 'pf-text' }, current() ? current().label : 'Choose…'), icon('chevron-down', 'sm'));
  btn.addEventListener('click', () => {
    const c = h('div', {});
    const close = ctx.openSheet(c, { label: title || label });
    c.append(...ctx.sheetHead(title || label),
      h('div', { class: 'list', role: 'radiogroup', 'aria-label': label }, options.map((o) => ctx.listItem({
        lead: o.lead, head: o.label, sub: o.sub, trail: o.value === value ? icon('check', 'sm') : null,
        attrs: { role: 'radio', 'aria-checked': String(o.value === value) },
        onclick: () => { close(); if (o.value !== value) onChange(o.value); },
      }))));
  });
  return btn;
}
const personOption = (ctx, p, me) => ({ value: p.id, label: p.name + (p.id === me ? ' (me)' : ''), sub: p.email, lead: ctx.h('span', { class: 'avatar sm' }, initials(p.name)) });

const cardTitle = (ctx, ic, text, extra) => ctx.h('div', { class: 'block-label' }, ctx.icon(ic, 'sm'), text, extra && ctx.h('span', { class: 'spacer' }), extra);

async function loadGroups(ctx, refresh) {
  try {
    groupState.list = await ctx.api('GET', '/api/nudge/groups' + (refresh ? '?refresh=1' : ''));
    groupState.error = null;
  } catch (e) {
    if (e.network) throw e;
    groupState.error = e.message;
    groupState.list = groupState.list || [];
  }
  return groupState.list;
}
const groupName = (id) => {
  const g = (groupState.list || []).find((x) => x.id === id);
  return g ? g.name : null;
};

const GROUP_ID = /^[\w-]+@g\.us$/;

/** A searchable, refreshable group list with a manual "Enter group ID" fallback. `onPick(id|null)`; `allowNone` adds a "No default group" row. */
function groupPicker(ctx, { value, onPick, allowNone }) {
  const { h, icon } = ctx;
  let query = '';
  let manual = false;
  const box = h('div', { class: 'stack' });
  const list = h('div', { class: 'picker-list', role: 'radiogroup', 'aria-label': 'WhatsApp group' });
  const status = h('p', { class: 'small muted' });
  const manualBox = h('div', { class: 'manual-id' });
  const manualLink = h('button', { type: 'button', class: 'link-btn', id: 'manual-id-link', onclick: () => { manual = true; draw(); const i = box.querySelector('#manual-id'); if (i) i.focus(); } }, 'Enter group ID manually');
  const item = (checked, lead, head, sub, onclick) => h('button', { type: 'button', class: 'picker-item', role: 'radio', 'aria-checked': String(checked), onclick },
    lead, h('span', { class: 'li-body' }, h('span', {}, head), sub && h('span', { class: 'small muted' }, sub)), h('span', { class: 'spacer' }), checked && icon('check', 'sm'));
  const draw = () => {
    ctx.clear(list);
    const q = query.trim().toLowerCase();
    const all = groupState.list || [];
    const items = all.filter((g) => !q || g.name.toLowerCase().includes(q));
    if (allowNone) list.append(item(!value, icon('x', 'sm'), 'No default group', null, () => { value = null; onPick(null); draw(); }));
    if (value && !all.some((g) => g.id === value)) list.append(item(true, icon('users', 'sm'), 'Current group', value, () => {}));
    for (const g of items) list.append(item(g.id === value, icon('users', 'sm'), g.name, null, () => { value = g.id; onPick(g.id); draw(); }));
    if (!all.length) list.append(h('p', { class: 'small muted card-pad' }, groupState.error ? 'Could not load groups.' : 'No groups found.'));
    status.textContent = groupState.error ? `${groupState.error}. Is WhatsApp connected?` : `${all.length} groups · the WhatsApp number must be a member`;
    // the manual field shows when the list failed or is empty, or when asked for
    const showManual = manual || !all.length || !!groupState.error; // a failed refresh shows it even if a stale list is cached
    manualLink.hidden = showManual;
    ctx.clear(manualBox);
    if (showManual) {
      const err = h('p', { class: 'error-text', role: 'alert', hidden: true });
      const input = h('input', { class: 'input', id: 'manual-id', type: 'text', placeholder: '120363012345678901@g.us', autocomplete: 'off', 'aria-label': 'WhatsApp group ID' });
      const use = () => {
        const id = input.value.trim();
        if (!GROUP_ID.test(id)) { err.textContent = 'Enter an ID like 120363012345678901@g.us'; err.hidden = false; return; }
        value = id; onPick(id); manual = false; draw();
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); use(); } });
      manualBox.append(h('div', { class: 'input-row' }, input, h('button', { type: 'button', class: 'btn tonal', id: 'manual-id-use', onclick: use }, 'Use')), err);
    }
  };
  const search = h('label', { class: 'search' }, icon('search', 'sm'),
    h('input', { type: 'search', placeholder: 'Search groups', 'aria-label': 'Search groups', oninput: (ev) => { query = ev.target.value; draw(); } }));
  const refresh = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Refresh groups', title: 'Refresh groups', onclick: async () => {
    refresh.disabled = true;
    try { await loadGroups(ctx, true); } catch { ctx.toast('You are offline.', { kind: 'error' }); }
    refresh.disabled = false;
    draw();
  } }, icon('refresh-cw'));
  search.append(refresh);
  box.append(search, list, status, manualLink, manualBox);
  if (groupState.list === null) loadGroups(ctx, false).then(draw).catch(() => draw());
  draw();
  return box;
}

const targetLabel = (p, defaultGroupId) => {
  if (p.notifyTarget === 'dm') return 'Direct message';
  if (p.notifyTarget === 'group') return groupName(p.notifyGroupId) || 'A WhatsApp group';
  return defaultGroupId ? `Team group${groupName(defaultGroupId) ? ` · ${groupName(defaultGroupId)}` : ''}` : 'Team group (not set)';
};

// ---------- test notifications ----------

/**
 * "Test a nudge": shows the exact WhatsApp message a person would get right now (from the server, built by the real
 * nudge formatter), where it goes, and sends it as a [TEST]. `personId` null = yourself.
 */
export function nudgePreviewBlock(ctx, { personId, label }) {
  const { h, icon, api, toast } = ctx;
  const box = h('div', { class: 'stack', 'data-preview': '' });
  const q = personId ? `?person=${personId}` : '';
  const start = () => fill(box, h('button', { type: 'button', class: 'btn tonal', id: 'preview-btn', onclick: load }, icon('flask-conical'), label || 'Preview message'));
  async function load() {
    fill(box, h('p', { class: 'muted' }, 'Building the preview…'));
    let r;
    try { r = await api('GET', '/api/app/nudge-preview' + q); } catch (e) {
      fill(box, h('div', { class: 'callout danger', role: 'alert' }, icon('alert-triangle'), h('span', {}, errText(e))), h('button', { type: 'button', class: 'btn text', onclick: load }, icon('refresh-cw'), 'Try again'));
      return;
    }
    if (!r.ready) {
      const why = r.reason === 'no_target'
        ? `Nudges can't be delivered yet: ${r.detail}. ${personId ? 'Set a WhatsApp number and where nudges go in People.' : 'Ask an admin to set your WhatsApp number and where your nudges go.'}`
        : `${personId ? `${r.person.name} has` : 'You have'} no open tasks with a due date yet. Add one with a due time to see a preview.`;
      fill(box, h('div', { class: 'callout warn' }, icon('info'), h('span', {}, why)), h('button', { type: 'button', class: 'btn text', onclick: load }, icon('refresh-cw'), 'Check again'));
      return;
    }
    const to = r.target.type === 'dm' ? 'Direct message' : (groupName(r.target.chatId) || 'WhatsApp group');
    const send = h('button', { type: 'button', class: 'btn', id: 'preview-send' }, icon('send'), 'Send test now');
    send.addEventListener('click', async () => {
      send.disabled = true;
      try {
        const res = await api('POST', '/api/app/nudge-preview/send', personId ? { personId } : {});
        toast(`Test sent to ${res.target.type === 'dm' ? 'WhatsApp (direct message)' : to}`);
      } catch (e) {
        toast(e.status === 429 ? 'Wait a few seconds before sending another test.' : errText(e), { kind: 'error' });
      }
      send.disabled = false;
    });
    fill(box,
      r.mode === 'upcoming' && h('p', { class: 'small muted' }, 'Nothing is due right now, so this shows upcoming tasks in the real format.'),
      h('div', { class: 'wa-chat' },
        h('div', { class: 'wa-to' }, icon(r.target.type === 'dm' ? 'user' : 'users', 'xs'), `To: ${to}`),
        h('div', { class: 'wa-bubble' }, h('span', {}, `🧪 [TEST]\n\n${r.message}`), h('span', { class: 'wa-time' }, fmtTime(Date.now())))),
      h('p', { class: 'small muted' }, 'Sent marked [TEST]. Real nudge timing does not change. One test per person every 30 seconds.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn text', onclick: load }, icon('refresh-cw'), 'Refresh'), h('span', { class: 'spacer' }), send));
  }
  start();
  return box;
}

// ---------- People ----------

async function renderPeople(ctx) {
  const { h, clear, icon, api, S, body } = ctx;
  const [people, settings] = await Promise.all([api('GET', '/api/people'), api('GET', '/api/task-settings')]);
  await loadGroups(ctx, false);
  let query = '';
  const list = h('div', { class: 'card people-list', id: 'people-list' });
  const count = h('span', { class: 'small muted' });
  const draw = () => {
    clear(list);
    const q = query.trim().toLowerCase();
    const rows = people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
    count.textContent = `${rows.length} of ${people.length}`;
    if (!rows.length) list.append(h('div', { class: 'empty' }, h('div', { class: 'icon-wrap' }, icon('users', 'xl')), h('p', {}, people.length ? 'No one matches that search.' : 'No people yet. Add the first one.')));
    for (const p of rows) list.append(personRow(p));
  };
  const reload = async () => { people.splice(0, people.length, ...(await api('GET', '/api/people'))); draw(); };
  const isSuper = S.me.role === 'superadmin';
  const personRow = (p) => {
    const locked = p.isSuperadmin && !isSuper;
    const head = [p.name,
      p.isSuperadmin ? h('span', { class: 'pill owner' }, isSuper ? 'Owner (you)' : 'Owner') : p.role === 'admin' && h('span', { class: 'pill admin' }, 'Admin'),
      !p.active && h('span', { class: 'pill error' }, 'Inactive')];
    const sub = [h('span', {}, p.email + (p.whatsapp ? ` · +${p.whatsapp}` : '')),
      h('span', { class: 'meta' }, icon('send', 'xs'), targetLabel(p, settings.defaultGroupId))];
    return ctx.listItem({
      lead: h('span', { class: 'avatar' }, initials(p.name)), head, sub: h('span', { class: 'stack-tight' }, sub),
      trail: locked ? icon('lock', 'sm') : icon('chevron-right', 'sm'), cls: 'person-row' + (p.active ? '' : ' inactive'),
      label: locked ? `${p.name}, locked: only the owner can edit this row` : `Edit ${p.name}`,
      ...(locked ? {} : { onclick: () => personSheet(ctx, p, settings, reload) }), attrs: { 'data-id': p.id },
    });
  };
  fill(body, 
    h('div', { class: 'toolbar' },
      h('label', { class: 'search' }, icon('search', 'sm'), h('input', { type: 'search', id: 'people-search', placeholder: 'Search people', 'aria-label': 'Search people', oninput: (ev) => { query = ev.target.value; draw(); } })),
      h('button', { type: 'button', class: 'btn', id: 'add-person', onclick: () => personSheet(ctx, null, settings, reload) }, icon('user-plus'), 'Add')),
    !settings.defaultGroupId && h('div', { class: 'callout warn' }, icon('alert-triangle'), h('span', {}, 'No team group is set, so people on "Team group" get no nudges. Set it in Notifications.'), h('a', { class: 'btn text', href: '#/admin/notifications' }, 'Set')),
    h('div', { class: 'row' }, h('span', { class: 'block-label' }, icon('users', 'sm'), 'People'), h('span', { class: 'spacer' }), count),
    list);
  draw();
}

function personSheet(ctx, person, settings, onDone) {
  const { h, icon, api, S, toast } = ctx;
  const actorSuper = S.me.role === 'superadmin';
  const ownerRow = !!person && person.isSuperadmin;
  const st = {
    name: person ? person.name : '', email: person ? person.email : '', whatsapp: person ? person.whatsapp || '' : '',
    role: person ? person.role : 'member', target: person ? person.notifyTarget : 'default', groupId: person ? person.notifyGroupId || '' : '',
    errors: {}, busy: false,
  };
  const content = h('div', {});
  const close = ctx.openSheet(content, { label: person ? `Edit ${person.name}` : 'Add person', keepOpen: true }); // a backdrop tap must not discard the form
  const adminRow = !!person && person.role === 'admin' && !actorSuper;

  // the deactivate/reactivate confirmation happens inside this same sheet, so Cancel returns to the form with its state intact
  const confirmToggle = (activate) => {
    fill(content,
      ...ctx.sheetHead(`${activate ? 'Reactivate' : 'Deactivate'} ${person.name}?`, activate ? 'They can sign in and get nudges again.' : 'They are signed out, stop getting nudges and can no longer sign in. Their tasks are kept.'),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn text', id: 'confirm-cancel', onclick: draw }, 'Cancel'),
        h('button', { type: 'button', class: 'btn' + (activate ? '' : ' danger'), id: 'confirm-toggle', onclick: async () => {
          try {
            if (activate) {
              await api('PUT', `/api/people/${person.id}`, { email: person.email, name: person.name, whatsapp: person.whatsapp, role: person.role, active: true, notifyTarget: person.notifyTarget, notifyGroupId: person.notifyGroupId });
            } else await api('DELETE', `/api/people/${person.id}`);
            close(); toast(activate ? 'Reactivated' : 'Deactivated'); await onDone();
          } catch (e) { toast(errText(e), { kind: 'error' }); draw(); }
        } }, activate ? 'Reactivate' : 'Deactivate')));
    const cancel = content.querySelector('#confirm-cancel');
    if (cancel) cancel.focus();
  };

  const testNudge = async (btn) => {
    btn.disabled = true;
    try {
      const r = await api('POST', `/api/people/${person.id}/test-nudge`, {});
      toast(r.target.type === 'dm' ? `Setup test sent to ${person.name} (direct message)` : `Setup test sent to ${groupName(r.target.chatId) || 'the group'}`);
    } catch (e) { toast(e.status === 429 ? 'Wait a few seconds before sending another test.' : errText(e), { kind: 'error' }); }
    btn.disabled = false;
  };
  const previewSheet = () => {
    const c = h('div', {});
    ctx.openSheet(c, { label: `Test ${person.name}'s nudge` });
    c.append(...ctx.sheetHead(`Test ${person.name}’s nudge`, 'The exact message they would get right now'),
      h('div', { class: 'sheet-body' }, nudgePreviewBlock(ctx, { personId: person.id, label: 'Preview message' })));
  };

  const draw = () => {
    const err = st.errors;
    const name = h('input', { id: 'p-name', class: 'input', type: 'text', maxlength: '100', autocomplete: 'off', oninput: (ev) => { st.name = ev.target.value; } });
    name.value = st.name;
    const email = h('input', { id: 'p-email', class: 'input', type: 'email', autocomplete: 'off', disabled: ownerRow || adminRow, oninput: (ev) => { st.email = ev.target.value; } });
    email.value = st.email;
    const wa = h('input', { id: 'p-wa', class: 'input', type: 'tel', inputmode: 'tel', placeholder: '919812345678', oninput: (ev) => { st.whatsapp = ev.target.value; } });
    wa.value = st.whatsapp;
    const role = h('div', { class: 'seg', id: 'p-role', role: 'radiogroup', 'aria-label': 'Role' },
      [['member', 'Member', 'user'], ['admin', 'Admin', 'shield']].map(([v, l, ic]) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(st.role === v), 'data-v': v,
        disabled: ownerRow || adminRow || (v === 'admin' && !actorSuper && st.role !== 'admin'),
        onclick: () => { st.role = v; draw(); },
      }, icon(ic, 'xs'), l)));
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Where nudges go' },
      [['default', 'Team group', 'users'], ['group', 'Other group', 'message-circle'], ['dm', 'Direct', 'user']].map(([v, l, ic]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(st.target === v), 'data-v': v, onclick: () => { st.target = v; draw(); } }, icon(ic, 'xs'), l)));
    fill(content,
      ...ctx.sheetHead(person ? (ownerRow ? 'Your details' : person.name) : 'Add person',
        ownerRow ? 'Name, WhatsApp and where your nudges go can change. Email and role are fixed.' : person ? person.email : 'They sign in with a code sent to their email.'),
      h('div', { class: 'sheet-body' },
        field(ctx, 'Name', name, { error: err.name, id: 'p-name' }),
        field(ctx, 'Email', email, { error: err.email, id: 'p-email', help: adminRow ? "Only the owner can change an admin's email." : null }),
        field(ctx, 'WhatsApp number', wa, { error: err.whatsapp, id: 'p-wa', help: 'With country code, e.g. 919812345678. Needed to be tagged in a group or to get a direct message.' }),
        field(ctx, 'Role', role, { error: err.role, help: actorSuper ? 'Admins can manage people, access and settings.' : 'Only the owner can make someone an admin.' }),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Nudges go to'), seg,
          st.target === 'default' && h('p', { class: 'small muted' }, settings.defaultGroupId ? `The team group${groupName(settings.defaultGroupId) ? ` (${groupName(settings.defaultGroupId)})` : ''}, tagging them.` : 'No team group is set yet (Admin → Notifications).'),
          st.target === 'dm' && h('p', { class: 'small muted' }, 'A direct WhatsApp message to their number.'),
          st.target === 'group' && groupPicker(ctx, { value: st.groupId || null, onPick: (id) => { st.groupId = id || ''; } }),
          err.notifyGroupId && h('p', { class: 'error-text', role: 'alert' }, err.notifyGroupId)),
        err._form && h('div', { class: 'callout danger', role: 'alert' }, icon('alert-triangle'), h('span', {}, err._form))),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn text', onclick: close }, 'Cancel'),
        h('button', { type: 'button', class: 'btn', id: 'save-person', disabled: st.busy, onclick: save }, person ? 'Save' : 'Add person')),
      person && h('div', { class: 'list' },
        h('div', { class: 'sheet-divider' }),
        person.active && ctx.listItem({ lead: icon('flask-conical'), head: 'Test their nudge', sub: 'Preview the real message and send it as a test', onclick: previewSheet }),
        person.active && h('button', { type: 'button', class: 'list-item two clickable', id: 'test-nudge', onclick: (ev) => testNudge(ev.currentTarget) },
          h('span', { class: 'li-lead' }, icon('send')), h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, 'Send setup test'), h('span', { class: 'li-sub' }, 'A one-line message to check where nudges arrive'))),
        !ownerRow && (person.active
          ? h('button', { type: 'button', class: 'list-item clickable danger', id: 'deactivate', disabled: adminRow, onclick: () => confirmToggle(false) },
            h('span', { class: 'li-lead' }, icon('x')), h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, adminRow ? 'Deactivate (only the owner can for admins)' : 'Deactivate')))
          : h('button', { type: 'button', class: 'list-item clickable', id: 'reactivate', disabled: adminRow, onclick: () => confirmToggle(true) },
            h('span', { class: 'li-lead' }, icon('rotate-ccw')), h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, adminRow ? 'Reactivate (only the owner can for admins)' : 'Reactivate'))))));
  };

  async function save() {
    st.busy = true; st.errors = {};
    const payload = { name: st.name, email: st.email, whatsapp: st.whatsapp.trim() === '' ? null : st.whatsapp, notifyTarget: st.target };
    if (st.target === 'group') payload.notifyGroupId = st.groupId || null;
    if (!ownerRow && !adminRow) payload.role = st.role;
    try {
      if (person) await api('PUT', `/api/people/${person.id}`, payload);
      else await api('POST', '/api/people', payload);
      close(); toast(person ? 'Saved' : 'Person added'); await onDone();
    } catch (e) {
      if (e.network) st.errors = { _form: errText(e) };
      else st.errors = { ...((e.body && e.body.fields) || {}), ...(e.body && e.body.fields ? {} : { _form: e.message }) };
      st.busy = false; draw();
      const first = content.querySelector('.error-text, .callout.danger');
      if (first) first.scrollIntoView({ block: 'nearest' });
    }
  }
  draw();
}

// ---------- Access ----------

async function renderAccess(ctx) {
  const { h, clear, icon, api, S, body } = ctx;
  let [people, grants] = await Promise.all([api('GET', '/api/people'), api('GET', '/api/access-grants')]);
  const active = people.filter((p) => p.active);
  const isSuper = S.me.role === 'superadmin';
  let selected = active.find((p) => p.id === S.me.personId) || active[0];
  let addPick = null;
  const view = h('div', { class: 'stack' });
  const reload = async () => { grants = await api('GET', '/api/access-grants'); draw(); };
  const act = async (fn, okText) => {
    try { await fn(); if (okText) ctx.toast(okText); await reload(); }
    catch (e) { ctx.toast(errText(e), { kind: 'error' }); await reload().catch(() => {}); }
  };
  const levelSeg = (level, onChange, disabled) => h('div', { class: 'seg mini', role: 'radiogroup', 'aria-label': 'Access level' },
    [['view', 'View', 'eye'], ['edit', 'Edit', 'pencil']].map(([v, l, ic]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(level === v), disabled, onclick: () => { if (level !== v) onChange(v); } }, icon(ic, 'xs'), l)));

  function draw() {
    if (!selected) { clear(view).append(h('p', { class: 'muted' }, 'No people yet.')); return; }
    const lockedList = selected.isSuperadmin && !isSuper; // only the owner manages access to the owner's list
    const seeMine = grants.filter((g) => g.ownerPersonId === selected.id);
    const iSee = grants.filter((g) => g.granteePersonId === selected.id);
    const already = new Set(seeMine.map((g) => g.granteePersonId));
    const candidates = active.filter((p) => p.id !== selected.id && !already.has(p.id));
    let addWho = candidates.some((p) => p.id === addPick) ? addPick : candidates[0] ? candidates[0].id : null;
    let addLevel = 'view';
    const picker = pickerField(ctx, { id: 'access-person', label: 'Whose list', title: 'Whose list?', value: selected.id,
      options: active.map((p) => personOption(ctx, p, S.me.personId)), onChange: (v) => { selected = active.find((p) => p.id === v); draw(); } });
    const addSel = pickerField(ctx, { id: 'access-add-person', label: 'Person', title: 'Give access to', value: addWho, disabled: lockedList || !candidates.length,
      options: candidates.map((p) => personOption(ctx, p, S.me.personId)), onChange: (v) => { addWho = v; addPick = v; draw(); } });
    const addSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'New access level' },
      [['view', 'Can view', 'eye'], ['edit', 'Can edit', 'pencil']].map(([v, l, ic]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(addLevel === v), disabled: lockedList, onclick: (ev) => {
        addLevel = v;
        for (const b of ev.currentTarget.parentNode.children) b.setAttribute('aria-checked', String(b === ev.currentTarget));
      } }, icon(ic, 'xs'), l)));
    const person = (name) => h('span', { class: 'avatar sm' }, initials(name));
    fill(view,
      field(ctx, 'Whose list', picker, { id: 'access-person' }),
      h('div', { class: 'callout info' }, icon('info'), h('span', {}, 'Everyone sees their own list and admins see every list. Grant access here so a member can view or edit someone else’s list.')),
      lockedList && h('div', { class: 'callout danger' }, icon('lock'), h('span', {}, 'Only the owner can change access to the owner’s list.')),
      h('div', {}, cardTitle(ctx, 'users', `Who can see ${selected.name}’s list`),
        h('div', { class: 'card', id: 'access-see-mine' },
          selected.role === 'admin' && h('p', { class: 'small muted card-pad' }, 'As an admin, this person already sees every list.'),
          seeMine.length ? seeMine.map((g) => h('div', { class: 'list-item', 'data-grantee': g.granteePersonId },
            h('span', { class: 'li-lead' }, person(g.granteeName)), h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, g.granteeName)),
            h('span', { class: 'li-trail' }, levelSeg(g.level, (lv) => act(() => api('POST', '/api/access-grants', { granteePersonId: g.granteePersonId, ownerPersonId: g.ownerPersonId, level: lv }), 'Access changed'), lockedList),
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${g.granteeName}'s access`, disabled: lockedList, onclick: () => act(() => api('DELETE', `/api/access-grants/${g.id}`), 'Access removed') }, icon('trash-2', 'sm')))))
            : h('p', { class: 'muted card-pad' }, 'No one else can see this list yet.'))),
      h('div', {}, cardTitle(ctx, 'user-plus', 'Give access'),
        h('div', { class: 'card card-pad stack' },
          candidates.length ? [field(ctx, 'Person', addSel, { id: 'access-add-person' }), addSeg,
            h('button', { type: 'button', class: 'btn', id: 'add-access', disabled: lockedList, onclick: () => addWho && act(() => api('POST', '/api/access-grants', { granteePersonId: addWho, ownerPersonId: selected.id, level: addLevel }), 'Access added') }, icon('plus'), 'Give access')]
            : h('p', { class: 'muted' }, 'Everyone already has access.'))),
      h('div', {}, cardTitle(ctx, 'eye', `Lists ${selected.name} can see`),
        h('div', { class: 'card', id: 'access-iSee' },
          selected.role === 'admin' && h('p', { class: 'small muted card-pad' }, 'Admins see all lists.'),
          iSee.length ? iSee.map((g) => {
            const locked = g.ownerPersonId && (people.find((p) => p.id === g.ownerPersonId) || {}).isSuperadmin && !isSuper;
            return h('div', { class: 'list-item' }, h('span', { class: 'li-lead' }, person(g.ownerName)), h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, g.ownerName)),
              h('span', { class: 'li-trail' }, h('span', { class: 'pill' }, g.level === 'edit' ? 'Can edit' : 'Can view'),
                h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove access to ${g.ownerName}'s list`, disabled: !!locked, onclick: () => act(() => api('DELETE', `/api/access-grants/${g.id}`), 'Access removed') }, icon('trash-2', 'sm'))));
          }) : h('p', { class: 'muted card-pad' }, 'No lists beyond their own.'))));
  }
  fill(body, view);
  draw();
}

// ---------- Notifications ----------

const hhmm12 = (v) => {
  const [hh, mm] = v.split(':').map(Number);
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
};

/** The plain-English summary of the settings (shown live while editing). */
export function previewText(s) {
  const lead = Number(s.leadMinutes), rep = Number(s.repeatMinutes), merge = Number(s.mergeAheadMinutes);
  let text = `First nudge ${lead} min before the due time, then every ${rep} min until done.`;
  text += merge > 0 ? ` Tasks due within ${merge} min are grouped.` : ' Tasks are never grouped ahead of time.';
  if (s.quietHours.enabled && /^\d\d:\d\d$/.test(s.quietHours.start) && /^\d\d:\d\d$/.test(s.quietHours.end)) {
    text += ` Quiet hours: no nudges from ${hhmm12(s.quietHours.start)} to ${hhmm12(s.quietHours.end)} IST.`;
  }
  return text;
}

const STEPS = {
  leadMinutes: [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440],
  repeatMinutes: [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1440],
  mergeAheadMinutes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
};
const mins = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`);

async function renderNotifications(ctx) {
  const { h, clear, icon, api, body } = ctx;
  const [cur, people] = await Promise.all([api('GET', '/api/task-settings'), api('GET', '/api/people')]);
  await loadGroups(ctx, false);
  let saved = JSON.stringify(cur);
  const st = { ...cur, quietHours: { ...cur.quietHours } };
  let errors = {};
  let testPerson = (people.find((p) => p.active && p.id === ctx.S.me.personId) || people.find((p) => p.active) || {}).id;
  const preview = h('span', { id: 'settings-preview', 'aria-live': 'polite' });
  const dirtyText = h('span', { class: 'spacer small' });
  const saveBtn = h('button', { type: 'button', class: 'btn', id: 'save-settings' }, icon('check'), 'Save');
  const resetBtn = h('button', { type: 'button', class: 'btn text', onclick: () => { Object.assign(st, JSON.parse(saved)); errors = {}; draw(); } }, 'Discard');
  const upd = () => {
    preview.textContent = previewText(st);
    const dirty = JSON.stringify(st) !== saved;
    saveBtn.disabled = !dirty;
    resetBtn.hidden = !dirty;
    dirtyText.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
  };
  const stepper = (key, label, sub, ic) => {
    const list = STEPS[key].includes(st[key]) ? STEPS[key] : [...STEPS[key], st[key]].sort((a, b) => a - b);
    const out = h('output', { id: 's-' + key, 'aria-live': 'polite' }, mins(st[key]));
    const move = (d) => {
      const i = list.indexOf(st[key]);
      const n = list[Math.min(list.length - 1, Math.max(0, i + d))];
      if (n === undefined || n === st[key]) return;
      st[key] = n; out.textContent = mins(n); minus.disabled = n === list[0]; plus.disabled = n === list[list.length - 1]; upd();
    };
    const minus = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Decrease ${label}`, disabled: st[key] === list[0], onclick: () => move(-1) }, icon('minus', 'sm'));
    const plus = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Increase ${label}`, disabled: st[key] === list[list.length - 1], onclick: () => move(1) }, icon('plus', 'sm'));
    return h('div', { class: 'setting' }, h('span', { class: 'icon-chip' }, icon(ic, 'sm')),
      h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, label), h('span', { class: 'li-sub' }, sub), errors[key] && h('span', { class: 'error-text' }, errors[key])),
      h('span', { class: 'stepper' }, minus, out, plus));
  };
  const groupSheet = () => {
    const c = h('div', {});
    const close = ctx.openSheet(c, { label: 'Team group', keepOpen: true });
    c.append(...ctx.sheetHead('Team group', 'Nudges for people on "Team group" go here, tagging them'),
      h('div', { class: 'sheet-body' }, groupPicker(ctx, { value: st.defaultGroupId, allowNone: true, onPick: (id) => { st.defaultGroupId = id; } })),
      h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => { close(); draw(); } }, 'Done')));
  };
  const draw = () => {
    const qh = st.quietHours;
    const toggle = h('input', { id: 'q-enabled', class: 'switch', type: 'checkbox', role: 'switch', 'aria-label': 'Quiet hours', onchange: (ev) => { qh.enabled = ev.target.checked; draw(); } });
    toggle.checked = qh.enabled;
    const time = (key, label, ic) => {
      const input = h('input', { id: 'q-' + key, class: 'input time-input', type: 'time', 'aria-label': `${label} (IST)`, oninput: (ev) => { qh[key] = ev.target.value; upd(); } });
      input.value = qh[key];
      return h('label', { class: 'setting time-row', for: 'q-' + key }, h('span', { class: 'icon-chip' }, icon(ic, 'sm')), h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, label)), input);
    };
    const gName = st.defaultGroupId ? (groupName(st.defaultGroupId) || st.defaultGroupId) : null;
    const testBox = h('div', { class: 'stack' });
    const drawTest = () => fill(testBox,
      field(ctx, 'Person', pickerField(ctx, { id: 'test-person', label: 'Person', title: 'Test whose nudge?', value: testPerson,
        options: people.filter((p) => p.active).map((p) => personOption(ctx, p, ctx.S.me.personId)), onChange: (v) => { testPerson = v; drawTest(); } }), { id: 'test-person' }),
      testPerson ? nudgePreviewBlock(ctx, { personId: testPerson, label: 'Preview their nudge' }) : h('p', { class: 'muted' }, 'Add a person first.'));
    fill(body, 
      h('div', { class: 'callout info' }, icon('bell-ring'), preview),
      h('div', {}, cardTitle(ctx, 'send', 'Delivery'),
        h('div', { class: 'card' },
          h('button', { type: 'button', class: 'setting list-item clickable', id: 'default-group', onclick: groupSheet },
            h('span', { class: 'icon-chip' }, icon('users', 'sm')),
            h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, 'Team group'),
              h('span', { class: 'li-sub' }, gName || 'Not set: people on "Team group" get no nudges'), errors.defaultGroupId && h('span', { class: 'error-text' }, errors.defaultGroupId)),
            gName ? icon('chevron-right', 'sm') : h('span', { class: 'pill warn' }, 'Set up')))),
      h('div', {}, cardTitle(ctx, 'timer', 'Timing'),
        h('div', { class: 'card' },
          stepper('leadMinutes', 'First nudge', 'Before the due time', 'bell'),
          stepper('repeatMinutes', 'Then repeat every', 'Until the task is done or snoozed', 'refresh-cw'),
          stepper('mergeAheadMinutes', 'Group tasks due within', 'Added to a nudge that goes out anyway', 'layers'))),
      h('div', {}, cardTitle(ctx, 'moon', 'Quiet hours'),
        h('div', { class: 'card' },
          h('label', { class: 'setting', for: 'q-enabled' }, h('span', { class: 'icon-chip' }, icon('moon', 'sm')),
            h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, 'Pause nudges at night'), h('span', { class: 'li-sub' }, qh.enabled ? `${hhmm12(qh.start)} to ${hhmm12(qh.end)} IST, they resume after` : 'Off: nudges continue around the clock')),
            toggle),
          qh.enabled && time('start', 'Starts (IST)', 'moon'),
          qh.enabled && time('end', 'Ends (IST)', 'sunrise'),
          errors.quietHours && h('p', { class: 'error-text card-pad' }, errors.quietHours))),
      h('div', {}, cardTitle(ctx, 'flask-conical', 'Test a nudge'),
        h('div', { class: 'card card-pad stack' },
          h('p', { class: 'muted' }, 'See the exact WhatsApp message a person would get right now, then send it as a test.'),
          testBox)),
      errors._form && h('div', { class: 'callout danger', role: 'alert' }, icon('alert-triangle'), h('span', {}, errors._form)),
      h('div', { class: 'save-bar' }, dirtyText, resetBtn, saveBtn));
    drawTest();
    upd();
  };
  saveBtn.addEventListener('click', async () => {
    errors = {};
    saveBtn.disabled = true;
    try {
      const next = await api('PUT', '/api/task-settings', st);
      Object.assign(st, next, { quietHours: { ...next.quietHours } });
      saved = JSON.stringify(st);
      ctx.toast('Settings saved');
    } catch (e) {
      errors = e.network ? { _form: errText(e) } : { ...((e.body && e.body.fields) || {}), ...(e.body && e.body.fields ? {} : { _form: e.message }) };
    }
    draw();
  });
  draw();
}

// ---------- Audit ----------

const AUDIT = {
  person_create: ['user-plus', 'Added a person'], person_update: ['pencil', 'Edited a person'], person_deactivate: ['x', 'Deactivated a person'],
  person_self_create: ['user', 'Created own task list'], person_self_repair: ['refresh-cw', 'Repaired own task list'],
  person_test_nudge: ['send', 'Sent a setup test'], person_test_digest: ['flask-conical', 'Sent a test nudge'],
  access_grant_set: ['eye', 'Set access to a list'], access_grant_remove: ['trash-2', 'Removed access to a list'],
  task_settings_update: ['bell-ring', 'Changed notification settings'],
};

async function renderAudit(ctx) {
  const { h, clear, icon, api, body } = ctx;
  const rows = await api('GET', '/api/nudge/audit');
  const now = Date.now();
  if (!rows.length) { fill(body, h('div', { class: 'empty' }, h('div', { class: 'icon-wrap' }, icon('history', 'xl')), h('h2', {}, 'Nothing here yet'), h('p', {}, 'Changes to people, access and settings will show up here.'))); return; }
  const detail = (d) => (d && typeof d === 'object' ? Object.entries(d).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]) : []);
  fill(body, h('div', { class: 'card', id: 'audit-list' }, rows.map((r) => {
    const [ic, label] = AUDIT[r.action] || ['info', r.action];
    const ms = Date.parse(r.at);
    const box = h('dl', { class: 'audit-details' }, detail(r.details).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
    const pad = h('div', { class: 'card-pad audit-pad', hidden: true }, box);
    const chev = h('span', {}, icon('chevron-down', 'sm'));
    const btn = h('button', { type: 'button', class: 'list-item two clickable', 'aria-expanded': 'false', onclick: () => {
      pad.hidden = !pad.hidden;
      btn.setAttribute('aria-expanded', String(!pad.hidden));
      fill(chev, icon(pad.hidden ? 'chevron-down' : 'chevron-up', 'sm'));
    } },
    h('span', { class: 'icon-chip' }, icon(ic, 'sm')),
    h('span', { class: 'li-body' }, h('span', { class: 'li-head' }, label), h('span', { class: 'li-sub' }, `${r.actor} · ${fmtRelative(ms, now)} · ${fmtDateTime(ms, now)}`)),
    h('span', { class: 'li-trail' }, chev));
    return h('div', { class: 'audit-row' }, btn, pad);
  })));
}
