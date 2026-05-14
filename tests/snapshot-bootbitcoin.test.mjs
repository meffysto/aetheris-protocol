// Test : snapshot replay — un second boot sur la même chain doit (a) écrire
// puis (b) réutiliser le snapshot, et produire un état final identique.
//
// Couvre la régression « le snapshot saute des ticks mais le résultat diverge ».
// Pas de vérification fine du contenu — juste l'égalité bit-à-bit du manifest
// résultant et des identités, comparé entre boot froid et boot tiède.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';
import * as btc from '@scure/btc-signer';

import { bootBitcoin } from '../engine/boot-bitcoin.mjs';
import { buildEnvelopeScript, OP_TYPES } from '../engine/inscribe-core.mjs';
import { initCache } from '../engine/cache.mjs';
import { readText } from './helpers.mjs';

// ─── Cache stateful en mémoire (un Map, contrairement aux autres tests) ─────
function makeStatefulCache() {
  const store = new Map();
  return {
    store,
    adapter: {
      async get(k) { return store.has(k) ? structuredClone(store.get(k)) : null; },
      async set(k, v) { store.set(k, structuredClone(v)); },
      async clear() { store.clear(); },
    },
  };
}

// ─── Chain mock minimale : 2 joins, sur 6 blocs ─────────────────────────────
const GENESIS_BLOCK = 4000000;
const API = 'https://snap.test/api';
const PK_A = new Uint8Array(32).fill(0x11);
const PK_B = new Uint8Array(32).fill(0x22);

function bytesToHex(b) {
  let h = '';
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0');
  return h;
}

function buildScriptHex(opTypeByte, yamlText, pubkey32) {
  const gz = gzipSync(new TextEncoder().encode(yamlText));
  const bytes = buildEnvelopeScript(gz, opTypeByte, pubkey32, btc.Script);
  return bytesToHex(bytes);
}

const CHAIN = new Map();
function addBlock(height, inscriptions = []) {
  const txs = inscriptions.map((ins, i) => ({
    txid: `tx_${height}_${i}`,
    vin: [{ witness: ['ab'.repeat(32), buildScriptHex(ins.opType, ins.yaml, ins.pubkey), 'cc'] }],
  }));
  txs.push({ txid: `tx_${height}_filler`, vin: [{ witness: null }] });
  CHAIN.set(height, { hash: `hash_${height}`, txs });
}
addBlock(GENESIS_BLOCK);
addBlock(GENESIS_BLOCK + 1, [{ opType: OP_TYPES.join, yaml: 'type: join\nversion: 1\njoueur: alice\n', pubkey: PK_A }]);
addBlock(GENESIS_BLOCK + 2, [{ opType: OP_TYPES.join, yaml: 'type: join\nversion: 1\njoueur: bob\n',   pubkey: PK_B }]);
addBlock(GENESIS_BLOCK + 3);
addBlock(GENESIS_BLOCK + 4);
addBlock(GENESIS_BLOCK + 5);

const TIP = GENESIS_BLOCK + 5;

function installMockFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    let m;
    if (u.match(/\/blocks\/tip\/height$/)) {
      return { ok: true, text: async () => String(TIP) };
    }
    if ((m = u.match(/\/block-height\/(\d+)$/))) {
      const h = parseInt(m[1], 10);
      const blk = CHAIN.get(h);
      if (!blk) return { ok: false, status: 404, text: async () => 'no block' };
      return { ok: true, text: async () => blk.hash };
    }
    if ((m = u.match(/\/block\/hash_(\d+)\/txs(?:\/(\d+))?$/))) {
      const h = parseInt(m[1], 10);
      const start = m[2] ? parseInt(m[2], 10) : 0;
      const blk = CHAIN.get(h);
      const all = blk?.txs ?? [];
      return { ok: true, json: async () => all.slice(start, start + 25) };
    }
    return { ok: false, status: 404, text: async () => `not mocked: ${u}` };
  };
  return () => { globalThis.fetch = original; };
}

function makeGenesisYaml() {
  return [
    'version: 1',
    'type: join',
    'serveur: test-snapshot',
    'protocol_version: 0.1',
    'tick: 0',
    'seed: 0xfeedfacecafe1337beef',
    'demarrage_iso: 2026-05-09T00:00:00Z',
    'reseau: mutinynet',
    'parametres:',
    '  tick_source: bitcoin',
    '  blocs_par_tick: 1',
    '  galaxies: 1',
    '  systemes_par_galaxie: 9',
    '  positions_par_systeme: 15',
    '  planetes_max_par_joueur: 9',
    'ancrage:',
    `  bloc_genesis: ${GENESIS_BLOCK}`,
    '  tx_genesis: 0000000000000000000000000000000000000000000000000000000000000000',
    '  reseau_explorer: https://mutinynet.com',
    '',
  ].join('\n');
}

async function bootOnce() {
  return bootBitcoin({
    api: API,
    genesisYaml: makeGenesisYaml(),
    rulesYaml: readText('engine/rules.yaml'),
    galaxieYaml: readText('world/galaxie.yaml'),
    log: () => {},
  });
}

test('snapshot : second boot écrit puis réutilise le snapshot — état final identique', async () => {
  const { adapter, store } = makeStatefulCache();
  initCache(adapter);
  const restoreFetch = installMockFetch();
  try {
    // Premier boot : full replay. Doit écrire le snapshot final.
    const s1 = await bootOnce();
    assert.equal(s1.tickCourant, 5);
    assert.equal(s1.manifest.tick, 5);
    assert.ok(s1.empires.alice, 'alice spawnée au premier boot');
    assert.ok(s1.empires.bob,   'bob spawné au premier boot');

    const snap = store.get('replay-snapshot-v1');
    assert.ok(snap, 'snapshot écrit en cache après boot 1');
    assert.equal(snap.tick, 5, 'snapshot.tick === tickCourant');
    assert.equal(snap.blocGenesis, GENESIS_BLOCK);
    assert.equal(snap.version, 1);

    // Deuxième boot : doit réutiliser le snapshot et arriver au même état.
    const s2 = await bootOnce();
    assert.equal(s2.tickCourant, 5, 'tickCourant identique au second boot');
    assert.equal(s2.manifest.tick, 5);
    assert.deepEqual(
      Object.keys(s2.empires).sort(),
      Object.keys(s1.empires).sort(),
      'mêmes joueurs après reprise sur snapshot'
    );
    assert.equal(
      s2.identites.alice?.cle_publique,
      s1.identites.alice?.cle_publique,
      'identité alice préservée'
    );
    // Le hash de l'état devrait coller à 100 % entre les deux boots.
    assert.equal(s2.manifest.hash_etat, s1.manifest.hash_etat, 'hash_etat identique');
  } finally {
    restoreFetch();
  }
});

test('snapshot : blocGenesis différent → snapshot ignoré (full replay)', async () => {
  const { adapter, store } = makeStatefulCache();
  initCache(adapter);

  // Plant un snapshot avec un autre blocGenesis. Il doit être ignoré.
  store.set('replay-snapshot-v1', {
    version: 1, blocGenesis: 999999, tick: 99,
    manifest: { tick: 99 }, empires: {}, galaxie: {}, identites: {},
    intelByPlayer: {}, alertsByPlayer: {}, battles: [],
  });

  const restoreFetch = installMockFetch();
  try {
    const s = await bootOnce();
    // Si le snapshot avait été pris en compte, manifest.tick serait resté à 99.
    assert.equal(s.manifest.tick, 5, 'snapshot d\'un autre serveur ignoré → full replay');
  } finally {
    restoreFetch();
  }
});

test('snapshot : version supérieure connue → snapshot ignoré', async () => {
  const { adapter, store } = makeStatefulCache();
  initCache(adapter);
  store.set('replay-snapshot-v1', {
    version: 9999, blocGenesis: GENESIS_BLOCK, tick: 99,
    manifest: { tick: 99 }, empires: {}, galaxie: {}, identites: {},
    intelByPlayer: {}, alertsByPlayer: {}, battles: [],
  });

  const restoreFetch = installMockFetch();
  try {
    const s = await bootOnce();
    assert.equal(s.manifest.tick, 5, 'version inconnue → snapshot ignoré → full replay');
  } finally {
    restoreFetch();
  }
});
