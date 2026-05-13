#!/usr/bin/env node
// Wrapper CLI Node — la logique iso est dans inscribe-core.mjs.
//
// Usage:
//   node engine/inscribe.mjs <chemin/vers/ordres.yaml>
//   AETH_NETWORK=mutinynet node engine/inscribe.mjs joueurs/meff/ordres.yaml
//   AETH_FEE_RATE=2 node engine/inscribe.mjs joueurs/meff/ordres.yaml

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  inscribe,
  API_URLS,
  // re-exports pour rétro-compat (importeurs éventuels)
  buildEnvelopeScript,
  detectOpType,
  fetchUTXOs,
  broadcastTx,
  buildCommitTx,
  buildRevealTx,
} from './inscribe-core.mjs';

export {
  inscribe,
  buildEnvelopeScript,
  detectOpType,
  fetchUTXOs,
  broadcastTx,
  buildCommitTx,
  buildRevealTx,
};

const ROOT = path.resolve(import.meta.dirname, '..');

async function main() {
  const argv = process.argv.slice(2);
  const keyIdx = argv.indexOf('--key');
  const keyFile = keyIdx >= 0 ? argv[keyIdx + 1] : (process.env.AETH_KEY_FILE ?? path.join(ROOT, '.btc-key'));
  const yamlPath = argv.find((a, i) => !a.startsWith('--') && (i === 0 || argv[i - 1] !== '--key'));
  if (!yamlPath) {
    console.error('Usage: node engine/inscribe.mjs [--key <path>] <ordres.yaml>');
    process.exit(1);
  }

  const networkName = process.env.AETH_NETWORK ?? 'mutinynet';
  const feeRate = Number(process.env.AETH_FEE_RATE ?? '1');

  const yamlText = await fs.readFile(path.resolve(process.cwd(), yamlPath), 'utf8');
  const keyData = JSON.parse(await fs.readFile(path.resolve(keyFile), 'utf8'));

  if (keyData.network !== networkName && networkName !== 'mutinynet') {
    console.warn(`⚠ Attention: .btc-key est pour ${keyData.network}, AETH_NETWORK=${networkName}`);
  }

  const { schnorr } = await import('@noble/curves/secp256k1');
  const btc = await import('@scure/btc-signer');

  const result = await inscribe({
    yamlText,
    keyData,
    networkName,
    feeRate,
    libs: { btc, schnorr },
    log: (msg) => console.log(msg),
  });

  console.log('\n✓ Inscription publiée sur Bitcoin');
  console.log(`  op_type  : 0x${result.opType.toString(16).padStart(2, '0')}`);
  console.log(`  commit   : ${result.commitTxid}`);
  console.log(`  reveal   : ${result.revealTxid}`);
  console.log(`  explorer : ${API_URLS[networkName].replace('/api', '')}/tx/${result.revealTxid}`);
}

const isMain = process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], import.meta.url).pathname;

if (isMain) {
  main().catch(e => { console.error(e.message ?? e); process.exit(1); });
}
