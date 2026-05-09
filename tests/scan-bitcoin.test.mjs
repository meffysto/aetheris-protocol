// Vérifie que scanRange en mode parallèle (concurrency > 1) retourne
// EXACTEMENT le même set d'inscriptions que le mode séquentiel (concurrency = 1).
//
// Stratégie : mock global.fetch avec des blocs synthétiques (mix de tx vides et
// d'une tx contenant un witness Citadel valide). On compare les sets résultants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';

import { scanRange, fetchBlockTxsBatch } from '../engine/scan-bitcoin.mjs';

// ─── construction d'un witness Citadel valide ───────────────────────────────

function buildCitadelScriptHex(opTypeByte, yamlStr) {
  const payload = gzipSync(new TextEncoder().encode(yamlStr));
  // Pubkey de 32 bytes (factice)
  const pubkey = new Uint8Array(32).fill(0xab);

  // Construction des bytes du script :
  //   0x20 <pubkey:32> 0xac 0x00 0x63 0x04 "aeth" 0x01 0x01 0x01 <opType>
  //   <push payload> 0x68
  const parts = [];
  parts.push(0x20);
  for (const b of pubkey) parts.push(b);
  parts.push(0xac, 0x00, 0x63);
  parts.push(0x04, 0x61, 0x65, 0x74, 0x68); // "aeth"
  parts.push(0x01, 0x01);                    // version = 1
  parts.push(0x01, opTypeByte);              // op_type

  // Push du payload (PUSHDATA2 si > 75 bytes, sinon OP_DATA_N)
  if (payload.length <= 0x4b) {
    parts.push(payload.length);
    for (const b of payload) parts.push(b);
  } else if (payload.length <= 0xff) {
    parts.push(0x4c, payload.length);
    for (const b of payload) parts.push(b);
  } else {
    parts.push(0x4d, payload.length & 0xff, (payload.length >> 8) & 0xff);
    for (const b of payload) parts.push(b);
  }
  parts.push(0x68); // OP_ENDIF

  return parts.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── monde Esplora simulé ────────────────────────────────────────────────────

const N_BLOCKS = 5;
const FROM = 1000;
const TO = FROM + N_BLOCKS - 1;
const API = 'https://mock.test/api';

// Pour chaque hauteur on fabrique un hash et un set de tx.
function blockHashFor(height) { return `hash_${height}`; }

function makeBlockTxs(height) {
  // 27 tx pour forcer 2 pages (25 + 2). Une tx du milieu porte une inscription.
  const txs = [];
  for (let i = 0; i < 27; i++) {
    const isCarrier = i === 13;
    const yaml = `op: order\nblock: ${height}\nidx: ${i}\n`;
    txs.push({
      txid: `tx_${height}_${i}`,
      vin: [{
        witness: isCarrier
          ? ['ab'.repeat(32), buildCitadelScriptHex(0x02, yaml), 'cc']
          : null,
      }],
    });
  }
  return txs;
}

const FIXTURES = new Map(); // height -> txs[]
for (let h = FROM; h <= TO; h++) FIXTURES.set(h, makeBlockTxs(h));

function installMockFetch() {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    // /block-height/:h
    let m = u.match(/\/block-height\/(\d+)$/);
    if (m) return { ok: true, text: async () => blockHashFor(parseInt(m[1], 10)) };
    // /block/:hash/txs[/:start]
    m = u.match(/\/block\/hash_(\d+)\/txs(?:\/(\d+))?$/);
    if (m) {
      const h = parseInt(m[1], 10);
      const start = m[2] ? parseInt(m[2], 10) : 0;
      const all = FIXTURES.get(h) ?? [];
      return { ok: true, json: async () => all.slice(start, start + 25) };
    }
    return { ok: false, status: 404, text: async () => `not mocked: ${u}` };
  };
  return () => { global.fetch = original; };
}

// ─── tests ───────────────────────────────────────────────────────────────────

test('fetchBlockTxsBatch pagine correctement (>25 tx)', async () => {
  const restore = installMockFetch();
  try {
    const txs = await fetchBlockTxsBatch(blockHashFor(FROM), API);
    assert.equal(txs.length, 27);
    assert.equal(txs[0].txid, `tx_${FROM}_0`);
    assert.equal(txs[26].txid, `tx_${FROM}_26`);
  } finally { restore(); }
});

test('scanRange parallèle (K=12) === scanRange séquentiel (K=1) en set d\'inscriptions', async () => {
  const restore = installMockFetch();
  try {
    const seq = [];
    for await (const ins of scanRange(FROM, TO, { api: API, concurrency: 1 })) seq.push(ins);

    const par = [];
    for await (const ins of scanRange(FROM, TO, { api: API, concurrency: 12 })) par.push(ins);

    // Même nombre d'inscriptions (1 par bloc dans nos fixtures).
    assert.equal(seq.length, N_BLOCKS, 'séquentiel : 1 inscription/bloc');
    assert.equal(par.length, seq.length, 'parallèle : même nombre que séquentiel');

    // Même set (clé = txid + opType + yaml).
    const key = ins => `${ins.txid}|${ins.opType}|${ins.yaml}`;
    const seqSet = new Set(seq.map(key));
    const parSet = new Set(par.map(key));
    assert.equal(parSet.size, seqSet.size);
    for (const k of seqSet) assert.ok(parSet.has(k), `manque dans parallèle : ${k}`);

    // Tous les opType valent 'order' dans nos fixtures.
    for (const ins of par) assert.equal(ins.opType, 'order');
  } finally { restore(); }
});

test('scanRange appelle onBlock pour chaque bloc de la plage (parallèle)', async () => {
  const restore = installMockFetch();
  try {
    const seen = new Set();
    for await (const _ of scanRange(FROM, TO, {
      api: API, concurrency: 4,
      onBlock: h => seen.add(h),
    })) { /* drain */ }
    for (let h = FROM; h <= TO; h++) assert.ok(seen.has(h), `onBlock manqué pour ${h}`);
  } finally { restore(); }
});
