// CITADEL // PROTOCOL — Messagerie Nostr (NIP-44 v2 + NIP-17 gift-wrap).
//
// Implémentation iso (Node + navigateur) en pur @noble. Aucune dépendance
// externe à nostr-tools. ChaCha20 RFC 8439 inclus inline (pas de @noble/ciphers).
//
// Ce module n'expose QUE la crypto + l'enveloppe Nostr. Pas de WebSocket,
// pas de stockage, pas d'UI — voir nostr-pool.mjs et la console pour ça.

import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { expand as hkdfExpand } from '@noble/hashes/hkdf';

// ─────────────────────────────────────────────────────────────────────────────
// Utilitaires bas niveau
// ─────────────────────────────────────────────────────────────────────────────

const utf8 = new TextEncoder();
const utf8d = new TextDecoder('utf-8', { fatal: true });

export function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(h) {
  if (typeof h !== 'string' || h.length % 2) throw new Error('hex invalide');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function concatBytes(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(out);
  } else {
    // Fallback Node ancien — improbable car >=20.
    const c = require('node:crypto');
    out.set(c.randomBytes(n));
  }
  return out;
}

// Base64 std (avec padding) — iso Node/Browser.
function b64encode(bytes) {
  if (typeof btoa === 'function') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  return Buffer.from(bytes).toString('base64');
}
function b64decode(str) {
  if (typeof atob === 'function') {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(str, 'base64'));
}

// ─────────────────────────────────────────────────────────────────────────────
// ChaCha20 (RFC 8439) — implémentation minimale.
// Stream cipher 256-bit key, 96-bit nonce, 32-bit counter (départ 0).
// ─────────────────────────────────────────────────────────────────────────────

function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

function chachaQuarterRound(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 7);
}

function chachaBlock(key32, counter, nonce12) {
  // État initial : 4 mots constants + 8 mots clé + 1 mot compteur + 3 mots nonce.
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  const kv = new DataView(key32.buffer, key32.byteOffset, 32);
  for (let i = 0; i < 8; i++) s[4 + i] = kv.getUint32(i * 4, true);
  s[12] = counter >>> 0;
  const nv = new DataView(nonce12.buffer, nonce12.byteOffset, 12);
  s[13] = nv.getUint32(0, true);
  s[14] = nv.getUint32(4, true);
  s[15] = nv.getUint32(8, true);

  const w = s.slice();
  for (let i = 0; i < 10; i++) {
    chachaQuarterRound(w, 0, 4, 8, 12);
    chachaQuarterRound(w, 1, 5, 9, 13);
    chachaQuarterRound(w, 2, 6, 10, 14);
    chachaQuarterRound(w, 3, 7, 11, 15);
    chachaQuarterRound(w, 0, 5, 10, 15);
    chachaQuarterRound(w, 1, 6, 11, 12);
    chachaQuarterRound(w, 2, 7, 8, 13);
    chachaQuarterRound(w, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) w[i] = (w[i] + s[i]) >>> 0;

  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) ov.setUint32(i * 4, w[i], true);
  return out;
}

export function chacha20(key, nonce, data, counter = 0) {
  if (key.length !== 32) throw new Error('chacha20: clé 32 octets requise');
  if (nonce.length !== 12) throw new Error('chacha20: nonce 12 octets requis');
  const out = new Uint8Array(data.length);
  let c = counter >>> 0;
  for (let off = 0; off < data.length; off += 64) {
    const block = chachaBlock(key, c++, nonce);
    const end = Math.min(64, data.length - off);
    for (let i = 0; i < end; i++) out[off + i] = data[off + i] ^ block[i];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// NIP-44 v2
// ─────────────────────────────────────────────────────────────────────────────

const NIP44_VERSION = 0x02;
const NIP44_SALT = utf8.encode('nip44-v2');
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 65535;

/**
 * Calcule la longueur paddée selon la spec NIP-44.
 * Borne basse 32, puis bucket = next_power_of_2 / 8 (ou 32 si <= 256).
 */
export function calcPaddedLen(unpaddedLen) {
  if (unpaddedLen <= 0) throw new Error('plaintext vide interdit');
  if (unpaddedLen <= 32) return 32;
  // nextPow = 2^ceil(log2(unpaddedLen))
  let nextPow = 1;
  while (nextPow < unpaddedLen) nextPow <<= 1;
  // Pour len-1 : on cherche le bucket qui contient unpaddedLen.
  // Spec : nextPower = 2 ** (floor(log2(len-1)) + 1)
  let np = 1;
  while (np < unpaddedLen) np <<= 1;
  const chunk = np <= 256 ? 32 : np / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

/**
 * Conversation key NIP-44 = HKDF-extract(salt="nip44-v2", IKM=ECDH_x).
 * Note : pour Nostr, recipientPub est x-only (32B) → on préfixe 0x02.
 */
export function getConversationKey(senderPriv, recipientPubXOnly) {
  if (recipientPubXOnly.length === 33) {
    // Déjà compressée (préfixe 02/03) — on accepte.
    recipientPubXOnly = recipientPubXOnly.slice(1);
  }
  if (recipientPubXOnly.length !== 32) {
    throw new Error('recipient pubkey doit être 32 bytes (x-only)');
  }
  // BIP340 : la pubkey x-only correspond au point dont y est pair (préfixe 02).
  // Si ce point n'est pas sur la courbe, on ne peut pas faire ECDH.
  const compressed = concatBytes(new Uint8Array([0x02]), recipientPubXOnly);
  const shared = secp256k1.getSharedSecret(senderPriv, compressed, true);
  // shared = 33 bytes (préfixe parité || X). NIP-44 prend X uniquement.
  const sharedX = shared.slice(1);
  // HKDF-extract = HMAC(salt, IKM)
  return hmac(sha256, NIP44_SALT, sharedX);
}

/** Dérive (chacha_key, chacha_nonce, hmac_key) depuis (conversationKey, nonce). */
export function getMessageKeys(conversationKey, nonce) {
  if (conversationKey.length !== 32) throw new Error('conversation key invalide');
  if (nonce.length !== 32) throw new Error('nonce 32B requis');
  const okm = hkdfExpand(sha256, conversationKey, nonce, 76);
  return {
    chachaKey: okm.slice(0, 32),
    chachaNonce: okm.slice(32, 44),
    hmacKey: okm.slice(44, 76),
  };
}

function pad(plaintext) {
  const utf8Bytes = utf8.encode(plaintext);
  const unpaddedLen = utf8Bytes.length;
  if (unpaddedLen < MIN_PLAINTEXT) throw new Error('plaintext trop court');
  if (unpaddedLen > MAX_PLAINTEXT) throw new Error('plaintext trop long');
  const paddedLen = calcPaddedLen(unpaddedLen);
  const out = new Uint8Array(2 + paddedLen);
  // Préfixe big-endian 16 bits = unpadded length.
  out[0] = (unpaddedLen >>> 8) & 0xff;
  out[1] = unpaddedLen & 0xff;
  out.set(utf8Bytes, 2);
  return out;
}

function unpad(padded) {
  if (padded.length < 2) throw new Error('padded trop court');
  const unpaddedLen = (padded[0] << 8) | padded[1];
  if (unpaddedLen < MIN_PLAINTEXT || unpaddedLen > MAX_PLAINTEXT) {
    throw new Error('longueur unpadded invalide');
  }
  const expectedTotal = 2 + calcPaddedLen(unpaddedLen);
  if (padded.length !== expectedTotal) {
    throw new Error('taille paddée incohérente');
  }
  const slice = padded.slice(2, 2 + unpaddedLen);
  return utf8d.decode(slice);
}

function hmacAad(hmacKey, ciphertext, aad) {
  if (aad.length !== 32) throw new Error('AAD doit être 32 bytes (nonce)');
  return hmac(sha256, hmacKey, concatBytes(aad, ciphertext));
}

/**
 * Chiffre `plaintext` (string UTF-8) → payload base64 NIP-44 v2.
 * Si `nonceOverride` fourni (32B), l'utilise (utile pour tests vectoriels).
 */
export function encryptNip44(plaintext, senderPriv, recipientPub, nonceOverride) {
  const conv = getConversationKey(senderPriv, recipientPub);
  return encryptWithConversationKey(plaintext, conv, nonceOverride);
}

export function encryptWithConversationKey(plaintext, conversationKey, nonceOverride) {
  const nonce = nonceOverride ?? randomBytes(32);
  if (nonce.length !== 32) throw new Error('nonce 32B requis');
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const padded = pad(plaintext);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = hmacAad(hmacKey, ciphertext, nonce);
  const payload = concatBytes(new Uint8Array([NIP44_VERSION]), nonce, ciphertext, mac);
  return b64encode(payload);
}

export function decryptNip44(payloadB64, recipientPriv, senderPub) {
  const conv = getConversationKey(recipientPriv, senderPub);
  return decryptWithConversationKey(payloadB64, conv);
}

export function decryptWithConversationKey(payloadB64, conversationKey) {
  if (typeof payloadB64 !== 'string') throw new Error('payload doit être string b64');
  if (payloadB64.length === 0 || payloadB64[0] === '#') {
    throw new Error('payload non chiffrable (préfixe interdit)');
  }
  const payload = b64decode(payloadB64);
  if (payload.length < 1 + 32 + 32 + 32) throw new Error('payload trop court');
  if (payload[0] !== NIP44_VERSION) throw new Error('version NIP-44 inconnue');
  const nonce = payload.slice(1, 33);
  const mac = payload.slice(payload.length - 32);
  const ciphertext = payload.slice(33, payload.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const expectedMac = hmacAad(hmacKey, ciphertext, nonce);
  if (!constTimeEq(mac, expectedMac)) throw new Error('MAC invalide');
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  return unpad(padded);
}

function constTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
