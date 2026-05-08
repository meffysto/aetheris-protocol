#!/usr/bin/env node
// Publie un YAML d'ordres Aetheris comme inscription tapscript sur Bitcoin.
// Deux transactions : commit (réserve le slot) + reveal (publie le contenu).
//
// Usage:
//   node engine/inscribe.mjs <chemin/vers/ordres.yaml>
//   AETH_NETWORK=mutinynet node engine/inscribe.mjs joueurs/meff/ordres.yaml
//   AETH_FEE_RATE=2 node engine/inscribe.mjs joueurs/meff/ordres.yaml
//
// Isomorphique : pas de fs dans la logique de construction des TX.
// fs est utilisé uniquement pour lire le YAML et le wallet en haut du script.

import fs from 'node:fs/promises';
import path from 'node:path';

// ─── config ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const NETWORKS = {
  mainnet:   { bech32: 'bc',  pubKeyHash: 0,   scriptHash: 5,   wif: 128 },
  signet:    { bech32: 'tb',  pubKeyHash: 111, scriptHash: 196, wif: 239 },
  mutinynet: { bech32: 'tb',  pubKeyHash: 111, scriptHash: 196, wif: 239 },
};
const API_URLS = {
  mainnet:   'https://blockstream.info/api',
  signet:    'https://mutinynet.com/api',
  mutinynet: 'https://mutinynet.com/api',
};

const networkName = process.env.AETH_NETWORK ?? 'mutinynet';
const feeRate = Number(process.env.AETH_FEE_RATE ?? '1'); // sat/vB
const network = NETWORKS[networkName];
const API = API_URLS[networkName];

if (!network) {
  console.error(`Réseau inconnu: ${networkName}`);
  process.exit(1);
}

// ─── op_type mapping ─────────────────────────────────────────────────────────

const OP_TYPES = { join: 0x01, order: 0x02, sealed: 0x03, reveal: 0x04 };

// ─── envelope : logique isomorphique (pas de fs) ─────────────────────────────

/**
 * Construit le script tapscript de l'envelope Aetheris.
 *
 * Structure (style Ordinals) :
 *   <pubkey> OP_CHECKSIG          ← valide la signature, laisse 1 sur le stack
 *   OP_FALSE OP_IF                ← bloc jamais exécuté (OP_FALSE = 0)
 *     "aeth" 0x01 <op_type> <gzip(yaml)>
 *   OP_ENDIF
 *
 * Le OP_FALSE OP_IF est un no-op ; les données sont embarquées dans le script
 * pour être indexées, sans être exécutées.
 *
 * @param {Uint8Array} gzippedYaml
 * @param {number} opTypeByte  0x01..0x04
 * @param {Uint8Array} signerPubKey  32-byte schnorr pubkey
 * @param Script  @scure/btc-signer Script codec
 * @returns {Uint8Array} script bytes
 */
export function buildEnvelopeScript(gzippedYaml, opTypeByte, signerPubKey, Script) {
  const tag = new TextEncoder().encode('aeth');
  const version = new Uint8Array([0x01]);
  const opType = new Uint8Array([opTypeByte]);

  // Bitcoin script limite les pushes à 520 bytes.
  const MAX_PUSH = 520;
  const chunks = [];
  for (let i = 0; i < gzippedYaml.length; i += MAX_PUSH) {
    chunks.push(gzippedYaml.slice(i, i + MAX_PUSH));
  }

  return Script.encode([
    signerPubKey,   // push 32-byte schnorr pubkey
    'CHECKSIG',     // OP_CHECKSIG — valide la signature tapscript
    0,              // OP_FALSE (OP_0) — no-op envelope follows
    'IF',
    tag,
    version,
    opType,
    ...chunks,
    'ENDIF',
  ]);
}

/**
 * Détecte l'op_type depuis le contenu YAML (champ `type` ou root key).
 * @param {string} yamlText
 * @returns {number}
 */
export function detectOpType(yamlText) {
  const m = yamlText.match(/^type:\s*(\w+)/m);
  const t = m?.[1]?.toLowerCase();
  return OP_TYPES[t] ?? OP_TYPES.order;
}

// ─── Esplora API helpers (isomorphiques, fetch uniquement) ───────────────────

export async function fetchUTXOs(address, apiBase = API) {
  const res = await fetch(`${apiBase}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`fetchUTXOs: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function broadcastTx(txHex, apiBase = API) {
  const res = await fetch(`${apiBase}/tx`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: txHex,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`broadcastTx: ${res.status} ${text}`);
  return text.trim(); // txid
}

// ─── construction des TX (isomorphique) ──────────────────────────────────────

/**
 * Construit la TX commit : P2TR vers l'adresse du leaf script.
 * Retourne { tx, commitAddress, commitScript, leaves }
 */
export function buildCommitTx({
  senderPubKey,       // Uint8Array (32 bytes schnorr)
  leafScript,         // Uint8Array
  utxos,              // [{ txid, vout, value }]
  changeAddress,      // string bech32
  dustLimit = 546,    // sats
  feeRateSatVb = 1,
  network,
  libs,               // { p2tr, TAPROOT_UNSPENDABLE_KEY, Transaction }
}) {
  const { p2tr, TAPROOT_UNSPENDABLE_KEY, Transaction } = libs;

  const leaf = { script: leafScript, leafVersion: 0xc0 };
  const commitPayment = p2tr(TAPROOT_UNSPENDABLE_KEY, [leaf], network, true);
  const commitValue = dustLimit; // minimum pour que la reveal puisse le dépenser

  // Estimation fee : commit TX ~150 vB
  const estimatedFee = Math.ceil(150 * feeRateSatVb);
  const totalNeeded = commitValue + estimatedFee;

  // Choisir les UTXOs
  let inputTotal = 0;
  const selectedUTXOs = [];
  for (const u of utxos) {
    selectedUTXOs.push(u);
    inputTotal += u.value;
    if (inputTotal >= totalNeeded) break;
  }
  if (inputTotal < totalNeeded) {
    throw new Error(`Fonds insuffisants: besoin ${totalNeeded} sats, disponible ${inputTotal} sats`);
  }

  const senderPayment = p2tr(senderPubKey, undefined, network);
  const tx = new Transaction();

  for (const u of selectedUTXOs) {
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: {
        script: senderPayment.script,
        amount: BigInt(u.value),
      },
      tapInternalKey: senderPubKey,
    });
  }

  // Output 0 : commit address
  tx.addOutputAddress(commitPayment.address, BigInt(commitValue), network);

  // Output 1 : change (si suffisant)
  const change = inputTotal - commitValue - estimatedFee;
  if (change >= dustLimit) {
    tx.addOutputAddress(changeAddress, BigInt(change), network);
  }

  return {
    tx,
    commitPayment,
    commitValue,
    leaf,
  };
}

/**
 * Construit la TX reveal : dépense le commit via script-path, révèle l'envelope.
 */
export function buildRevealTx({
  commitTxid,         // string hex
  commitVout = 0,
  commitValue,        // sats
  commitPayment,      // résultat p2tr (avec .leaves, .tapLeafScript)
  leafScript,         // Uint8Array
  senderPubKey,       // Uint8Array (32 bytes)
  recipientAddress,   // string bech32 — reçoit le dust après fees
  dustLimit = 546,
  feeRateSatVb = 1,
  network,
  libs,
}) {
  const { Transaction } = libs;

  // Estimation fee reveal : witness = [sig(64), leafScript, controlBlock(33)]
  const witnessSize = 64 + leafScript.length + 33;
  // vsize = (non-witness bytes) * 4 + witness bytes) / 4
  // Input non-witness: 41 bytes. Output: 43 bytes. Overhead: 10 bytes.
  const estimatedRevealFee = Math.ceil(((41 + 10 + 43) * 4 + witnessSize + 2) / 4 * feeRateSatVb);

  const revealOutput = commitValue - estimatedRevealFee;
  if (revealOutput < dustLimit) {
    throw new Error(`Dust trop bas après fees reveal: ${revealOutput} sats. Augmente le dust limit ou réduis le fee rate.`);
  }

  // allowUnknownInputs+Outputs nécessaire car notre leaf script est de type "unknown"
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.addInput({
    txid: commitTxid,
    index: commitVout,
    witnessUtxo: {
      script: commitPayment.script,
      amount: BigInt(commitValue),
    },
    tapInternalKey: commitPayment.tapInternalKey,
    tapLeafScript: commitPayment.tapLeafScript,
  });

  tx.addOutputAddress(recipientAddress, BigInt(revealOutput), network);

  return { tx };
}

// ─── main CLI ─────────────────────────────────────────────────────────────────

async function main() {
  const yamlPath = process.argv[2];
  if (!yamlPath) {
    console.error('Usage: node engine/inscribe.mjs <ordres.yaml>');
    process.exit(1);
  }

  const yamlText = await fs.readFile(path.resolve(process.cwd(), yamlPath), 'utf8');
  const keyData = JSON.parse(await fs.readFile(path.join(ROOT, '.btc-key'), 'utf8'));

  if (keyData.network !== networkName && networkName !== 'mutinynet') {
    console.warn(`⚠ Attention: .btc-key est pour ${keyData.network}, AETH_NETWORK=${networkName}`);
  }

  // Imports crypto/libs
  const { gzipSync } = await import('fflate');
  const { schnorr } = await import('@noble/curves/secp256k1');
  const btc = await import('@scure/btc-signer');
  const { Script, p2tr, TAPROOT_UNSPENDABLE_KEY, Transaction, WIF } = btc;

  const privKey = WIF(network).decode(keyData.privateKeyWIF);
  const pubKey = schnorr.getPublicKey(privKey);

  // Gzip du YAML
  const yamlBytes = new TextEncoder().encode(yamlText);
  const gzipped = gzipSync(yamlBytes);

  // Détection op_type
  const opTypeByte = detectOpType(yamlText);

  // Construction du leaf script
  const leafScript = buildEnvelopeScript(gzipped, opTypeByte, pubKey, Script);
  console.log(`leaf script: ${leafScript.length} bytes (yaml gzippé: ${gzipped.length} bytes)`);

  // Fetch UTXOs
  const utxos = await fetchUTXOs(keyData.taprootAddress, API);
  console.log(`UTXOs: ${utxos.length} (total: ${utxos.reduce((s, u) => s + u.value, 0)} sats)`);
  if (utxos.length === 0) {
    console.error('Aucun UTXO. Fonde le wallet :');
    console.error(`  https://faucet.mutinynet.com → ${keyData.taprootAddress}`);
    process.exit(1);
  }

  // TX commit
  const { tx: commitTx, commitPayment, commitValue, leaf } = buildCommitTx({
    senderPubKey: pubKey,
    leafScript,
    utxos,
    changeAddress: keyData.taprootAddress,
    dustLimit: 2000,
    feeRateSatVb: feeRate,
    network,
    libs: { p2tr, TAPROOT_UNSPENDABLE_KEY, Transaction },
  });

  // Signer la commit TX (key-path spend depuis notre adresse principale)
  commitTx.sign(privKey);
  commitTx.finalize();
  const commitHex = commitTx.hex;
  const commitTxid = commitTx.id;
  console.log(`\ncommit TX : ${commitTxid}`);

  // TX reveal
  const { tx: revealTx } = buildRevealTx({
    commitTxid,
    commitVout: 0,
    commitValue,
    commitPayment,
    leafScript,
    senderPubKey: pubKey,
    recipientAddress: keyData.taprootAddress,
    dustLimit: 546,
    feeRateSatVb: feeRate,
    network,
    libs: { Transaction },
  });

  // Signer la reveal TX via script-path
  revealTx.sign(privKey, undefined, new Uint8Array(32));
  revealTx.finalize();
  const revealHex = revealTx.hex;
  const revealTxid = revealTx.id;
  console.log(`reveal TX : ${revealTxid}`);

  // Broadcast les deux TX
  console.log('\nBroadcast commit...');
  const broadcastedCommit = await broadcastTx(commitHex, API);
  console.log(`✓ commit confirmé : ${broadcastedCommit}`);

  console.log('Broadcast reveal...');
  const broadcastedReveal = await broadcastTx(revealHex, API);
  console.log(`✓ reveal confirmé : ${broadcastedReveal}`);

  console.log('\n✓ Inscription publiée sur Bitcoin');
  console.log(`  op_type  : 0x${opTypeByte.toString(16).padStart(2, '0')}`);
  console.log(`  commit   : ${broadcastedCommit}`);
  console.log(`  reveal   : ${broadcastedReveal}`);
  console.log(`  explorer : ${API.replace('/api', '')}/tx/${broadcastedReveal}`);
}

// N'exécute main() que si ce fichier est le point d'entrée direct
const isMain = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], import.meta.url).pathname;

if (isMain) {
  main().catch(e => { console.error(e.message ?? e); process.exit(1); });
}
