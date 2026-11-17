// Access control for task lists. Every /api/app route goes through here; the UI only hides things.
//   - The owner always has edit access to their own tasks.
//   - Admins and the superadmin have edit access to everything.
//   - Members otherwise have only what an access grant gives them.
//   - Deactivated people have no access.

import type { DB } from '../db.js';
import type { UserRole } from '../people.js';

export type AccessLevel = 'view' | 'edit';

/** The signed-in user as far as access is concerned (a SessionUser fits). */
export interface Actor {
  email: string;
  role: UserRole;
  personId: number | null;
}

export interface OwnerEntry {
  id: number;
  name: string;
  level: AccessLevel;
}

interface PersonLite { id: number; name: string; active: number }

const person = (db: DB, id: number) =>
  db.prepare(`SELECT id, name, active FROM people WHERE id = ?`).get(id) as PersonLite | undefined;

/** The actor's own person row must be active (the superadmin may have none). */
function actorActive(db: DB, actor: Actor): boolean {
  if (actor.role === 'superadmin') return true;
  if (actor.personId === null) return false;
  return person(db, actor.personId)?.active === 1;
}

export function accessLevel(db: DB, actor: Actor, ownerPersonId: number): AccessLevel | null {
  if (!actorActive(db, actor)) return null;
  const owner = person(db, ownerPersonId);
  if (!owner) return null;
  if (actor.role === 'superadmin' || actor.role === 'admin') return 'edit';
  if (owner.active !== 1) return null;
  if (actor.personId === ownerPersonId) return 'edit';
  if (actor.personId === null) return null;
  const g = db
    .prepare(`SELECT level FROM access_grants WHERE grantee_person_id = ? AND owner_person_id = ?`)
    .get(actor.personId, ownerPersonId) as { level: AccessLevel } | undefined;
  return g?.level ?? null;
}

export const canView = (db: DB, actor: Actor, ownerPersonId: number): boolean => accessLevel(db, actor, ownerPersonId) !== null;
export const canEdit = (db: DB, actor: Actor, ownerPersonId: number): boolean => accessLevel(db, actor, ownerPersonId) === 'edit';

/** Active people whose lists the actor can see, the actor first, then by name. */
export function visibleOwners(db: DB, actor: Actor): OwnerEntry[] {
  if (!actorActive(db, actor)) return [];
  const all = db.prepare(`SELECT id, name, active FROM people WHERE active = 1 ORDER BY name COLLATE NOCASE, id`).all() as PersonLite[];
  let out: OwnerEntry[];
  if (actor.role === 'superadmin' || actor.role === 'admin') {
    out = all.map((p) => ({ id: p.id, name: p.name, level: 'edit' as const }));
  } else {
    const grants = new Map(
      (db.prepare(`SELECT owner_person_id, level FROM access_grants WHERE grantee_person_id = ?`).all(actor.personId) as
        { owner_person_id: number; level: AccessLevel }[]).map((g) => [g.owner_person_id, g.level]),
    );
    out = all.flatMap((p) => {
      if (p.id === actor.personId) return [{ id: p.id, name: p.name, level: 'edit' as const }];
      const level = grants.get(p.id);
      return level ? [{ id: p.id, name: p.name, level }] : [];
    });
  }
  return [...out.filter((o) => o.id === actor.personId), ...out.filter((o) => o.id !== actor.personId)];
}
