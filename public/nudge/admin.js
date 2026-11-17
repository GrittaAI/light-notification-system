// Nudge admin area (admin and superadmin only): People, Access, Notifications, Audit.
// Works online only: nothing here is queued in the outbox. The server enforces every rule; the UI only hides or
// disables what the server would refuse. All text is inserted with textContent / text nodes. Times are IST.
import { fmtDateTime, fmtRelative } from './sync-core.js';

export const ADMIN_TABS = [['people', 'People'], ['access', 'Access'], ['notifications', 'Notifications'], ['audit', 'Audit']];

const initials = (name) => (String(name).trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('') || '?').toUpperCase();
const groupState = { list: null, error: null };
/** Clears `node` and fills it with `kids`, skipping false/null (so `cond && element` is safe). */
function fill(node, ...kids) {
  while (node.firstChild) node.removeChild(node.firstChild);
  node.append(...kids.flat().filter((k) => k !== false && k !== null && k !== undefined));
  return node;
}

/** ctx: { h, clear, icon, api, toast, openSheet, S } from app.js. */
export function renderAdminPage(ctx, mount, tab) {
  const { h, clear, icon, S } = ctx;
  const t = ADMIN_TABS.some(([k]) => k === tab) ? tab : 'people';
  const body = h('div', { class: 'admin-body' });
  clear(mount).append(
    h('div', { class: 'page-top' }, h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Back to my tasks' }, icon('chevron-left', 'lg')), h('h2', {}, 'Admin')),
    h('nav', { class: 'seg admin-tabs', 'aria-label': 'Admin sections' },
      ADMIN_TABS.map(([k, label]) => h('a', { href: '#/admin/' + k, 'aria-current': k === t ? 'page' : false }, label))),
    body);
  const run = { people: renderPeople, access: renderAccess, notifications: renderNotifications, audit: renderAudit }[t];
  // The admin area needs a connection: offline (or a network failure) shows the message instead of a form.
  const offline = () => {
    clear(body).append(h('div', { class: 'empty', id: 'admin-offline' }, icon('alert-triangle', 'xl'), h('h2', {}, 'Admin needs a connection'),
      h('p', {}, 'People, access and notification settings can only be changed online. Your tasks still work offline.'),
      h('button', { type: 'button', class: 'btn', onclick: () => renderAdminPage(ctx, mount, t) }, 'Try again')));
  };
  if (!navigator.onLine || !S.online) { offline(); return; }
  clear(body).append(h('div', { 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
  run({ ...ctx, offline, body }).catch((e) => {
    if (e.network) offline();
    else clear(body).append(h('div', { class: 'callout danger', role: 'alert' }, e.status === 403 ? 'Admins only.' : e.message));
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
  const box = h('div', { class: 'picker' });
  const list = h('div', { class: 'picker-list', role: 'radiogroup', 'aria-label': 'WhatsApp group' });
  const status = h('p', { class: 'small muted' });
  const manualBox = h('div', { class: 'manual-id' });
  const manualLink = h('button', { type: 'button', class: 'link-btn small', id: 'manual-id-link', onclick: () => { manual = true; draw(); const i = box.querySelector('#manual-id'); if (i) i.focus(); } }, 'Enter ID manually');
  const draw = () => {
    ctx.clear(list);
    const q = query.trim().toLowerCase();
    const all = groupState.list || [];
    const items = all.filter((g) => !q || g.name.toLowerCase().includes(q));
    if (allowNone) {
      list.append(h('button', { type: 'button', class: 'picker-item', role: 'radio', 'aria-checked': String(!value), onclick: () => { value = null; onPick(null); draw(); } }, 'No default group'));
    }
    if (value && !all.some((g) => g.id === value)) {
      list.append(h('button', { type: 'button', class: 'picker-item', role: 'radio', 'aria-checked': 'true' }, h('span', {}, 'Current group'), h('span', { class: 'small muted' }, value)));
    }
    for (const g of items) {
      list.append(h('button', { type: 'button', class: 'picker-item', role: 'radio', 'aria-checked': String(g.id === value), onclick: () => { value = g.id; onPick(g.id); draw(); } },
        h('span', {}, g.name), g.id === value && icon('check', 'sm')));
    }
    if (!all.length) list.append(h('p', { class: 'small muted' }, groupState.error ? 'Could not load groups.' : 'No groups found.'));
    status.textContent = groupState.error ? `${groupState.error}. Is WhatsApp connected?` : `${all.length} groups`;
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
      manualBox.append(h('div', { class: 'qa-pick' }, input, h('button', { type: 'button', class: 'btn secondary', id: 'manual-id-use', onclick: use }, 'Use')), err);
    }
  };
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search groups…', 'aria-label': 'Search groups', oninput: (ev) => { query = ev.target.value; draw(); } });
  const refresh = h('button', { type: 'button', class: 'btn secondary', 'aria-label': 'Refresh groups', onclick: async () => {
    refresh.disabled = true;
    try { await loadGroups(ctx, true); } catch { ctx.toast('You are offline.', { kind: 'error' }); }
    refresh.disabled = false;
    draw();
  } }, icon('refresh-cw', 'sm'), 'Refresh');
  box.append(h('div', { class: 'qa-pick' }, search, refresh), list, status, manualLink, manualBox);
  if (groupState.list === null) loadGroups(ctx, false).then(draw).catch(() => draw());
  draw();
  return box;
}

const targetLabel = (p, defaultGroupId) => {
  if (p.notifyTarget === 'dm') return 'Direct message';
  if (p.notifyTarget === 'group') return groupName(p.notifyGroupId) || 'A WhatsApp group';
  return defaultGroupId ? `Default group${groupName(defaultGroupId) ? ` (${groupName(defaultGroupId)})` : ''}` : 'Default group (not set)';
};

// ---------- People ----------

async function renderPeople(ctx) {
  const { h, clear, icon, api, S, body } = ctx;
  const [people, settings] = await Promise.all([api('GET', '/api/people'), api('GET', '/api/task-settings')]);
  await loadGroups(ctx, false);
  let query = '';
  const list = h('ul', { class: 'task-list people-list' });
  const draw = () => {
    clear(list);
    const q = query.trim().toLowerCase();
    const rows = people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
    if (!rows.length) list.append(h('li', { class: 'empty' }, h('p', {}, people.length ? 'No one matches that search.' : 'No people yet. Add the first one.')));
    for (const p of rows) list.append(personRow(p));
  };
  const reload = async () => { people.splice(0, people.length, ...(await api('GET', '/api/people'))); draw(); };
  const isSuper = S.me.role === 'superadmin';
  const personRow = (p) => {
    const locked = p.isSuperadmin && !isSuper;
    const owner = p.isSuperadmin;
    const main = h('div', { class: 'person-main' },
      h('div', { class: 'row-title' }, p.name, ' ',
        owner && h('span', { class: 'pill owner' }, isSuper ? 'Owner (you)' : 'Owner'),
        !owner && h('span', { class: 'pill role-' + p.role }, p.role === 'admin' ? 'Admin' : 'Member'),
        !p.active && h('span', { class: 'pill off' }, 'Inactive')),
      h('div', { class: 'row-meta' }, h('span', {}, p.email), p.whatsapp && h('span', {}, '+' + p.whatsapp)),
      h('div', { class: 'row-meta' }, icon('send', 'sm'), `Nudges go to: ${targetLabel(p, settings.defaultGroupId)}`));
    const li = h('li', { class: 'task-row person-row' + (p.active ? '' : ' is-done'), 'data-id': p.id },
      h('span', { class: 'avatar' }, initials(p.name)),
      locked
        ? h('div', { class: 'row-main', title: 'Only the owner can edit this row' }, main)
        : h('button', { type: 'button', class: 'row-main person-open', 'aria-label': `Edit ${p.name}`, onclick: () => personSheet(ctx, p, settings, reload) }, main),
      locked && h('span', { class: 'lock', 'aria-label': 'Locked: only the owner can edit this row' }, icon('lock')));
    return li;
  };
  clear(body).append(
    h('div', { class: 'qa-pick' },
      h('input', { class: 'input', type: 'search', id: 'people-search', placeholder: 'Search people…', 'aria-label': 'Search people', oninput: (ev) => { query = ev.target.value; draw(); } }),
      h('button', { type: 'button', class: 'btn', id: 'add-person', onclick: () => personSheet(ctx, null, settings, reload) }, icon('plus', 'sm'), 'Add')),
    list);
  draw();
}

function personSheet(ctx, person, settings, onDone) {
  const { h, clear, icon, api, S, toast } = ctx;
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
      h('h2', {}, `${activate ? 'Reactivate' : 'Deactivate'} ${person.name}?`),
      h('p', { class: 'sub' }, activate ? 'They can sign in and get nudges again.' : 'They are signed out, stop getting nudges and can no longer sign in. Their tasks are kept.'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn secondary', id: 'confirm-cancel', onclick: draw }, 'Cancel'),
        h('button', { type: 'button', class: 'btn' + (activate ? '' : ' danger'), id: 'confirm-toggle', onclick: async () => {
          try {
            if (activate) {
              await api('PUT', `/api/people/${person.id}`, { email: person.email, name: person.name, whatsapp: person.whatsapp, role: person.role, active: true, notifyTarget: person.notifyTarget, notifyGroupId: person.notifyGroupId });
            } else await api('DELETE', `/api/people/${person.id}`);
            close(); toast(activate ? 'Reactivated' : 'Deactivated'); await onDone();
          } catch (e) { toast(e.network ? 'You are offline.' : e.message, { kind: 'error' }); draw(); }
        } }, activate ? 'Reactivate' : 'Deactivate')));
    const cancel = content.querySelector('#confirm-cancel');
    if (cancel) cancel.focus();
  };

  const testNudge = async (btn) => {
    btn.disabled = true;
    try {
      const r = await api('POST', `/api/people/${person.id}/test-nudge`, {});
      toast(r.target.type === 'dm' ? `Test nudge sent as a direct message to ${person.name}` : `Test nudge sent to ${groupName(r.target.chatId) || 'the group'}`);
    } catch (e) { toast(e.network ? 'You are offline.' : e.message, { kind: 'error' }); }
    btn.disabled = false;
  };

  const draw = () => {
    const err = st.errors;
    const name = h('input', { id: 'p-name', class: 'input', type: 'text', maxlength: '100', value: st.name, autocomplete: 'off', oninput: (ev) => { st.name = ev.target.value; } });
    name.value = st.name;
    const email = h('input', { id: 'p-email', class: 'input', type: 'email', value: st.email, autocomplete: 'off', disabled: ownerRow || adminRow, oninput: (ev) => { st.email = ev.target.value; } });
    email.value = st.email;
    const wa = h('input', { id: 'p-wa', class: 'input', type: 'tel', inputmode: 'tel', value: st.whatsapp, placeholder: '919812345678', oninput: (ev) => { st.whatsapp = ev.target.value; } });
    wa.value = st.whatsapp;
    const role = h('select', { id: 'p-role', class: 'input', disabled: ownerRow || adminRow, onchange: (ev) => { st.role = ev.target.value; } },
      h('option', { value: 'member' }, 'Member'),
      h('option', { value: 'admin', disabled: !actorSuper }, actorSuper ? 'Admin' : 'Admin (only the owner can grant this)'));
    role.value = st.role;
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Where nudges go' },
      [['default', 'Default group'], ['group', 'A group'], ['dm', 'Direct message']].map(([v, l]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(st.target === v), 'data-v': v, onclick: () => { st.target = v; draw(); } }, l)));
    fill(content,
      h('h2', {}, person ? (ownerRow ? 'Edit your own row' : 'Edit person') : 'Add person'),
      ownerRow && h('p', { class: 'sub' }, 'Owner (you): name, WhatsApp and nudge target can change. Email, role and active state are fixed.'),
      field(ctx, 'Name', name, { error: err.name, id: 'p-name' }),
      field(ctx, 'Email', email, { error: err.email, id: 'p-email', help: adminRow ? "Only the owner can change an admin's email." : 'They sign in with a code sent here.' }),
      field(ctx, 'WhatsApp', wa, { error: err.whatsapp, id: 'p-wa', help: 'International format with country code, digits only, e.g. 919812345678. Needed to be mentioned in a group or to get a direct message.' }),
      field(ctx, 'Role', role, { error: err.role, id: 'p-role', help: actorSuper ? 'Admins can manage people, access and settings.' : 'Only the owner can make someone an admin.' }),
      h('div', { class: 'field' }, h('label', {}, 'Nudges go to'), seg,
        st.target === 'default' && h('p', { class: 'small muted' }, settings.defaultGroupId ? `The default group${groupName(settings.defaultGroupId) ? `: ${groupName(settings.defaultGroupId)}` : ''}, mentioning them.` : 'No default group is set yet (see Notifications).'),
        st.target === 'dm' && h('p', { class: 'small muted' }, 'A direct WhatsApp message to their number.'),
        st.target === 'group' && groupPicker(ctx, { value: st.groupId || null, onPick: (id) => { st.groupId = id || ''; } }),
        err.notifyGroupId && h('p', { class: 'error-text', role: 'alert' }, err.notifyGroupId)),
      err._form && h('p', { class: 'error-text', role: 'alert' }, err._form),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn secondary', onclick: close }, 'Cancel'),
        h('button', { type: 'button', class: 'btn', id: 'save-person', disabled: st.busy, onclick: save }, person ? 'Save' : 'Add person')),
      person && h('div', { class: 'menu-list' },
        h('div', { class: 'menu-sep' }),
        person.active && h('button', { type: 'button', class: 'menu-item', id: 'test-nudge', onclick: (ev) => testNudge(ev.currentTarget) }, icon('send'), 'Send test nudge'),
        !ownerRow && (person.active
          ? h('button', { type: 'button', class: 'menu-item danger', id: 'deactivate', disabled: adminRow, onclick: () => confirmToggle(false) }, icon('x'), adminRow ? 'Deactivate (only the owner can for admins)' : 'Deactivate')
          : h('button', { type: 'button', class: 'menu-item', id: 'reactivate', disabled: adminRow, onclick: () => confirmToggle(true) }, icon('refresh-cw'), adminRow ? 'Reactivate (only the owner can for admins)' : 'Reactivate'))));
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
      if (e.network) st.errors = { _form: 'You are offline. Admin changes need a connection.' };
      else st.errors = { ...((e.body && e.body.fields) || {}), ...(e.body && e.body.fields ? {} : { _form: e.message }) };
      st.busy = false; draw();
      const first = content.querySelector('.error-text');
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
  const view = h('div', {});
  const reload = async () => { grants = await api('GET', '/api/access-grants'); draw(); };
  const act = async (fn, okText) => {
    try { await fn(); if (okText) ctx.toast(okText); await reload(); }
    catch (e) { ctx.toast(e.network ? 'You are offline.' : e.message, { kind: 'error' }); await reload().catch(() => {}); }
  };
  const levelSeg = (level, onChange, disabled) => h('div', { class: 'seg mini', role: 'radiogroup', 'aria-label': 'Access level' },
    [['view', 'View'], ['edit', 'Edit']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(level === v), disabled, onclick: () => { if (level !== v) onChange(v); } }, l)));

  function draw() {
    if (!selected) { clear(view).append(h('p', { class: 'muted' }, 'No people yet.')); return; }
    const lockedList = selected.isSuperadmin && !isSuper; // only the owner manages access to the owner's list
    const seeMine = grants.filter((g) => g.ownerPersonId === selected.id);
    const iSee = grants.filter((g) => g.granteePersonId === selected.id);
    const already = new Set(seeMine.map((g) => g.granteePersonId));
    const candidates = active.filter((p) => p.id !== selected.id && !already.has(p.id));
    let addWho = candidates[0] ? candidates[0].id : null;
    let addLevel = 'view';
    const picker = h('select', { class: 'input', id: 'access-person', 'aria-label': 'Person', onchange: (ev) => { selected = active.find((p) => p.id === Number(ev.target.value)); draw(); } },
      active.map((p) => h('option', { value: p.id }, p.name + (p.id === S.me.personId ? ' (me)' : ''))));
    picker.value = String(selected.id);
    const addSel = h('select', { class: 'input', id: 'access-add-person', 'aria-label': 'Add access for', disabled: lockedList || !candidates.length, onchange: (ev) => { addWho = Number(ev.target.value); } },
      candidates.map((p) => h('option', { value: p.id }, p.name)));
    const addSeg = h('div', { class: 'seg mini', role: 'radiogroup', 'aria-label': 'New access level' },
      [['view', 'View'], ['edit', 'Edit']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(addLevel === v), disabled: lockedList, onclick: (ev) => {
        addLevel = v;
        for (const b of ev.currentTarget.parentNode.children) b.setAttribute('aria-checked', String(b === ev.currentTarget));
      } }, l)));
    fill(view,
      field(ctx, 'Person', picker, { id: 'access-person' }),
      h('p', { class: 'callout' }, 'Everyone always sees their own list, and admins see every list. Access here lets a member see (View) or change (Edit) someone else\u2019s list.'),
      lockedList && h('p', { class: 'callout danger' }, icon('lock', 'sm'), ' Only the owner can change access to the owner\u2019s list.'),
      h('section', { class: 'task-card' }, h('div', { class: 'label' }, `Can see ${selected.name}\u2019s list`),
        selected.role === 'admin' ? h('p', { class: 'small muted' }, 'Admins see all lists (not listed here).') : '',
        h('ul', { class: 'access-list', id: 'access-see-mine' },
          seeMine.length ? seeMine.map((g) => h('li', { class: 'access-row', 'data-grantee': g.granteePersonId },
            h('span', { class: 'avatar' }, initials(g.granteeName)), h('span', { class: 'access-name' }, g.granteeName),
            levelSeg(g.level, (lv) => act(() => api('POST', '/api/access-grants', { granteePersonId: g.granteePersonId, ownerPersonId: g.ownerPersonId, level: lv }), 'Access changed'), lockedList),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${g.granteeName}'s access`, disabled: lockedList, onclick: () => act(() => api('DELETE', `/api/access-grants/${g.id}`), 'Access removed') }, icon('trash-2', 'sm'))))
            : h('li', { class: 'small muted' }, 'No one else can see this list yet.'))),
      h('section', { class: 'task-card' }, h('div', { class: 'label' }, 'Add access'),
        candidates.length ? h('div', { class: 'stack' }, addSel, addSeg,
          h('button', { type: 'button', class: 'btn', id: 'add-access', disabled: lockedList, onclick: () => addWho && act(() => api('POST', '/api/access-grants', { granteePersonId: addWho, ownerPersonId: selected.id, level: addLevel }), 'Access added') }, icon('plus', 'sm'), 'Add access'))
          : h('p', { class: 'small muted' }, 'Everyone already has access.')),
      h('section', { class: 'task-card' }, h('div', { class: 'label' }, `Lists ${selected.name} can see`),
        selected.role === 'admin' ? h('p', { class: 'small muted' }, 'Admins see all lists.') : '',
        h('ul', { class: 'access-list', id: 'access-iSee' },
          iSee.length ? iSee.map((g) => {
            const locked = g.ownerPersonId && (people.find((p) => p.id === g.ownerPersonId) || {}).isSuperadmin && !isSuper;
            return h('li', { class: 'access-row' }, h('span', { class: 'avatar' }, initials(g.ownerName)), h('span', { class: 'access-name' }, g.ownerName),
              h('span', { class: 'badge' }, g.level === 'edit' ? 'Edit' : 'View'),
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove access to ${g.ownerName}'s list`, disabled: !!locked, onclick: () => act(() => api('DELETE', `/api/access-grants/${g.id}`), 'Access removed') }, icon('trash-2', 'sm')));
          }) : h('li', { class: 'small muted' }, 'No lists beyond their own.'))));
  }
  clear(body).append(view);
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

async function renderNotifications(ctx) {
  const { h, clear, icon, api, body } = ctx;
  const cur = await api('GET', '/api/task-settings');
  await loadGroups(ctx, false);
  const st = { ...cur, quietHours: { ...cur.quietHours } };
  let errors = {};
  const preview = h('p', { class: 'callout', id: 'settings-preview', 'aria-live': 'polite' });
  const upd = () => { preview.textContent = previewText(st); };
  const num = (key, label, help, min, max) => {
    const input = h('input', { id: 's-' + key, class: 'input', type: 'number', inputmode: 'numeric', min, max, step: '1', value: st[key], oninput: (ev) => { st[key] = ev.target.value === '' ? NaN : Number(ev.target.value); upd(); } });
    input.value = String(st[key]);
    return field(ctx, label, input, { id: 's-' + key, help, error: errors[key] });
  };
  const draw = () => {
    const qh = st.quietHours;
    const time = (key, label) => {
      const input = h('input', { id: 'q-' + key, class: 'input', type: 'time', value: qh[key], disabled: !qh.enabled, oninput: (ev) => { qh[key] = ev.target.value; upd(); } });
      input.value = qh[key];
      return field(ctx, label, input, { id: 'q-' + key });
    };
    const toggle = h('input', { id: 'q-enabled', type: 'checkbox', checked: qh.enabled, onchange: (ev) => { qh.enabled = ev.target.checked; draw(); } });
    toggle.checked = qh.enabled;
    clear(body).append(h('div', { class: 'stack' },
      preview,
      h('section', { class: 'task-card' }, h('div', { class: 'label' }, 'Default group'),
        h('p', { class: 'small muted' }, 'Nudges for people without their own group go here, mentioning them.'),
        groupPicker(ctx, { value: st.defaultGroupId, allowNone: true, onPick: (id) => { st.defaultGroupId = id; } }),
        errors.defaultGroupId && h('p', { class: 'error-text', role: 'alert' }, errors.defaultGroupId)),
      h('section', { class: 'task-card' }, h('div', { class: 'label' }, 'Timing'),
        num('leadMinutes', 'First nudge (minutes before due)', 'When a task is this close to its due time, a nudge goes out. 1 to 1440.', 1, 1440),
        num('repeatMinutes', 'Repeat every (minutes)', 'How often a person is nudged again until the task is done or snoozed. 5 to 1440.', 5, 1440),
        num('mergeAheadMinutes', 'Group tasks due within (minutes)', 'When a nudge goes out anyway, tasks due this soon after are added to the same message. 0 turns it off, maximum 15.', 0, 15)),
      h('section', { class: 'task-card' }, h('div', { class: 'label' }, 'Quiet hours (IST)'),
        h('label', { class: 'toggle-row', for: 'q-enabled' }, toggle, h('span', {}, 'No nudges during quiet hours; they resume after.')),
        h('div', { class: 'qa-pick' }, time('start', 'From'), time('end', 'Until')),
        errors.quietHours && h('p', { class: 'error-text', role: 'alert' }, errors.quietHours)),
      errors._form && h('p', { class: 'error-text', role: 'alert' }, errors._form),
      h('button', { type: 'button', class: 'btn big block', id: 'save-settings', onclick: save }, icon('check'), 'Save settings')));
    upd();
  };
  async function save() {
    errors = {};
    try {
      const saved = await api('PUT', '/api/task-settings', st);
      Object.assign(st, saved, { quietHours: { ...saved.quietHours } });
      ctx.toast('Settings saved');
    } catch (e) {
      errors = e.network ? { _form: 'You are offline. Admin changes need a connection.' } : { ...((e.body && e.body.fields) || {}), ...(e.body && e.body.fields ? {} : { _form: e.message }) };
    }
    draw();
  }
  draw();
}

// ---------- Audit ----------

const AUDIT = {
  person_create: ['plus', 'Added a person'], person_update: ['pencil', 'Edited a person'], person_deactivate: ['x', 'Deactivated a person'],
  person_self_create: ['user', 'Created own task list'], person_self_repair: ['refresh-cw', 'Repaired own task list'],
  person_test_nudge: ['send', 'Sent a test nudge'], access_grant_set: ['eye', 'Set access to a list'], access_grant_remove: ['trash-2', 'Removed access to a list'],
  task_settings_update: ['bell', 'Changed notification settings'],
};

async function renderAudit(ctx) {
  const { h, clear, icon, api, body } = ctx;
  const rows = await api('GET', '/api/nudge/audit');
  const now = Date.now();
  if (!rows.length) { clear(body).append(h('div', { class: 'empty' }, icon('list-checks', 'xl'), h('h2', {}, 'Nothing here yet'), h('p', {}, 'Changes to people, access and settings will show up here.'))); return; }
  const detail = (d) => (d && typeof d === 'object' ? Object.entries(d).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]) : []);
  clear(body).append(h('ul', { class: 'audit-list', id: 'audit-list' }, rows.map((r) => {
    const [ic, label] = AUDIT[r.action] || ['info', r.action];
    const ms = Date.parse(r.at);
    const box = h('dl', { class: 'kv audit-details', hidden: true }, detail(r.details).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
    const btn = h('button', { type: 'button', class: 'link-btn small', 'aria-expanded': 'false', onclick: () => {
      box.hidden = !box.hidden;
      btn.setAttribute('aria-expanded', String(!box.hidden));
      btn.textContent = box.hidden ? 'Details' : 'Hide details';
    } }, 'Details');
    return h('li', { class: 'audit-row' },
      h('span', { class: 'audit-icon' }, icon(ic, 'sm')),
      h('div', { class: 'audit-main' },
        h('div', { class: 'audit-label' }, label),
        h('div', { class: 'small muted' }, `${r.actor} · ${fmtRelative(ms, now)} · ${fmtDateTime(ms, now)} IST`),
        btn, box));
  })));
}
