// Logique iso d'inscription Aetheris — pas de node:*, pas de process.
// Importable depuis Node ou navigateur.
//
// Exports :
//   - buildEnvelopeScript, detectOpType  (envelope tapscript)
//   - fetchUTXOs, broadcastTx            (Esplora I/O via fetch)
//   - buildCommitTx, buildRevealTx       (construction TX)
//   - inscribe                           (flow complet : commit + reveal)
//
// Réseaux supportés (via NETWORKS / API_URLS).

import { gzipSync } from 'fflate';

export const NETWORKS = {
  mainnet:   { bech32: 'bc',  pubKeyHash: 0,   scriptHash: 5,   wif: 128 },
  signet:    { bech32: 'tb',  pubKeyHash: 111, scriptHash: 196, wif: 239 },
  mutinynet: { bech32: 'tb',  pubKeyHash: 111, scriptHash: 196, wif: 239 },
};

export const API_URLS = {
  mainnet:   'https://blockstream.info/api',
  signet:    'https://mutinynet.com/api',
  mutinynet: 'https://mutinynet.com/api',
};

export const OP_TYPES = { join: 0x01, order: 0x02, sealed: 0x03, reveal: 0x04 };

// ─── envelope ────────────────────────────────────────────────────────────────

/**
 * Tapscript envelope :
 *   <pubkey> OP_CHECKSIG OP_FALSE OP_IF "aeth" 0x01 <op_type> <gzip(yaml)> OP_ENDIF
 */
export function buildEnvelopeScript(gzippedYaml, opTypeByte, signerPubKey, Script) {
  const tag = new TextEncoder().encode('aeth');
  const version = new Uint8Array([0x01]);
  const opType = new Uint8Array([opTypeByte]);

  const MAX_PUSH = 520;
  const chunks = [];
  for (let i = 0; i < gzippedYaml.length; i += MAX_PUSH) {
    chunks.push(gzippedYaml.slice(i, i + MAX_PUSH));
  }

  return Script.encode([
    signerPubKey,
    'CHECKSIG',
    0,
    'IF',
    tag,
    version,
    opType,
    ...chunks,
    'ENDIF',
  ]);
}

export function detectOpType(yamlText) {
  const m = yamlText.match(/^type:\s*(\w+)/m);
  const t = m?.[1]?.toLowerCase();
  return OP_TYPES[t] ?? OP_TYPES.order;
}

// ─── Esplora I/O ─────────────────────────────────────────────────────────────

export async function fetchUTXOs(address, apiBase) {
  const res = await fetch(`${apiBase}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`fetchUTXOs: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function broadcastTx(txHex, apiBase) {
  const res = await fetch(`${apiBase}/tx`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: txHex,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`broadcastTx: ${res.status} ${text}`);
  return text.trim();
}

// ─── construction TX ─────────────────────────────────────────────────────────

export function buildCommitTx({
  senderPubKey, leafScript, utxos, changeAddress,
  dustLimit = 546, feeRateSatVb = 1, network, libs,
}) {
  const { p2tr, TAPROOT_UNSPENDABLE_KEY, Transaction } = libs;
  const leaf = { script: leafScript, leafVersion: 0xc0 };
  const commitPayment = p2tr(TAPROOT_UNSPENDABLE_KEY, [leaf], network, true);
  const commitValue = dustLimit;

  const estimatedFee = Math.ceil(150 * feeRateSatVb);
  const totalNeeded = commitValue + estimatedFee;

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
      witnessUtxo: { script: senderPayment.script, amount: BigInt(u.value) },
      tapInternalKey: senderPubKey,
    });
  }
  tx.addOutputAddress(commitPayment.address, BigInt(commitValue), network);
  const change = inputTotal - commitValue - estimatedFee;
  if (change >= dustLimit) tx.addOutputAddress(changeAddress, BigInt(change), network);
  return { tx, commitPayment, commitValue, leaf };
}

export function buildRevealTx({
  commitTxid, commitVout = 0, commitValue, commitPayment, leafScript,
  senderPubKey, recipientAddress, dustLimit = 546, feeRateSatVb = 1, network, libs,
}) {
  const { Transaction } = libs;
  const witnessSize = 64 + leafScript.length + 33;
  const estimatedRevealFee = Math.ceil(((41 + 10 + 43) * 4 + witnessSize + 2) / 4 * feeRateSatVb);
  const revealOutput = commitValue - estimatedRevealFee;
  if (revealOutput < dustLimit) {
    throw new Error(`Dust trop bas après fees reveal: ${revealOutput} sats.`);
  }

  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.addInput({
    txid: commitTxid,
    index: commitVout,
    witnessUtxo: { script: commitPayment.script, amount: BigInt(commitValue) },
    tapInternalKey: commitPayment.tapInternalKey,
    tapLeafScript: commitPayment.tapLeafScript,
  });
  tx.addOutputAddress(recipientAddress, BigInt(revealOutput), network);
  return { tx };
}

// ─── flow complet ────────────────────────────────────────────────────────────

/**
 * Inscrit un YAML sur Bitcoin (commit + reveal).
 *
 * @param {object} opts
 * @param {string} opts.yamlText           Contenu YAML à inscrire
 * @param {object} opts.keyData            { privateKeyWIF, taprootAddress, network }
 * @param {string} [opts.networkName]      'mainnet' | 'signet' | 'mutinynet'
 * @param {number} [opts.feeRate]          sat/vB (default 1)
 * @param {object} opts.libs               { btc, schnorr } — fournis par l'appelant
 * @param {function} [opts.log]            (msg) => void
 * @returns {Promise<{commitTxid, revealTxid, opType, leafScriptSize, gzippedSize}>}
 */
export async function inscribe({
  yamlText, keyData, networkName = 'mutinynet', feeRate = 1, libs, log = () => {},
}) {
  const network = NETWORKS[networkName];
  const API = API_URLS[networkName];
  if (!network) throw new Error(`Réseau inconnu: ${networkName}`);

  const { btc, schnorr } = libs;
  const { Script, p2tr, TAPROOT_UNSPENDABLE_KEY, Transaction, WIF } = btc;

  const privKey = WIF(network).decode(keyData.privateKeyWIF);
  const pubKey = schnorr.getPublicKey(privKey);

  const yamlBytes = new TextEncoder().encode(yamlText);
  const gzipped = gzipSync(yamlBytes);
  const opTypeByte = detectOpType(yamlText);

  const leafScript = buildEnvelopeScript(gzipped, opTypeByte, pubKey, Script);
  log(`leaf script: ${leafScript.length} bytes (yaml gzippé: ${gzipped.length} bytes)`);

  const utxos = await fetchUTXOs(keyData.taprootAddress, API);
  log(`UTXOs: ${utxos.length} (total: ${utxos.reduce((s, u) => s + u.value, 0)} sats)`);
  if (utxos.length === 0) throw new Error(`Aucun UTXO. Fonde ${keyData.taprootAddress}`);

  const { tx: commitTx, commitPayment, commitValue } = buildCommitTx({
    senderPubKey: pubKey, leafScript, utxos,
    changeAddress: keyData.taprootAddress,
    dustLimit: 2000, feeRateSatVb: feeRate, network,
    libs: { p2tr, TAPROOT_UNSPENDABLE_KEY, Transaction },
  });
  commitTx.sign(privKey);
  commitTx.finalize();
  const commitHex = commitTx.hex;
  const commitTxid = commitTx.id;
  log(`commit TX : ${commitTxid}`);

  const { tx: revealTx } = buildRevealTx({
    commitTxid, commitVout: 0, commitValue, commitPayment, leafScript,
    senderPubKey: pubKey, recipientAddress: keyData.taprootAddress,
    dustLimit: 546, feeRateSatVb: feeRate, network, libs: { Transaction },
  });
  revealTx.sign(privKey, undefined, new Uint8Array(32));
  revealTx.finalize();
  const revealHex = revealTx.hex;
  const revealTxid = revealTx.id;
  log(`reveal TX : ${revealTxid}`);

  log('Broadcast commit...');
  const broadcastedCommit = await broadcastTx(commitHex, API);
  log(`✓ commit ${broadcastedCommit}`);
  log('Broadcast reveal...');
  const broadcastedReveal = await broadcastTx(revealHex, API);
  log(`✓ reveal ${broadcastedReveal}`);

  return {
    commitTxid: broadcastedCommit,
    revealTxid: broadcastedReveal,
    opType: opTypeByte,
    leafScriptSize: leafScript.length,
    gzippedSize: gzipped.length,
  };
}
