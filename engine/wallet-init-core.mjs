// CITADEL // PROTOCOL — Génération de wallet taproot BIP-86 (iso).
// Importable depuis Node ou navigateur.
//
// Usage browser :
//   import { generateWallet } from './engine/wallet-init-core.mjs';
//   const w = await generateWallet({ network: 'mutinynet' });
//   // w = { mnemonic, privateKeyWIF, taprootAddress, ... }

import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { p2tr, WIF } from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';

export const NETWORKS = {
  mainnet:   { bech32: 'bc',  pubKeyHash: 0,   scriptHash: 5,   wif: 128, coinType: 0 },
  signet:    { bech32: 'tb',  pubKeyHash: 111, scriptHash: 196, wif: 239, coinType: 1 },
  mutinynet: { bech32: 'tb',  pubKeyHash: 111, scriptHash: 196, wif: 239, coinType: 1 },
};

export const API_URLS = {
  mainnet:   'https://blockstream.info/api',
  signet:    'https://mutinynet.com/api',
  mutinynet: 'https://mutinynet.com/api',
};

/**
 * Génère un wallet taproot BIP-86 fresh.
 * @param {{ network?: 'mainnet'|'signet'|'mutinynet', mnemonic?: string }} opts
 * @returns {{ network, api, mnemonic, derivation, privateKeyWIF, taprootAddress, pubKeyHex, createdAt }}
 */
export function generateWallet({ network: networkName = 'mutinynet', mnemonic } = {}) {
  if (!(networkName in NETWORKS)) throw new Error(`Réseau inconnu: ${networkName}`);
  const network = NETWORKS[networkName];

  const phrase = mnemonic ?? generateMnemonic(wordlist);
  const seed = mnemonicToSeedSync(phrase);

  const root = HDKey.fromMasterSeed(seed);
  const derivation = `m/86'/${network.coinType}'/0'/0/0`;
  const child = root.derive(derivation);
  const privKey = child.privateKey;

  const pubKey = schnorr.getPublicKey(privKey);
  const payment = p2tr(pubKey, undefined, network);
  const wifStr = WIF(network).encode(privKey);

  return {
    network: networkName,
    api: API_URLS[networkName],
    mnemonic: phrase,
    derivation,
    privateKeyWIF: wifStr,
    taprootAddress: payment.address,
    pubKeyHex: Array.from(pubKey).map(b => b.toString(16).padStart(2, '0')).join(''),
    createdAt: new Date().toISOString(),
  };
}
