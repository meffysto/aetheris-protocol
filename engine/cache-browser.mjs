// Adaptateur cache pour navigateur — IndexedDB.
// Usage : import { makeBrowserAdapter } from './cache-browser.mjs';
//         initCache(await makeBrowserAdapter('aetheris-cache'));

const STORE = 'kv';

function openDb(dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function makeBrowserAdapter(dbName = 'aetheris-cache') {
  const db = await openDb(dbName);
  return {
    async get(key) {
      const v = await asPromise(tx(db, 'readonly').get(key));
      return v ?? null;
    },
    async set(key, value) {
      await asPromise(tx(db, 'readwrite').put(value, key));
    },
    async clear() {
      await asPromise(tx(db, 'readwrite').clear());
    },
  };
}
