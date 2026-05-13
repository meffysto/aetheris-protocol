#!/usr/bin/env node
// AETHERIS // PROTOCOL — Onboarding Bitcoin pour l'agent Aurora.
//
// One-shot : génère un wallet taproot Mutinynet pour Aurora et inscrit son
// `join` sur la chaîne. À lancer une seule fois avant aurora-autonomous.mjs.
//
// Ce que ça fait :
//   1. crée joueurs/aurora/.btc-key.json (gitignored, chmod 600)
//   2. attend (ou demande) un funding du faucet Mutinynet
//   3. inscrit un YAML op_type=0x01 (join) avec la pubkey Schnorr du wallet
//      → identité Bitcoin-native d'Aurora pour le moteur
//
// Usage :
//   node agents/aurora-init.mjs                # génère wallet, affiche addr
//   node agents/aurora-init.mjs --join         # inscrit le join (wallet doit être fundé)
//   node agents/aurora-init.mjs --player kael  # autre joueur que aurora

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateWallet, API_URLS } from '../engine/wallet-init-core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const playerIdx = args.indexOf('--player');
const player = playerIdx >= 0 ? args[playerIdx + 1] : 'aurora';
const doJoin = args.includes('--join');
const force = args.includes('--force');
const network = process.env.AETH_NETWORK ?? 'mutinynet';

const playerDir = path.join(ROOT, 'joueurs', player);
const keyFile = path.join(playerDir, '.btc-key.json');

async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function ensureWallet() {
  await fs.mkdir(playerDir, { recursive: true });
  if (await fileExists(keyFile) && !force) {
    const existing = JSON.parse(await fs.readFile(keyFile, 'utf8'));
    console.log(`✓ Wallet déjà présent pour ${player}`);
    console.log(`  réseau   : ${existing.network}`);
    console.log(`  adresse  : ${existing.taprootAddress}`);
    return existing;
  }
  const w = generateWallet({ network });
  await fs.writeFile(keyFile, JSON.stringify(w, null, 2), 'utf8');
  await fs.chmod(keyFile, 0o600);

  // Ajoute le pattern au .gitignore joueurs/ si pas déjà là
  const gi = path.join(ROOT, 'joueurs', '.gitignore');
  let cur = '';
  try { cur = await fs.readFile(gi, 'utf8'); } catch {}
  if (!cur.includes('.btc-key.json')) {
    await fs.writeFile(gi, (cur + '\n*/.btc-key.json\n').trim() + '\n', 'utf8');
  }

  console.log(`✓ Wallet Bitcoin créé pour ${player}`);
  console.log(`  réseau   : ${w.network}`);
  console.log(`  adresse  : ${w.taprootAddress}`);
  console.log(`  fichier  : ${path.relative(ROOT, keyFile)} (chmod 600, gitignored)`);
  console.log('');
  console.log(`  Fonde l'agent : https://faucet.mutinynet.com → ${w.taprootAddress}`);
  console.log('  Puis relance avec --join pour inscrire le join Bitcoin :');
  console.log(`    node agents/aurora-init.mjs --player ${player} --join`);
  return w;
}

async function checkFunding(w) {
  const res = await fetch(`${API_URLS[w.network]}/address/${w.taprootAddress}/utxo`);
  if (!res.ok) throw new Error(`UTXO fetch: ${res.status}`);
  const utxos = await res.json();
  const total = utxos.reduce((s, u) => s + u.value, 0);
  return { utxos, total };
}

async function ensureIdentite() {
  const idPath = path.join(playerDir, 'identite.yaml');
  if (await fileExists(idPath)) return;
  const yaml = [
    'version: 1',
    `nom: ${player}`,
    `date_inscription: ${new Date().toISOString()}`,
    'alliance: ~',
  ].join('\n') + '\n';
  await fs.writeFile(idPath, yaml, 'utf8');
}

async function inscribeJoin() {
  const w = JSON.parse(await fs.readFile(keyFile, 'utf8'));
  const funding = await checkFunding(w);
  if (funding.total < 2500) {
    console.error(`✗ Wallet sous-fundé (${funding.total} sats, besoin ≈ 2500 pour commit+reveal).`);
    console.error(`  Fonde : https://faucet.mutinynet.com → ${w.taprootAddress}`);
    process.exit(2);
  }
  console.log(`▸ UTXO total ${funding.total} sats — OK pour join`);
  await ensureIdentite();

  const result = spawnSync('node', [
    path.join(ROOT, 'engine/inscribe-join.mjs'),
    '--player', player,
    '--key', keyFile,
  ], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, AETH_NETWORK: network } });

  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log('');
  console.log('✓ Aurora a maintenant une identité Bitcoin-native (pubkey Schnorr).');
  console.log('  Prochaine étape : lancer la boucle autonome :');
  console.log(`    node agents/aurora-autonomous.mjs --player ${player}`);
}

async function main() {
  await ensureWallet();
  if (doJoin) await inscribeJoin();
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
