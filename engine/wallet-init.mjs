#!/usr/bin/env node
// Génère un wallet taproot BIP-86 pour Aetheris Bitcoin MVP.
// Écrit .btc-key à la racine du repo (gitignoré).
//
// Usage:
//   node engine/wallet-init.mjs [--network mutinynet|signet|mainnet] [--force]

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY_FILE = path.join(ROOT, '.btc-key');

// ─── config réseau ───────────────────────────────────────────────────────────

const NETWORKS = {
  mainnet:  { bech32: 'bc',  pubKeyHash: 0,   scriptHash: 5,   wif: 128, coinType: 0  },
  signet:   { bech32: 'tb',  pubKeyHash: 111, scriptHash: 196, wif: 239, coinType: 1  },
  mutinynet:{ bech32: 'tb',  pubKeyHash: 111, scriptHash: 196, wif: 239, coinType: 1  },
};

const API_URLS = {
  mainnet:   'https://blockstream.info/api',
  signet:    'https://mutinynet.com/api',
  mutinynet: 'https://mutinynet.com/api',
};

// ─── args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const networkArg = args[args.indexOf('--network') + 1] ?? process.env.AETH_NETWORK ?? 'mutinynet';
const force = args.includes('--force');

if (!(networkArg in NETWORKS)) {
  console.error(`Réseau inconnu: ${networkArg}. Valeurs: mainnet, signet, mutinynet`);
  process.exit(1);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const exists = await fs.access(KEY_FILE).then(() => true).catch(() => false);
  if (exists && !force) {
    console.error('.btc-key existe déjà. Utilise --force pour écraser (DANGER : perte de fonds).');
    process.exit(1);
  }

  const { generateMnemonic, mnemonicToSeedSync } = await import('@scure/bip39');
  const { HDKey } = await import('@scure/bip32');
  const { p2tr, WIF } = await import('@scure/btc-signer');
  const { schnorr } = await import('@noble/curves/secp256k1');

  const { wordlist } = require('@scure/bip39/wordlists/english.js');

  const network = NETWORKS[networkArg];
  const mnemonic = generateMnemonic(wordlist);
  const seed = mnemonicToSeedSync(mnemonic);

  const root = HDKey.fromMasterSeed(seed);
  // BIP-86 : m/86'/{coinType}'/0'/0/0
  const child = root.derive(`m/86'/${network.coinType}'/0'/0/0`);
  const privKey = child.privateKey;

  const pubKey = schnorr.getPublicKey(privKey);
  const payment = p2tr(pubKey, undefined, network);
  const wifStr = WIF(network).encode(privKey);

  const keyData = {
    network: networkArg,
    api: API_URLS[networkArg],
    mnemonic,
    derivation: `m/86'/${network.coinType}'/0'/0/0`,
    privateKeyWIF: wifStr,
    taprootAddress: payment.address,
    pubKeyHex: Buffer.from(pubKey).toString('hex'),
    createdAt: new Date().toISOString(),
  };

  await fs.writeFile(KEY_FILE, JSON.stringify(keyData, null, 2), 'utf8');
  // Permissions restrictives sur le fichier clé
  await fs.chmod(KEY_FILE, 0o600);

  console.log('✓ Wallet créé');
  console.log(`  réseau   : ${networkArg}`);
  console.log(`  adresse  : ${payment.address}`);
  console.log(`  fichier  : .btc-key (chmod 600, gitignoré)`);
  console.log('');
  console.log('Fonde ce wallet sur Mutinynet avant de l\'utiliser :');
  console.log(`  https://faucet.mutinynet.com → ${payment.address}`);
}

main().catch(e => { console.error(e); process.exit(1); });
