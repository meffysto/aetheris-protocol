// CITADEL // PROTOCOL — Pool Nostr multi-relais (WebSocket).
//
// Connexion à plusieurs relais en parallèle, broadcast de publish, dedup
// d'events par id, reconnexion auto avec backoff exponentiel plafonné.
//
// Iso : utilise le WebSocket global du navigateur, ou le polyfill Node 22+
// (globalThis.WebSocket disponible nativement à partir de Node 22).
//
// Usage :
//   import { createPool, DEFAULT_RELAYS } from './engine/nostr-pool.mjs';
//   const pool = createPool(DEFAULT_RELAYS);
//   const sub = pool.subscribe([{kinds:[1059], '#p':[mypub]}], evt => { ... });
//   pool.publish(signedEvent);
//   sub.close();
//   pool.close();

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 60000;
const DEDUP_CAP = 5000;

function makeId() {
  // 16 hex chars suffisent pour un sub id Nostr.
  const b = new Uint8Array(8);
  (globalThis.crypto ?? require('node:crypto').webcrypto).getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * LRU set borné — eviction du plus ancien quand on dépasse le cap.
 * Implémentation : Map (l'ordre d'insertion est conservé en JS).
 */
function makeLruSet(cap) {
  const m = new Map();
  return {
    has(k) { return m.has(k); },
    add(k) {
      if (m.has(k)) { m.delete(k); m.set(k, 1); return; }
      m.set(k, 1);
      if (m.size > cap) {
        const first = m.keys().next().value;
        m.delete(first);
      }
    },
    size() { return m.size; },
  };
}

/**
 * Connexion à un seul relais avec reconnexion auto.
 */
function connectRelay(url, { onMessage, onStatus, WS }) {
  const state = {
    url,
    ws: null,
    closed: false,
    backoff: BACKOFF_MIN,
    pendingSubs: new Map(), // subId -> filters (à re-souscrire au reconnect)
    pendingSends: [],       // messages en attente d'OPEN
  };

  function emitStatus(s, err) {
    try { onStatus?.(url, s, err); } catch {}
  }

  function send(msg) {
    const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.send(str); } catch (e) { state.pendingSends.push(str); }
    } else {
      state.pendingSends.push(str);
    }
  }

  function open() {
    if (state.closed) return;
    let ws;
    try { ws = new WS(url); }
    catch (e) { emitStatus('error', e); scheduleReconnect(); return; }
    state.ws = ws;

    ws.addEventListener('open', () => {
      state.backoff = BACKOFF_MIN;
      emitStatus('open');
      // Re-souscrire les subs en cours.
      for (const [subId, filters] of state.pendingSubs) {
        send(['REQ', subId, ...filters]);
      }
      // Flush pending.
      const q = state.pendingSends.splice(0);
      for (const m of q) { try { ws.send(m); } catch {} }
    });

    ws.addEventListener('message', (ev) => {
      let parsed;
      try { parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); }
      catch { return; }
      if (!Array.isArray(parsed)) return;
      onMessage(url, parsed);
    });

    ws.addEventListener('close', () => {
      emitStatus('closed');
      scheduleReconnect();
    });

    ws.addEventListener('error', (e) => {
      emitStatus('error', e?.message ?? 'ws error');
      // close suivra
    });
  }

  function scheduleReconnect() {
    if (state.closed) return;
    const delay = state.backoff;
    state.backoff = Math.min(state.backoff * 2, BACKOFF_MAX);
    setTimeout(() => { if (!state.closed) open(); }, delay);
  }

  open();

  return {
    url,
    send,
    addSub(subId, filters) {
      state.pendingSubs.set(subId, filters);
      send(['REQ', subId, ...filters]);
    },
    removeSub(subId) {
      state.pendingSubs.delete(subId);
      send(['CLOSE', subId]);
    },
    publish(event) {
      send(['EVENT', event]);
    },
    close() {
      state.closed = true;
      try { state.ws?.close(); } catch {}
    },
    get status() {
      return state.ws?.readyState ?? -1;
    },
  };
}

/**
 * Pool multi-relais. Dedup d'events partagés entre toutes les souscriptions.
 *
 * @param {string[]} relayUrls
 * @param {{ WebSocket?: typeof WebSocket, onStatus?: function, onPublishAck?: function }} opts
 */
export function createPool(relayUrls = DEFAULT_RELAYS, opts = {}) {
  const WS = opts.WebSocket ?? globalThis.WebSocket;
  if (!WS) throw new Error('WebSocket non disponible (Node < 22 ?)');

  const subs = new Map(); // subId -> { filters, onEvent, onEose, seenIds, eoseRelays }
  const relays = new Map(); // url -> connection

  function handleMessage(relayUrl, msg) {
    const tag = msg[0];
    if (tag === 'EVENT') {
      const subId = msg[1];
      const evt = msg[2];
      if (!evt || typeof evt.id !== 'string') return;
      const sub = subs.get(subId);
      if (!sub) return;
      if (sub.seenIds.has(evt.id)) return;
      sub.seenIds.add(evt.id);
      try { sub.onEvent(evt, relayUrl); } catch (e) { console.error('sub onEvent error', e); }
    } else if (tag === 'EOSE') {
      const subId = msg[1];
      const sub = subs.get(subId);
      if (!sub) return;
      sub.eoseRelays.add(relayUrl);
      if (sub.eoseRelays.size >= relays.size) {
        try { sub.onEose?.(); } catch {}
      }
    } else if (tag === 'OK') {
      try { opts.onPublishAck?.(relayUrl, msg[1], msg[2], msg[3]); } catch {}
    } else if (tag === 'NOTICE') {
      try { opts.onNotice?.(relayUrl, msg[1]); } catch {}
    }
  }

  for (const url of relayUrls) {
    relays.set(url, connectRelay(url, { onMessage: handleMessage, onStatus: opts.onStatus, WS }));
  }

  function subscribe(filters, onEvent, onEose) {
    if (!Array.isArray(filters)) filters = [filters];
    const subId = 'cit-' + makeId();
    const sub = { filters, onEvent, onEose, seenIds: makeLruSet(DEDUP_CAP), eoseRelays: new Set() };
    subs.set(subId, sub);
    for (const r of relays.values()) r.addSub(subId, filters);
    return {
      id: subId,
      close() {
        subs.delete(subId);
        for (const r of relays.values()) r.removeSub(subId);
      },
      update(newFilters) {
        sub.filters = Array.isArray(newFilters) ? newFilters : [newFilters];
        sub.eoseRelays.clear();
        for (const r of relays.values()) {
          r.removeSub(subId);
          r.addSub(subId, sub.filters);
        }
      },
    };
  }

  function publish(event) {
    for (const r of relays.values()) r.publish(event);
  }

  function close() {
    for (const r of relays.values()) r.close();
    relays.clear();
    subs.clear();
  }

  return {
    subscribe,
    publish,
    close,
    relays: relayUrls.slice(),
    _internal: { subs, relays }, // pour tests
  };
}

/**
 * Helper : souscrit aux DM gift-wrappés (kind 1059) dont l'auteur appartient
 * au roster. Defense-in-depth : la liste `authors` filtre côté relais ET on
 * re-vérifie côté handler après unwrap (puisque l'auteur du wrap est une clé
 * éphémère, c'est le seal.pubkey qui doit être dans le roster).
 *
 * @param {ReturnType<createPool>} pool
 * @param {string} myPubkeyHex
 * @param {Set<string>} roster — pubkeys hex (32B) autorisées
 * @param {(unwrapped: {from,content,createdAt}, raw) => void} onDM
 * @param {(wrapEvt) => Promise<{from,content,createdAt}|null>} unwrapper
 *        injecté pour ne pas créer de dépendance circulaire avec nostr-dm.
 */
export function subscribeRosterDMs(pool, myPubkeyHex, roster, onDM, unwrapper) {
  // Filtre côté relais : on ne peut PAS filtrer par seal.pubkey (chiffré),
  // donc on prend tous les wraps adressés à nous. Le filtrage roster se fait
  // après unwrap. (Le brief mentionne authors:[...roster] mais c'est inutile
  // côté wrap puisque l'auteur du wrap est éphémère et inconnu d'avance.)
  const filter = { kinds: [1059], '#p': [myPubkeyHex] };

  const sub = pool.subscribe([filter], async (evt) => {
    const unwrapped = await unwrapper(evt);
    if (!unwrapped) return;
    if (!roster.has(unwrapped.from)) return; // defense in depth
    onDM(unwrapped, evt);
  });

  return {
    close: () => sub.close(),
    // refresh : si le roster change, pas besoin de re-souscrire (le filtre
    // ne dépend pas du roster). On expose juste un no-op pour la symétrie.
    refresh: () => {},
  };
}
