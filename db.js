// IndexedDB shared by the recorder windows and the library page.
// Every chunk is keyed by session id. Nothing here ever deletes a session
// on its own, so concurrent recorders can't remove each other's data.

const DB_NAME = 'heimdall';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      db.createObjectStore('chunks', { autoIncrement: true }).createIndex('session', 'session');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putSession(session) {
  const db = await open();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(session);
  return done(tx);
}

export async function updateSession(id, patch) {
  const db = await open();
  const tx = db.transaction('sessions', 'readwrite');
  const store = tx.objectStore('sessions');
  const current = await request(store.get(id));
  if (current) store.put({ ...current, ...patch });
  return done(tx);
}

export async function listSessions() {
  const db = await open();
  const all = await request(db.transaction('sessions').objectStore('sessions').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function addChunk(session, data) {
  const db = await open();
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').add({ session, data });
  return done(tx);
}

export async function getBlob(session, mimeType) {
  const db = await open();
  const rows = await request(
    db.transaction('chunks').objectStore('chunks').index('session').getAll(session),
  );
  return new Blob(rows.map((r) => r.data), { type: mimeType });
}

// Kept copies and unfinished sessions expire so storage can't grow forever.
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function purgeExpired() {
  const cutoff = Date.now() - RETENTION_MS;
  const sessions = await listSessions();
  await Promise.all(sessions.filter((s) => s.startedAt < cutoff).map((s) => deleteSession(s.id)));
}

export async function deleteSession(id) {
  const db = await open();
  const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
  tx.objectStore('sessions').delete(id);
  const index = tx.objectStore('chunks').index('session');
  const keys = await request(index.getAllKeys(id));
  keys.forEach((k) => tx.objectStore('chunks').delete(k));
  return done(tx);
}
