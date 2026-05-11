// Test "réel" du wire format sealed/reveal :
// On utilise le VRAI buildEnvelopeScript (inscribe-core) pour produire les bytes,
// puis le VRAI parseWitness (scan-bitcoin) pour les relire.
// Si un jour quelqu'un change le format envelope d'un côté sans l'autre, ce
// test casse — c'est le but.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';

import { buildEnvelopeScript, OP_TYPES } from '../engine/inscribe-core.mjs';
import { parseWitness } from '../engine/scan-bitcoin.mjs';

// Wrapper de Script.encode du vrai btc-signer (le même que inscribe.mjs utilise).
async function loadScript() {
  const btc = await import('@scure/btc-signer');
  return btc.Script;
}

function bytesToHex(bytes) {
  let h = '';
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0');
  return h;
}

const FAKE_PUBKEY = new Uint8Array(32).fill(0xab); // 32B x-only Schnorr factice

async function roundtrip(opTypeByte, yamlText) {
  const Script = await loadScript();
  const gz = gzipSync(new TextEncoder().encode(yamlText));
  const scriptBytes = buildEnvelopeScript(gz, opTypeByte, FAKE_PUBKEY, Script);
  const scriptHex = bytesToHex(scriptBytes);
  // parseWitness reçoit la stack tapscript (le script est l'avant-dernier
  // élément). On simule : [args, script, control_block].
  const witness = ['ab'.repeat(32), scriptHex, 'cc'];
  return parseWitness(witness);
}

test('wire format : sealed (0x03) — buildEnvelopeScript → parseWitness round-trip', async () => {
  const yaml = [
    'type: sealed',
    'version: 1',
    'joueur: attk',
    'tick_depart: 4',
    'tick_impact: 6',
    'planete_origine: attk-base',
    'kind: militaire',
    'hash: 8f4c2a91b3d5e7901111111111111111111111111111111111111111111111ab',
  ].join('\n');

  const parsed = await roundtrip(OP_TYPES.sealed, yaml);
  assert.ok(parsed, 'envelope sealed détectée');
  assert.equal(parsed.opType, 'sealed', 'opType reconnu comme sealed');
  assert.equal(parsed.opTypeByte, 0x03);
  assert.equal(parsed.yaml, yaml, 'YAML survit gzip+envelope+parse intact');
  assert.equal(parsed.inscriberPubKey, bytesToHex(FAKE_PUBKEY), 'pubkey extraite');
});

test('wire format : reveal (0x04) — buildEnvelopeScript → parseWitness round-trip', async () => {
  const yaml = [
    'type: reveal',
    'version: 1',
    'joueur: attk',
    'tick_impact: 6',
    'sealed_txid: deadbeef1234567890',
    'secret:',
    '  type: attaque',
    '  depuis: attk-base',
    '  cible:',
    '    joueur: def',
    '    planete: def-base',
    '  flotte:',
    '    chasseur_leger: 50',
    '  vitesse: 100',
    '  nonce: cafe1234',
  ].join('\n');

  const parsed = await roundtrip(OP_TYPES.reveal, yaml);
  assert.ok(parsed, 'envelope reveal détectée');
  assert.equal(parsed.opType, 'reveal');
  assert.equal(parsed.opTypeByte, 0x04);
  assert.equal(parsed.yaml, yaml);
});

test('wire format : payload large (>520B) chunké en plusieurs pushes', async () => {
  // Crée un YAML avec une grosse flotte pour pousser au-delà du seuil 520B
  // (boundary OP_PUSHDATA), où le code de buildEnvelopeScript chunke.
  const bigFlotte = Array.from({ length: 50 }, (_, i) => `  unite_${i}: ${1000 + i}`).join('\n');
  const yaml = [
    'type: reveal',
    'version: 1',
    'joueur: attk',
    'tick_impact: 6',
    'sealed_txid: aa11',
    'secret:',
    '  type: attaque',
    '  depuis: attk-base',
    '  cible:',
    '    joueur: def',
    '    planete: def-base',
    '  flotte:',
    bigFlotte,
    '  vitesse: 100',
    '  nonce: ff00',
  ].join('\n');

  const parsed = await roundtrip(OP_TYPES.reveal, yaml);
  assert.ok(parsed, 'envelope avec payload large détectée');
  assert.equal(parsed.opType, 'reveal');
  assert.equal(parsed.yaml, yaml, 'YAML chunké recomposé intact');
});

test('OP_TYPES.sealed === 0x03 et OP_TYPES.reveal === 0x04 (contrat stable)', () => {
  assert.equal(OP_TYPES.sealed, 0x03);
  assert.equal(OP_TYPES.reveal, 0x04);
});
