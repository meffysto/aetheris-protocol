// Test : déterminisme du boot Bitcoin.
//
// Invariant fondamental d'Aetheris (ADR-0005) : deux replays cold-boot
// sur la même chain doivent produire des états bit-à-bit identiques.
// C'est ce qui rend le jeu vérifiable sans backend autoritaire — n'importe
// quel joueur peut auditer l'historique en relançant un boot et obtenir
// le même résultat que tout le monde.
//
// Si ce test casse, c'est que quelque chose dans `runTick` ou les helpers
// (RNG, ordre d'itération, time-dependent code) a introduit du
// non-déterminisme. Casser cet invariant casse aussi les snapshots
// (ADR-0007) parce qu'ils dépendent de la reproductibilité.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';
import * as btc from '@scure/btc-signer';

import { bootBitcoin } from '../engine/boot-bitcoin.mjs';
import { buildEnvelopeScript, OP_TYPES } from '../engine/inscribe-core.mjs';
import { initCache } from '../engine/cache.mjs';
import { canonicalJSON } from '../engine/tick-core.mjs';
import { readText, sha256 } from './helpers.mjs';

// ─── Cache éphémère, vidé entre les boots pour forcer le replay complet ─────
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

// ─── Mini-monde : 3 joueurs, ordres variés sur 8 ticks ──────────────────────
const GENESIS_BLOCK = 5000000;
const API = 'https://detm.test/api';
const PK = {
  alice: new Uint8Array(32).fill(0x11),
  bob:   new Uint8Array(32).fill(0x22),
  carol: new Uint8Array(32).fill(0x33),
};

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

// Bloc 0 = vide. Bloc 1-3 = joins (3 joueurs). Bloc 4-7 = ordres mêlés.
addBlock(GENESIS_BLOCK);
addBlock(GENESIS_BLOCK + 1, [{ opType: OP_TYPES.join, yaml: 'type: join\nversion: 1\njoueur: alice\n', pubkey: PK.alice }]);
addBlock(GENESIS_BLOCK + 2, [{ opType: OP_TYPES.join, yaml: 'type: join\nversion: 1\njoueur: bob\n',   pubkey: PK.bob   }]);
addBlock(GENESIS_BLOCK + 3, [{ opType: OP_TYPES.join, yaml: 'type: join\nversion: 1\njoueur: carol\n', pubkey: PK.carol }]);
// Bloc 4 : alice et bob lancent chacun un chantier_spatial puis mine_ferrum.
addBlock(GENESIS_BLOCK + 4, [
  { opType: OP_TYPES.order, yaml: 'version: 1\njoueur: alice\ntick_cible: 5\nordres:\n  - type: chantier\n    planete: alice-prima\n    batiment: mine_ferrum\n    niveau_cible: 1\n', pubkey: PK.alice },
  { opType: OP_TYPES.order, yaml: 'version: 1\njoueur: bob\ntick_cible: 5\nordres:\n  - type: chantier\n    planete: bob-prima\n    batiment: mine_ferrum\n    niveau_cible: 1\n',   pubkey: PK.bob   },
]);
addBlock(GENESIS_BLOCK + 5);
addBlock(GENESIS_BLOCK + 6, [
  { opType: OP_TYPES.order, yaml: 'version: 1\njoueur: carol\ntick_cible: 7\nordres:\n  - type: chantier\n    planete: carol-prima\n    batiment: extracteur_lumen\n    niveau_cible: 1\n', pubkey: PK.carol },
]);
addBlock(GENESIS_BLOCK + 7);

const TIP = GENESIS_BLOCK + 7;

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
    'serveur: test-determinism',
    'protocol_version: 0.1',
    'tick: 0',
    'seed: 0xdeadbeefcafe1234',
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

async function coldBoot() {
  return bootBitcoin({
    api: API,
    genesisYaml: makeGenesisYaml(),
    rulesYaml: readText('engine/rules.yaml'),
    galaxieYaml: readText('world/galaxie.yaml'),
    log: () => {},
  });
}

// Hash canonique d'un boot : empires + manifest.hash_etat + identités.
// canonicalJSON garantit un ordre de clés stable.
function fingerprint(boot) {
  return sha256(canonicalJSON({
    empires: boot.empires,
    manifest_hash: boot.manifest.hash_etat,
    manifest_tick: boot.manifest.tick,
    identites: boot.identites,
  }));
}

test('déterminisme : deux cold-boots sur la même chain produisent un état identique', async () => {
  const restoreFetch = installMockFetch();
  try {
    // Boot 1 : cache vide.
    const cache1 = makeStatefulCache();
    initCache(cache1.adapter);
    const b1 = await coldBoot();
    const f1 = fingerprint(b1);

    // Boot 2 : nouveau cache vide → vrai cold replay.
    const cache2 = makeStatefulCache();
    initCache(cache2.adapter);
    const b2 = await coldBoot();
    const f2 = fingerprint(b2);

    assert.equal(f1, f2,
      `deux boots froids → empreintes différentes (b1=${f1.slice(0, 16)}… b2=${f2.slice(0, 16)}…). Non-déterminisme dans runTick ou helpers RNG.`);
    // Sanity : le hash_etat du manifest devrait aussi coller.
    assert.equal(b1.manifest.hash_etat, b2.manifest.hash_etat,
      'manifest.hash_etat doit être identique entre deux boots');
    // Et les empires reconstruits doivent être deep-equal.
    assert.deepEqual(b1.empires, b2.empires, 'empires identiques');
  } finally {
    restoreFetch();
  }
});

test('déterminisme : tickCourant et roster identiques entre boots', async () => {
  const restoreFetch = installMockFetch();
  try {
    const cache1 = makeStatefulCache();
    initCache(cache1.adapter);
    const b1 = await coldBoot();

    const cache2 = makeStatefulCache();
    initCache(cache2.adapter);
    const b2 = await coldBoot();

    assert.equal(b1.tickCourant, b2.tickCourant);
    assert.equal(b1.blocGenesis, b2.blocGenesis);
    assert.deepEqual(
      [...b1.roster].sort(),
      [...b2.roster].sort(),
      'roster Nostr (= pubkeys joueurs) identique'
    );
  } finally {
    restoreFetch();
  }
});
