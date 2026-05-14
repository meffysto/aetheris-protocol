// RNG déterministe (xoshiro128**) + sérialisation canonique pour hashes.
// Iso Node/navigateur via @noble/hashes.
//
// Pourquoi xoshiro128** : rapide, qualité statistique correcte, état 128 bits
// donc seedable à partir d'un sha256 sans perte.
//
// `rngFromSeed(seedStr)` → fonction `() => uint32` reproductible bit-à-bit.
// `canonicalJSON(value)` → string déterministe pour signer/hasher.
// `sha256Hex(text)` → hex 64 chars d'un sha256 utf-8.

import { sha256 } from '@noble/hashes/sha256';

export function rngFromSeed(seedStr) {
  const h = sha256(new TextEncoder().encode(seedStr));
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  let s0 = dv.getUint32(0, true), s1 = dv.getUint32(4, true),
      s2 = dv.getUint32(8, true), s3 = dv.getUint32(12, true);
  function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
  return function rng() {
    const result = (rotl(Math.imul(s1, 5), 7) * 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t; s3 = rotl(s3, 11);
    return result / 0x100000000;
  };
}

export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

export function sha256Hex(text) {
  const bytes = sha256(new TextEncoder().encode(text));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
