// Test E2E "réel" : boot complet depuis une chain Bitcoin mockée contenant
// join → sealed → reveal. Vérifie que le flux end-to-end fonctionne :
//   - Le scanner reconnaît op_type 0x03 (sealed) et 0x04 (reveal)
//   - bootBitcoin indexe sealed par tick_depart et reveals par tick_impact
//   - La pubkey Schnorr inscripteur est vérifiée contre l'identité du join
//   - Le replay enregistre le sceau dans manifest.sealedPending au tick_depart
//   - Le reveal au tick_impact matche, consomme le sceau, émet reveal-resolu
//
// On n'attend PAS de combat dans cette chain (les empires fraîchement joints
// n'ont pas de flotte starter). La preuve que le combat se résout quand la
// flotte existe est dans tests/sealed.test.mjs. Ici on prouve que le wire
// format + le boot loop traversent correctement le scellement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';
import * as btc from '@scure/btc-signer';

import { bootBitcoin } from '../engine/boot-bitcoin.mjs';
import { buildEnvelopeScript, OP_TYPES } from '../engine/inscribe-core.mjs';
import { computeSealHash } from '../engine/sealed-protocol.mjs';
import { initCache } from '../engine/cache.mjs';
import { readText } from './helpers.mjs';

// ─── adaptateur cache in-memory pour ce test ────────────────────────────────
// bootBitcoin appelle cache.get/set ; sans adapter elles throw mais sont
// déjà wrap try/catch côté boot. On installe quand même un adapter no-op
// pour éviter le warning.
initCache({
  get: async () => null,
  set: async () => {},
  clear: async () => {},
});

// ─── helpers wire format ────────────────────────────────────────────────────

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

// ─── construction d'une mini-chain Esplora ──────────────────────────────────

const GENESIS_BLOCK = 3000000;
const API = 'https://mock.test/api';

// Pubkeys Schnorr factices, distinctes par joueur.
const PK_ATTK = new Uint8Array(32).fill(0xaa);
const PK_DEF  = new Uint8Array(32).fill(0xbb);
const PK_ATTK_HEX = bytesToHex(PK_ATTK);
const PK_DEF_HEX  = bytesToHex(PK_DEF);

// Le secret que attk va sceller puis révéler.
const SECRET = {
  type: 'attaque',
  depuis: 'attk-prima',
  cible: { joueur: 'def', planete: 'def-prima' },
  flotte: { chasseur_leger: 0 },  // 0 → queueAttaque passe sans débit réel
  vitesse: 100,
  nonce: 'deadbeefcafe1234',
};
const SECRET_HASH = computeSealHash(SECRET);

// Une chain où chaque bloc peut porter 0 ou 1 inscription Citadel.
// Avec blocs_par_tick=1, bloc N = tick (N - GENESIS_BLOCK).
const CHAIN = new Map(); // height → { hash, txs }

function addBlock(height, inscriptions = []) {
  const txs = inscriptions.map((ins, i) => ({
    txid: `tx_${height}_${i}`,
    vin: [{
      witness: ['ab'.repeat(32), buildScriptHex(ins.opType, ins.yaml, ins.pubkey), 'cc'],
    }],
  }));
  // Quelques tx vides pour réalisme.
  txs.push({ txid: `tx_${height}_filler`, vin: [{ witness: null }] });
  CHAIN.set(height, { hash: `hash_${height}`, txs });
}

// Tick 0 : genesis (pas d'inscription)
addBlock(GENESIS_BLOCK);
// Tick 1 : join attk
addBlock(GENESIS_BLOCK + 1, [{
  opType: OP_TYPES.join,
  yaml: 'type: join\nversion: 1\njoueur: attk\n',
  pubkey: PK_ATTK,
}]);
// Tick 2 : join def
addBlock(GENESIS_BLOCK + 2, [{
  opType: OP_TYPES.join,
  yaml: 'type: join\nversion: 1\njoueur: def\n',
  pubkey: PK_DEF,
}]);
// Tick 3 : sealed par attk, déclarant tick_depart=4 (PAS de tick_impact public)
//   Note : le sealed est inscrit AVANT son tick_depart (tick 3 < 4) — c'est
//   ainsi qu'on précommit en pratique. Le boot l'indexe par tick_depart=4.
//   spawn déterministe : attk-prima=[1,1,4], def-prima=[1,1,7] → distance=1015,
//   vMin chasseur_leger=12500, flightUTJ=9 → flightTicks=2 → tick_impact=6.
const SEALED_TXID = `tx_${GENESIS_BLOCK + 3}_0`;
addBlock(GENESIS_BLOCK + 3, [{
  opType: OP_TYPES.sealed,
  yaml: [
    'type: sealed',
    'version: 1',
    'joueur: attk',
    'tick_depart: 4',
    'planete_origine: attk-prima',
    'kind: militaire',
    `hash: ${SECRET_HASH}`,
    '',
  ].join('\n'),
  pubkey: PK_ATTK,
}]);
// Tick 4 : empty (flotte en vol)
addBlock(GENESIS_BLOCK + 4);
// Tick 5 : empty (toujours en vol)
addBlock(GENESIS_BLOCK + 5);
// Tick 6 : reveal par attk au tick d'arrivée physique (flightTicks=2)
addBlock(GENESIS_BLOCK + 6, [{
  opType: OP_TYPES.reveal,
  yaml: [
    'type: reveal',
    'version: 1',
    'joueur: attk',
    'tick_impact: 6',
    `sealed_txid: ${SEALED_TXID}`,
    'secret:',
    `  type: ${SECRET.type}`,
    `  depuis: ${SECRET.depuis}`,
    '  cible:',
    `    joueur: ${SECRET.cible.joueur}`,
    `    planete: ${SECRET.cible.planete}`,
    '  flotte:',
    `    chasseur_leger: ${SECRET.flotte.chasseur_leger}`,
    `  vitesse: ${SECRET.vitesse}`,
    `  nonce: ${SECRET.nonce}`,
    '',
  ].join('\n'),
  pubkey: PK_ATTK,
}]);

const TIP = GENESIS_BLOCK + 6;

// ─── mock fetch (Esplora) ───────────────────────────────────────────────────

function installMockFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    let m;
    if ((m = u.match(/\/blocks\/tip\/height$/))) {
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

// ─── genesis YAML personnalisé : 1 bloc / tick pour serrer le scénario ──────

function makeGenesisYaml() {
  return [
    'version: 1',
    'type: join',
    'serveur: test-sealed-e2e',
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

// ─── tests ──────────────────────────────────────────────────────────────────

test('bootBitcoin E2E : join+sealed+reveal sur chain mockée → sealedPending consommé', async () => {
  const restore = installMockFetch();
  try {
    const state = await bootBitcoin({
      api: API,
      genesisYaml: makeGenesisYaml(),
      rulesYaml: readText('engine/rules.yaml'),
      galaxieYaml: readText('world/galaxie.yaml'),
      log: () => {},
    });

    // Le tick courant doit refléter la progression (tip - genesis) / bpt = 6
    assert.equal(state.tickCourant, 6, 'tickCourant = (tip - genesis) / 1');
    assert.equal(state.manifest.tick, 6, 'manifest.tick avancé jusqu\'au tip');

    // Les deux empires sont créés (les joins ont été spawnés)
    assert.ok(state.empires.attk, 'empire attk créé');
    assert.ok(state.empires.def, 'empire def créé');

    // Les identités Bitcoin-natives ont la bonne pubkey Schnorr
    assert.equal(state.identites.attk.cle_publique, `schnorr:${PK_ATTK_HEX}`);
    assert.equal(state.identites.def.cle_publique, `schnorr:${PK_DEF_HEX}`);

    // CŒUR DU TEST : le sealedPending doit être vide à l'arrivée
    //   - tick 4 : sealed enregistré → sealedPending[SEALED_TXID] créé
    //   - tick 5 : flotte en vol, sealed toujours pending
    //   - tick 6 : reveal matché (timing + hash) → sealedPending supprimé
    const pending = state.manifest.sealedPending || {};
    assert.deepEqual(pending, {}, 'sealedPending vide après reveal résolu');
  } finally {
    restore();
  }
});

test('bootBitcoin E2E : reveal absent → sealed reste pending (patience non dépassée)', async () => {
  // Variante : on retire le reveal du bloc 6, le sealed reste sans reveal.
  // Avec le nouveau modèle (sans tick_impact public), le sealed n'expire que
  // si MAX_PATIENCE est dépassé. Sur cette chain courte (6 ticks), patience
  // OK → sceau reste dans pending.
  const saved = CHAIN.get(GENESIS_BLOCK + 6);
  CHAIN.set(GENESIS_BLOCK + 6, { hash: saved.hash, txs: [{ txid: 'tx_filler', vin: [{ witness: null }] }] });

  const restore = installMockFetch();
  try {
    const state = await bootBitcoin({
      api: API,
      genesisYaml: makeGenesisYaml(),
      rulesYaml: readText('engine/rules.yaml'),
      galaxieYaml: readText('world/galaxie.yaml'),
      log: () => {},
    });

    // Sealed encore en attente (patience longue, pas encore dépassée)
    const pending = state.manifest.sealedPending || {};
    assert.ok(pending[SEALED_TXID], 'sealed toujours pending — joueur peut encore reveal');
    assert.equal(pending[SEALED_TXID].joueur, 'attk');
    assert.equal(pending[SEALED_TXID].tick_depart, 4);
  } finally {
    restore();
    CHAIN.set(GENESIS_BLOCK + 6, saved);
  }
});

test('bootBitcoin E2E : reveal d\'un autre joueur → REJETÉ (pubkey mismatch)', async () => {
  // Variante : on remplace le reveal par un reveal signé avec PK_DEF (au lieu
  // de PK_ATTK). Le scanner accepte l'inscription, mais boot doit la rejeter
  // car pubkey inscripteur ≠ identité 'attk' (le reveal prétend être de attk).
  const original = CHAIN.get(GENESIS_BLOCK + 6);
  const revealYaml = [
    'type: reveal',
    'version: 1',
    'joueur: attk',
    'tick_impact: 6',
    `sealed_txid: ${SEALED_TXID}`,
    'secret:',
    `  type: ${SECRET.type}`,
    `  depuis: ${SECRET.depuis}`,
    '  cible:',
    `    joueur: ${SECRET.cible.joueur}`,
    `    planete: ${SECRET.cible.planete}`,
    '  flotte:',
    `    chasseur_leger: ${SECRET.flotte.chasseur_leger}`,
    `  vitesse: ${SECRET.vitesse}`,
    `  nonce: ${SECRET.nonce}`,
    '',
  ].join('\n');
  // Signe avec la mauvaise pubkey
  CHAIN.set(GENESIS_BLOCK + 6, {
    hash: original.hash,
    txs: [{
      txid: 'tx_imposter',
      vin: [{ witness: ['ab'.repeat(32), buildScriptHex(OP_TYPES.reveal, revealYaml, PK_DEF), 'cc'] }],
    }],
  });

  const restore = installMockFetch();
  try {
    const state = await bootBitcoin({
      api: API,
      genesisYaml: makeGenesisYaml(),
      rulesYaml: readText('engine/rules.yaml'),
      galaxieYaml: readText('world/galaxie.yaml'),
      log: () => {},
    });

    // Reveal rejeté à l'étape pubkey, AVANT d'arriver au moteur → sealed
    // reste pending (la patience n'est pas dépassée sur 6 ticks).
    const pending = state.manifest.sealedPending || {};
    assert.ok(pending[SEALED_TXID], 'sceau toujours pending — reveal imposteur ignoré sans consommation');
  } finally {
    restore();
    CHAIN.set(GENESIS_BLOCK + 6, original);
  }
});
