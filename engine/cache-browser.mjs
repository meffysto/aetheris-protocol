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

// Fallback in-memory : utilisé quand IndexedDB est indisponible (Safari
// Private Browsing, isolation cross-site, Lockdown Mode). Le scan
// recommencera de zéro à chaque reload, mais la console boot.
function makeMemoryAdapter() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? m.get(key) : null; },
    async set(key, value) { m.set(key, value); },
    async clear() { m.clear(); },
  };
}

export async function makeBrowserAdapter(dbName = 'aetheris-cache') {
  if (typeof indexedDB === 'undefined') {
    console.warn('[cache-browser] indexedDB indisponible — fallback mémoire (le scan ne sera pas persisté)');
    return makeMemoryAdapter();
  }
  let db;
  try {
    db = await openDb(dbName);
  } catch (e) {
    console.warn('[cache-browser] openDb a échoué (' + (e?.message || e) + ') — fallback mémoire');
    return makeMemoryAdapter();
  }
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
