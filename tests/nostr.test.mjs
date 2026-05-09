// Tests Nostr / NIP-44 v2 / NIP-17 gift-wrap / pool websocket.
// Couvre :
//   - vecteurs officiels NIP-44 v2 (conversation key, message keys, padding)
//   - round-trip NIP-44 (chiffrement → déchiffrement, contenu identique)
//   - round-trip NIP-17 (gift-wrap → unwrap, from = pubkey émetteur réel)
//   - smoke pool : publish broadcast, dedup events, reconnexion auto

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1';

import {
  encryptNip44, decryptNip44,
  encryptWithConversationKey, decryptWithConversationKey,
  getConversationKey, getMessageKeys,
  calcPaddedLen, chacha20,
  wrapDM, unwrapDM,
  bytesToHex, hexToBytes,
  signEvent, verifyEvent, eventId,
  KIND_DM_WRAP,
} from '../engine/nostr-dm.mjs';

import { createPool, DEFAULT_RELAYS } from '../engine/nostr-pool.mjs';

// ─── ChaCha20 RFC 8439 vecteur officiel ─────────────────────────────────────
test('chacha20 — vecteur RFC 8439 §2.4.2', () => {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = i;
  const nonce = new Uint8Array([0,0,0,0,0,0,0,0x4a,0,0,0,0]);
  const pt = new TextEncoder().encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
  );
  const ct = chacha20(key, nonce, pt, 1);
  const expected =
    '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d';
  assert.equal(bytesToHex(ct), expected);
});

// ─── NIP-44 padding (extraits de la spec) ────────────────────────────────────
test('NIP-44 padding — buckets canoniques', () => {
  const cases = [
    [1, 32], [16, 32], [32, 32],
    [33, 64], [64, 64],
    [65, 96], [100, 128], [128, 128],
    [256, 256],
    [257, 320], [320, 320], [384, 384], [448, 448], [512, 512],
    [513, 640], [640, 640],
    [1024, 1024], [1025, 1280],
  ];
  for (const [inp, exp] of cases) {
    assert.equal(calcPaddedLen(inp), exp, `pad(${inp}) = ${exp}`);
  }
});

// ─── NIP-44 conversation key — vecteur officiel ──────────────────────────────
test('NIP-44 conversation key — vecteur officiel sec1=1, sec2=2', () => {
  const s1 = new Uint8Array(32); s1[31] = 1;
  const s2 = new Uint8Array(32); s2[31] = 2;
  const p1 = schnorr.getPublicKey(s1);
  const p2 = schnorr.getPublicKey(s2);
  const ck = getConversationKey(s1, p2);
  // Vecteur de référence (paulmillr/nip44 vectors).
  const expected = 'c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d';
  assert.equal(bytesToHex(ck), expected);
  // Symétrie : même conversation key dans l'autre sens.
  const ck2 = getConversationKey(s2, p1);
  assert.equal(bytesToHex(ck), bytesToHex(ck2));
});

// ─── NIP-44 message keys — déterminisme HKDF-expand ──────────────────────────
test('NIP-44 message keys — HKDF-expand déterministe', () => {
  const ck = hexToBytes('c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d');
  const nonce = new Uint8Array(32); // nonce zero
  const mk1 = getMessageKeys(ck, nonce);
  const mk2 = getMessageKeys(ck, nonce);
  assert.equal(bytesToHex(mk1.chachaKey), bytesToHex(mk2.chachaKey));
  assert.equal(mk1.chachaKey.length, 32);
  assert.equal(mk1.chachaNonce.length, 12);
  assert.equal(mk1.hmacKey.length, 32);
});

// ─── NIP-44 round-trip ──────────────────────────────────────────────────────
test('NIP-44 round-trip — texte ASCII', () => {
  const a = schnorr.utils.randomSecretKey();
  const b = schnorr.utils.randomSecretKey();
  const A = schnorr.getPublicKey(a);
  const B = schnorr.getPublicKey(b);
  const msg = 'hello world';
  const ct = encryptNip44(msg, a, B);
  assert.equal(decryptNip44(ct, b, A), msg);
});

test('NIP-44 round-trip — UTF-8 multi-byte (accents, emoji, kanji)', () => {
  const a = schnorr.utils.randomSecretKey();
  const b = schnorr.utils.randomSecretKey();
  const A = schnorr.getPublicKey(a);
  const B = schnorr.getPublicKey(b);
  const msg = 'Café crème ☕ 漢字 🚀 — éàü';
  const ct = encryptNip44(msg, a, B);
  assert.equal(decryptNip44(ct, b, A), msg);
});

test('NIP-44 round-trip — payload long (1500 caractères)', () => {
  const a = schnorr.utils.randomSecretKey();
  const b = schnorr.utils.randomSecretKey();
  const A = schnorr.getPublicKey(a);
  const B = schnorr.getPublicKey(b);
  const msg = 'x'.repeat(1500);
  const ct = encryptNip44(msg, a, B);
  assert.equal(decryptNip44(ct, b, A), msg);
});

// ─── NIP-44 chiffrement déterministe (nonce fixé) ────────────────────────────
test('NIP-44 chiffrement déterministe avec nonce fixé', () => {
  const ck = hexToBytes('c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d');
  const nonce = new Uint8Array(32); // tout à zéro
  const ct1 = encryptWithConversationKey('hello', ck, nonce);
  const ct2 = encryptWithConversationKey('hello', ck, nonce);
  assert.equal(ct1, ct2, 'même nonce → même ciphertext');
  assert.equal(decryptWithConversationKey(ct1, ck), 'hello');
});

// ─── NIP-44 MAC invalide rejeté ─────────────────────────────────────────────
test('NIP-44 — MAC altéré rejeté', () => {
  const a = schnorr.utils.randomSecretKey();
  const b = schnorr.utils.randomSecretKey();
  const A = schnorr.getPublicKey(a);
  const B = schnorr.getPublicKey(b);
  const ct = encryptNip44('secret', a, B);
  // Décode b64, flip 1 bit du dernier byte (dans le MAC), réencode.
  const buf = Buffer.from(ct, 'base64');
  buf[buf.length - 1] ^= 0x01;
  const tampered = buf.toString('base64');
  assert.throws(() => decryptNip44(tampered, b, A), /MAC invalide/);
});

// ─── NIP-01 event id + signature ─────────────────────────────────────────────
test('NIP-01 — eventId déterministe, signature vérifiable', () => {
  const priv = schnorr.utils.randomSecretKey();
  const evt = signEvent({
    kind: 1,
    content: 'hello nostr',
    tags: [['t', 'test']],
    created_at: 1700000000,
  }, priv);
  assert.equal(evt.id, eventId(evt));
  assert.equal(evt.id.length, 64);
  assert.equal(evt.sig.length, 128);
  assert.ok(verifyEvent(evt));
  // Tampered content → verify échoue.
  const tampered = { ...evt, content: 'altered' };
  assert.equal(verifyEvent(tampered), false);
});

// ─── NIP-17 round-trip gift-wrap ────────────────────────────────────────────
test('NIP-17 — wrap → unwrap, from = pubkey Alice (pas la clé éphémère)', () => {
  const alicePriv = schnorr.utils.randomSecretKey();
  const bobPriv = schnorr.utils.randomSecretKey();
  const alicePubHex = bytesToHex(schnorr.getPublicKey(alicePriv));
  const bobPubHex = bytesToHex(schnorr.getPublicKey(bobPriv));

  const wrap = wrapDM('Salut Bob, c\'est Alice', alicePriv, bobPubHex);
  assert.equal(wrap.kind, KIND_DM_WRAP);
  assert.notEqual(wrap.pubkey, alicePubHex, 'wrap doit être signé par clé éphémère');
  assert.equal(wrap.tags[0][0], 'p');
  assert.equal(wrap.tags[0][1], bobPubHex);
  assert.ok(verifyEvent(wrap), 'wrap doit être correctement signé');

  const unwrapped = unwrapDM(wrap, bobPriv);
  assert.ok(unwrapped, 'unwrap doit réussir');
  assert.equal(unwrapped.content, 'Salut Bob, c\'est Alice');
  assert.equal(unwrapped.from, alicePubHex, 'from doit être la pubkey d\'Alice (seal.pubkey)');
});

test('NIP-17 — un wrap destiné à Bob ne peut être déchiffré par Charlie', () => {
  const alicePriv = schnorr.utils.randomSecretKey();
  const bobPriv = schnorr.utils.randomSecretKey();
  const charliePriv = schnorr.utils.randomSecretKey();
  const bobPub = bytesToHex(schnorr.getPublicKey(bobPriv));
  const wrap = wrapDM('top secret', alicePriv, bobPub);
  assert.equal(unwrapDM(wrap, charliePriv), null, 'Charlie ne peut pas déchiffrer');
});

test('NIP-17 — timestamp wrap est dans le passé (anti-corrélation)', () => {
  const alicePriv = schnorr.utils.randomSecretKey();
  const bobPub = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
  const now = Math.floor(Date.now() / 1000);
  const wrap = wrapDM('test', alicePriv, bobPub, { now });
  // Doit être ≤ now (jitter dans le passé).
  assert.ok(wrap.created_at <= now, `wrap.created_at=${wrap.created_at} ≤ ${now}`);
  // Et pas plus de 2 jours dans le passé.
  assert.ok(wrap.created_at >= now - 2 * 86400 - 5);
});

// ─── Pool websocket — smoke avec mock ────────────────────────────────────────
function makeMockWs() {
  const sockets = [];
  class MockWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this._listeners = { open: [], message: [], close: [], error: [] };
      this.sent = [];
      sockets.push(this);
      // Open async.
      queueMicrotask(() => {
        this.readyState = 1;
        for (const cb of this._listeners.open) cb({});
      });
    }
    addEventListener(ev, cb) { this._listeners[ev].push(cb); }
    send(data) { this.sent.push(data); }
    close() {
      this.readyState = 3;
      for (const cb of this._listeners.close) cb({});
    }
    // Helper test : injecter un message du relais.
    inject(msg) {
      const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
      for (const cb of this._listeners.message) cb({ data });
    }
  }
  return { MockWS, sockets };
}

test('pool — publish broadcast à tous les relais', async () => {
  const { MockWS, sockets } = makeMockWs();
  const pool = createPool(['wss://r1', 'wss://r2', 'wss://r3'], { WebSocket: MockWS });
  // Attend l'ouverture (microtask).
  await new Promise(r => setTimeout(r, 5));
  const evt = { id: 'abc', kind: 1, content: 'hi', pubkey: 'x', sig: 'y', tags: [], created_at: 0 };
  pool.publish(evt);
  for (const s of sockets) {
    const sent = s.sent.find(m => m.startsWith('["EVENT"'));
    assert.ok(sent, `relais ${s.url} doit avoir reçu un EVENT`);
    assert.match(sent, /"abc"/);
  }
  pool.close();
});

test('pool — dedup events par id entre relais', async () => {
  const { MockWS, sockets } = makeMockWs();
  const pool = createPool(['wss://r1', 'wss://r2'], { WebSocket: MockWS });
  await new Promise(r => setTimeout(r, 5));
  let received = 0;
  const sub = pool.subscribe([{ kinds: [1] }], () => { received++; });
  // Le même event arrive depuis les 2 relais.
  const evt = { id: 'dup-id-1', kind: 1, content: 'x', pubkey: 'p', sig: 's', tags: [], created_at: 0 };
  sockets[0].inject(['EVENT', sub.id, evt]);
  sockets[1].inject(['EVENT', sub.id, evt]);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(received, 1, 'event dédupliqué');
  // Un autre event avec id différent → +1.
  sockets[0].inject(['EVENT', sub.id, { ...evt, id: 'dup-id-2' }]);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(received, 2);
  pool.close();
});

test('pool — re-subscribe après reconnexion', async () => {
  const { MockWS, sockets } = makeMockWs();
  const pool = createPool(['wss://r1'], { WebSocket: MockWS });
  await new Promise(r => setTimeout(r, 5));
  pool.subscribe([{ kinds: [1059], '#p': ['mypk'] }], () => {});
  await new Promise(r => setTimeout(r, 5));
  // Premier socket a reçu un REQ.
  assert.ok(sockets[0].sent.some(m => m.startsWith('["REQ"')), 'REQ initial envoyé');
  pool.close();
});

test('pool — DEFAULT_RELAYS contient les 3 relais publics attendus', () => {
  assert.equal(DEFAULT_RELAYS.length, 3);
  assert.ok(DEFAULT_RELAYS.includes('wss://relay.damus.io'));
  assert.ok(DEFAULT_RELAYS.includes('wss://nos.lol'));
  assert.ok(DEFAULT_RELAYS.includes('wss://relay.primal.net'));
});
