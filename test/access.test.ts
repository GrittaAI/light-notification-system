import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { createPerson } from '../src/people.js';
import { type Actor, canEdit, canView, visibleOwners } from '../src/tasks/access.js';
import { setupNudge, uuid } from './helpers/nudge.js';

beforeAll(() => { process.env.LOG_LEVEL = 'error'; });

function world() {
  const db = openDb(':memory:');
  const mk = (n: string, role: 'admin' | 'member' = 'member') => createPerson(db, { email: `${n}@example.com`, name: n, role });
  const [ann, bob, cy, adm] = [mk('ann'), mk('bob'), mk('cy'), mk('adm', 'admin')];
  const actor = (p: { email: string; id: number }, role: Actor['role'] = 'member'): Actor => ({ email: p.email, role, personId: p.id });
  const grant = (g: number, o: number, level: 'view' | 'edit') =>
    db.prepare(`INSERT INTO access_grants (grantee_person_id, owner_person_id, level, created_by, created_at) VALUES (?, ?, ?, 'x', 't')`).run(g, o, level);
  return { db, ann, bob, cy, adm, actor, grant };
}

describe('access.ts', () => {
  it('owner always edits their own list; others have nothing without a grant', () => {
    const w = world();
    expect(canEdit(w.db, w.actor(w.ann), w.ann.id)).toBe(true);
    expect(canView(w.db, w.actor(w.ann), w.bob.id)).toBe(false);
    expect(canEdit(w.db, w.actor(w.ann), w.bob.id)).toBe(false);
  });

  it('a view grant allows view only; an edit grant allows both; grants are one-directional', () => {
    const w = world();
    w.grant(w.ann.id, w.bob.id, 'view');
    w.grant(w.ann.id, w.cy.id, 'edit');
    const a = w.actor(w.ann);
    expect([canView(w.db, a, w.bob.id), canEdit(w.db, a, w.bob.id)]).toEqual([true, false]);
    expect([canView(w.db, a, w.cy.id), canEdit(w.db, a, w.cy.id)]).toEqual([true, true]);
    expect(canView(w.db, w.actor(w.bob), w.ann.id)).toBe(false);
  });

  it('admins and the superadmin edit everything', () => {
    const w = world();
    expect(canEdit(w.db, w.actor(w.adm, 'admin'), w.ann.id)).toBe(true);
    expect(canEdit(w.db, { email: 's@example.com', role: 'superadmin', personId: null }, w.ann.id)).toBe(true);
    expect(canEdit(w.db, { email: 's@example.com', role: 'superadmin', personId: null }, 9999)).toBe(false); // no such owner
  });

  it('deactivated people have no access, and nobody but an admin reaches a deactivated owner', () => {
    const w = world();
    w.grant(w.ann.id, w.bob.id, 'edit');
    w.db.prepare(`UPDATE people SET active = 0 WHERE id = ?`).run(w.ann.id);
    expect(canView(w.db, w.actor(w.ann), w.ann.id)).toBe(false);
    expect(canView(w.db, w.actor(w.ann), w.bob.id)).toBe(false);
    expect(visibleOwners(w.db, w.actor(w.ann))).toEqual([]);
    w.db.prepare(`UPDATE people SET active = 0 WHERE id = ?`).run(w.cy.id);
    expect(canView(w.db, w.actor(w.bob), w.cy.id)).toBe(false);
    expect(canView(w.db, w.actor(w.adm, 'admin'), w.cy.id)).toBe(true);
    w.db.prepare(`UPDATE people SET active = 0 WHERE id = ?`).run(w.adm.id);
    expect(canView(w.db, w.actor(w.adm, 'admin'), w.bob.id)).toBe(false);
  });

  it('visibleOwners lists the actor first, then granted owners; admins see all active people', () => {
    const w = world();
    w.grant(w.bob.id, w.ann.id, 'view');
    w.grant(w.bob.id, w.cy.id, 'edit');
    expect(visibleOwners(w.db, w.actor(w.bob))).toEqual([
      { id: w.bob.id, name: 'bob', level: 'edit' }, { id: w.ann.id, name: 'ann', level: 'view' }, { id: w.cy.id, name: 'cy', level: 'edit' },
    ]);
    const all = visibleOwners(w.db, w.actor(w.cy, 'admin'));
    expect(all.map((o) => o.name)).toEqual(['cy', 'adm', 'ann', 'bob']);
    expect(all.every((o) => o.level === 'edit')).toBe(true);
    expect(visibleOwners(w.db, { email: 's@example.com', role: 'superadmin', personId: null }).map((o) => o.name)).toEqual(['adm', 'ann', 'bob', 'cy']);
  });
});

describe('access grants API', () => {
  it('admin-only CRUD with validation and audit; a view grant gives read access over HTTP, an edit grant write access', async () => {
    const t = await setupNudge();
    const ann = t.person('ann@example.com');
    const bob = t.person('bob@example.com');
    t.person('adm@example.com', 'admin');
    const adm = await t.loginWithCode('adm@example.com');
    const annC = await t.loginWithCode('ann@example.com');

    expect((await t.request('GET', '/api/access-grants', { cookie: annC })).status).toBe(403);
    expect((await t.request('POST', '/api/access-grants', { cookie: adm, body: { granteePersonId: ann.id, ownerPersonId: ann.id, level: 'view' } })).status).toBe(400);
    expect((await t.request('POST', '/api/access-grants', { cookie: adm, body: { granteePersonId: ann.id, ownerPersonId: 999, level: 'view' } })).status).toBe(400);
    expect((await t.request('POST', '/api/access-grants', { cookie: adm, body: { granteePersonId: ann.id, ownerPersonId: bob.id, level: 'own' } })).status).toBe(400);

    const id = uuid();
    const bobC = await t.loginWithCode('bob@example.com');
    expect((await t.request('PUT', `/api/app/tasks/${id}`, { cookie: bobC, body: { title: 'bob task' } })).status).toBe(201);
    expect((await t.request('GET', `/api/app/tasks/${id}/activity`, { cookie: annC })).status).toBe(404);

    const g = await t.request('POST', '/api/access-grants', { cookie: adm, body: { granteePersonId: ann.id, ownerPersonId: bob.id, level: 'view' } });
    expect(g.status).toBe(201);
    expect(g.json).toMatchObject({ granteeName: 'ann', ownerName: 'bob', level: 'view' });
    expect((await t.request('GET', `/api/app/tasks?owner=${bob.id}`, { cookie: annC })).json.tasks).toHaveLength(1);
    const edit = await t.request('PUT', `/api/app/tasks/${id}`, { cookie: annC, body: { title: 'x', baseVersion: 1 } });
    expect(edit.status).toBe(403);

    await t.request('POST', '/api/access-grants', { cookie: adm, body: { granteePersonId: ann.id, ownerPersonId: bob.id, level: 'edit' } });
    expect((await t.request('GET', '/api/access-grants', { cookie: adm })).json).toHaveLength(1); // upsert, not a duplicate
    expect((await t.request('PUT', `/api/app/tasks/${id}`, { cookie: annC, body: { title: 'edited by ann', baseVersion: 1 } })).status).toBe(200);

    expect((await t.request('DELETE', `/api/access-grants/${g.json.id}`, { cookie: adm })).status).toBe(200);
    expect((await t.request('GET', `/api/app/tasks?owner=${bob.id}`, { cookie: annC })).status).toBe(403);
    expect((await t.request('DELETE', `/api/access-grants/${g.json.id}`, { cookie: adm })).status).toBe(404);
    const actions = (t.db.prepare(`SELECT action FROM audit_log WHERE action LIKE 'access_grant%'`).all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['access_grant_set', 'access_grant_set', 'access_grant_remove']);
  });
});
