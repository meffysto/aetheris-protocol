// CITADEL // PROTOCOL — Messagerie joueur (orchestration browser).
//
// Branche le pool Nostr, le NIP-17, le roster issu du scan Bitcoin,
// le stockage local chiffré (AES-GCM réutilisé du wallet), et fournit
// une API simple pour la console.
//
// Module browser uniquement (utilise WebSocket global + crypto.subtle).

import { wrapDM, unwrapDM, hexToBytes, bytesToHex } from './nostr-dm.mjs';
import { createPool, DEFAULT_RELAYS, subscribeRosterDMs } from './nostr-pool.mjs';
import { schnorr } from '@noble/curves/secp256k1';

const STORAGE_PREFIX = 'aetheris.dm.';
const MAX_THREADS_PER_PEER = 500;

/**
 * Crée une instance messagerie.
 *
 * @param {{
 *   myPrivHex: string,                     // privkey Schnorr 32B hex
 *   roster: Set<string>,                   // pubkeys hex autorisées (incl. soi-même optionnellement)
 *   resolveName?: (pubkeyHex) => string,   // pour libellés UI
 *   aesEncrypt?: (str) => Promise<string>, // optionnel — stockage chiffré
 *   aesDecrypt?: (str) => Promise<string>, // optionnel — stockage chiffré
 *   onUpdate?: () => void,                 // appelé quand l'état change
 *   onIncoming?: (msg) => void,            // appelé sur DM entrant après stockage
 *   relays?: string[],
 * }} opts
 */
export function createMessagerie(opts) {
  const {
    myPrivHex,
    roster,
    resolveName = (pk) => pk.slice(0, 8) + '…',
    aesEncrypt = null,
    aesDecrypt = null,
    onUpdate = () => {},
    onIncoming = () => {},
    relays = DEFAULT_RELAYS,
  } = opts;

  if (!myPrivHex || myPrivHex.length !== 64) {
    throw new Error('myPrivHex requis (32B hex Schnorr)');
  }
  const myPrivBytes = hexToBytes(myPrivHex);
  const myPubHex = bytesToHex(schnorr.getPublicKey(myPrivBytes));

  const storageKey = STORAGE_PREFIX + myPubHex;

  // État en mémoire : { peerHex: [{ from, to, content, ts, direction }] }
  let threads = {};
  let pool = null;
  let sub = null;
  let started = false;

  async function loadFromStorage() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      let payload = raw;
      if (aesDecrypt && raw.startsWith('enc:')) {
        try { payload = await aesDecrypt(raw.slice(4)); }
        catch { console.warn('[messagerie] déchiffrement local échoué'); return; }
      }
      threads = JSON.parse(payload) || {};
    } catch (e) {
      console.warn('[messagerie] load storage:', e.message);
    }
  }

  async function saveToStorage() {
    try {
      const json = JSON.stringify(threads);
      if (aesEncrypt) {
        const ct = await aesEncrypt(json);
        localStorage.setItem(storageKey, 'enc:' + ct);
      } else {
        localStorage.setItem(storageKey, json);
      }
    } catch (e) {
      console.warn('[messagerie] save storage:', e.message);
    }
  }

  function appendMessage(peerHex, msg) {
    if (!threads[peerHex]) threads[peerHex] = [];
    // Dedup : même from+ts+content déjà présent ?
    const dup = threads[peerHex].find(m =>
      m.ts === msg.ts && m.from === msg.from && m.content === msg.content);
    if (dup) return false;
    threads[peerHex].push(msg);
    threads[peerHex].sort((a, b) => a.ts - b.ts);
    if (threads[peerHex].length > MAX_THREADS_PER_PEER) {
      threads[peerHex] = threads[peerHex].slice(-MAX_THREADS_PER_PEER);
    }
    return true;
  }

  async function start() {
    if (started) return;
    started = true;
    await loadFromStorage();
    pool = createPool(relays, {
      onStatus: (url, s, err) => {
        if (s === 'error') console.warn('[nostr]', url, 'err:', err);
      },
    });
    sub = subscribeRosterDMs(
      pool,
      myPubHex,
      roster,
      async (unwrapped /*, raw */) => {
        const peer = unwrapped.from;
        const msg = {
          from: peer,
          to: myPubHex,
          content: unwrapped.content,
          ts: unwrapped.createdAt,
          direction: 'in',
        };
        if (appendMessage(peer, msg)) {
          await saveToStorage();
          try { onIncoming(msg); } catch {}
          try { onUpdate(); } catch {}
        }
      },
      async (wrapEvt) => unwrapDM(wrapEvt, myPrivBytes),
    );
  }

  async function send(peerHex, content) {
    if (!started) throw new Error('messagerie non démarrée');
    if (!roster.has(peerHex)) throw new Error('destinataire hors roster');
    if (typeof content !== 'string' || !content.trim()) throw new Error('message vide');
    const wrap = wrapDM(content, myPrivBytes, peerHex);
    pool.publish(wrap);
    const msg = {
      from: myPubHex,
      to: peerHex,
      content,
      ts: Math.floor(Date.now() / 1000),
      direction: 'out',
    };
    appendMessage(peerHex, msg);
    await saveToStorage();
    try { onUpdate(); } catch {}
    return msg;
  }

  function getThreads() {
    // Retourne un snapshot trié par dernier message desc.
    return Object.entries(threads)
      .map(([peer, msgs]) => ({
        peer,
        name: resolveName(peer),
        messages: msgs.slice(),
        lastTs: msgs.length ? msgs[msgs.length - 1].ts : 0,
        unreadOut: msgs.filter(m => m.direction === 'in' && !m._read).length,
      }))
      .sort((a, b) => b.lastTs - a.lastTs);
  }

  function markThreadRead(peerHex) {
    const t = threads[peerHex];
    if (!t) return;
    let dirty = false;
    for (const m of t) if (m.direction === 'in' && !m._read) { m._read = true; dirty = true; }
    if (dirty) { saveToStorage(); onUpdate(); }
  }

  function stop() {
    try { sub?.close(); } catch {}
    try { pool?.close(); } catch {}
    pool = null; sub = null; started = false;
  }

  return {
    start, stop, send,
    getThreads, markThreadRead,
    myPubkey: myPubHex,
    get isStarted() { return started; },
  };
}

/**
 * Helper : extrait la privkey Schnorr 32B (hex) depuis un wallet stocké.
 * Le wallet contient privateKeyWIF — on décode en Base58Check.
 *
 * @param {object} wallet - { privateKeyWIF, network }
 * @param {object} libs - { btc } (depuis aetherisBitcoin)
 */
export function privFromWallet(wallet, libs) {
  const NETS = {
    mainnet:   { wif: 128 },
    signet:    { wif: 239 },
    mutinynet: { wif: 239 },
  };
  const net = NETS[wallet.network] || NETS.mutinynet;
  const decoded = libs.btc.WIF(net).decode(wallet.privateKeyWIF);
  // decoded = Uint8Array 32B
  if (decoded.length !== 32) throw new Error('WIF décodé inattendu (' + decoded.length + 'B)');
  return bytesToHex(decoded);
}
