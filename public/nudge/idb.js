// Thin IndexedDB adapter for Nudge: stores tasks, owners, outbox and meta. Promise-based, no logic of its own.
// All data is cleared on sign-out (see clearAll).

const DB_NAME = 'nudge';
const DB_VERSION = 1;
let dbPromise = null;

export function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('tasks', { keyPath: 'id' });
        db.createObjectStore('owners', { keyPath: 'id' });
        db.createObjectStore('outbox', { keyPath: 'seq' });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

/** Runs `fn(stores)` in one transaction over the named stores and resolves when it commits. */
async function run(names, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    result = fn(stores);
  });
}

const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export async function getAll(store) {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

/**
 * Applies { tasks: {put, remove}, owners: {replace}, outbox: {put, remove}, meta: {key: value} } atomically.
 * The outbox is only ever written per entry (put by seq, delete by seq), never cleared and replaced, so two writers
 * cannot wipe each other's queued changes.
 */
export function write(changes) {
  const names = [];
  if (changes.tasks) names.push('tasks');
  if (changes.owners) names.push('owners');
  if (changes.outbox) names.push('outbox');
  if (changes.meta) names.push('meta');
  if (names.length === 0) return Promise.resolve();
  return run(names, 'readwrite', (s) => {
    if (changes.tasks) {
      for (const t of changes.tasks.put || []) s.tasks.put(t);
      for (const id of changes.tasks.remove || []) s.tasks.delete(id);
    }
    if (changes.owners) {
      s.owners.clear();
      for (const o of changes.owners.replace) s.owners.put(o);
    }
    if (changes.outbox) {
      for (const e of changes.outbox.put || []) s.outbox.put(e);
      for (const seq of changes.outbox.remove || []) s.outbox.delete(seq);
    }
    if (changes.meta) {
      for (const [key, value] of Object.entries(changes.meta)) s.meta.put({ key, value });
    }
  });
}

export async function getMeta(key) {
  const row = await get('meta', key);
  return row ? row.value : undefined;
}

/** Deletes everything (sign-out). */
export function clearAll() {
  return run(['tasks', 'owners', 'outbox', 'meta'], 'readwrite', (s) => {
    for (const st of Object.values(s)) st.clear();
  });
}
