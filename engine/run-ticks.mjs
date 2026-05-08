#!/usr/bin/env node
// Boucle E2E : inscrit des ordres sur Bitcoin et applique N ticks.
// Usage: node engine/run-ticks.mjs [--ticks 10] [--dry]

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const API = 'https://mutinynet.com/api';
const args = process.argv.slice(2);
const N_TICKS = parseInt(args[args.indexOf('--ticks') + 1] ?? '10', 10);
const DRY = args.includes('--dry');

function run(cmd, cmdArgs, env = {}) {
  const r = spawnSync('node', [path.join(ROOT, cmd), ...cmdArgs], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) throw new Error(`${cmd} a échoué (code ${r.status})`);
}

async function waitConfirmed(txid, maxWait = 300) {
  const deadline = Date.now() + maxWait * 1000;
  process.stdout.write(`  Attente confirmation ${txid.slice(0, 16)}...`);
  while (Date.now() < deadline) {
    const s = await (await fetch(`${API}/tx/${txid}/status`)).json();
    if (s.confirmed) {
      process.stdout.write(` bloc ${s.block_height}\n`);
      return s.block_height;
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 8000));
  }
  throw new Error(`TX ${txid} non confirmée après ${maxWait}s`);
}

async function getCurrentTick() {
  const manifest = await fs.readFile(path.join(ROOT, 'world/manifest.yaml'), 'utf8');
  return parseInt(manifest.match(/^tick:\s*(\d+)/m)?.[1] ?? '0', 10);
}

async function updateOrders(tick) {
  const nonce = Math.random().toString(16).slice(2, 8);
  // Ordre simple : upgrade mine_ferrum si extracteur_lumen est déjà au bon niveau, sinon alterner
  const batiment = tick % 2 === 0 ? 'mine_ferrum' : 'extracteur_lumen';
  // Lit l'empire courant pour déterminer le bon niveau cible
  let niveauCible = 3; // valeur par défaut
  try {
    const empireText = await fs.readFile(path.join(ROOT, 'joueurs/meff/empire.yaml'), 'utf8');
    const m = empireText.match(new RegExp(`${batiment}:\\s*(\\d+)`));
    if (m) niveauCible = parseInt(m[1]) + 1;
  } catch { /* utilise la valeur par défaut */ }

  const yaml = `version: 1
joueur: meff
tick_cible: ${tick}
nonce: ${nonce}

ordres:
  - type: chantier
    planete: meff-prima
    batiment: ${batiment}
    niveau_cible: ${niveauCible}
signature: none
`;
  await fs.writeFile(path.join(ROOT, 'joueurs/meff/ordres.yaml'), yaml, 'utf8');
  return { batiment, niveauCible };
}

async function getRevealTxid() {
  // Lit le dernier txid depuis la sortie de inscribe.mjs en parsant les logs
  // Alternative : on lit les UTXOs avant/après pour trouver la TX
  // Pour simplifier, on attend la mempool et cherche la TX la plus récente
  const keyData = JSON.parse(await fs.readFile(path.join(ROOT, '.btc-key'), 'utf8'));
  const txs = await (await fetch(`${API}/address/${keyData.taprootAddress}/txs`)).json();
  return txs[0]?.txid;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  CITADEL // BITCOIN MVP — Boucle ${N_TICKS} ticks`);
  console.log(`${'═'.repeat(60)}\n`);

  const startTick = await getCurrentTick();
  console.log(`Tick de départ : ${startTick}`);

  for (let i = 1; i <= N_TICKS; i++) {
    const currentTick = await getCurrentTick();
    const targetTick = currentTick + 1;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  Tick ${targetTick} (${i}/${N_TICKS})`);
    console.log(`${'─'.repeat(60)}`);

    // 1. Mise à jour des ordres
    const { batiment, niveauCible } = await updateOrders(targetTick);
    console.log(`  Ordre : chantier ${batiment} → niv ${niveauCible}`);

    // 2. Inscription sur Bitcoin
    console.log('  Inscription...');
    // Capture le txid reveal en lançant inscribe.mjs et parsant stdout
    const inscribeResult = spawnSync('node', [path.join(ROOT, 'engine/inscribe.mjs'), 'joueurs/meff/ordres.yaml'], {
      cwd: ROOT,
      env: { ...process.env },
      encoding: 'utf8',
    });
    if (inscribeResult.status !== 0) {
      console.error(inscribeResult.stderr ?? inscribeResult.stdout);
      throw new Error('inscribe.mjs a échoué');
    }
    process.stdout.write(inscribeResult.stdout.split('\n').filter(l => l.startsWith('✓') || l.includes('commit') || l.includes('reveal')).join('\n') + '\n');

    const revealMatch = inscribeResult.stdout.match(/reveal\s+:\s+([0-9a-f]{64})/);
    if (!revealMatch) throw new Error('Impossible de trouver le txid reveal');
    const revealTxid = revealMatch[1];

    // 3. Attente de confirmation
    const blockHeight = await waitConfirmed(revealTxid);

    // 4. Sync depuis ce bloc
    console.log(`  Sync depuis le bloc ${blockHeight}...`);
    const syncResult = spawnSync('node', [path.join(ROOT, 'engine/sync.mjs'), '--from', String(blockHeight)], {
      cwd: ROOT, env: { ...process.env }, encoding: 'utf8',
    });
    const syncLines = syncResult.stdout.split('\n').filter(l => l.includes('✓') || l.includes('inscription'));
    console.log(syncLines.join('\n'));

    // 5. Appliquer le tick
    const tickMode = DRY ? '--dry-run' : '--apply';
    console.log(`  Tick ${targetTick} (${tickMode})...`);
    const tickResult = spawnSync('node', [path.join(ROOT, 'engine/tick.mjs'), tickMode], {
      cwd: ROOT,
      env: { ...process.env, AETH_ORDER_SOURCE: 'bitcoin' },
      encoding: 'utf8',
    });
    const tickLines = tickResult.stdout.split('\n').filter(l =>
      l.includes('source:') || l.includes('✓ Tick') || l.includes('⚠') || l.includes('événement')
    );
    console.log(tickLines.join('\n'));

    if (tickResult.status !== 0) throw new Error('tick.mjs a échoué');

    // 6. État courant
    const newTick = await getCurrentTick();
    console.log(`  ✓ Tick ${newTick} appliqué`);

    // Pause courte pour laisser Mutinynet respirer
    if (i < N_TICKS) await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✓ ${N_TICKS} ticks complétés ! État final :`);
  console.log(`${'═'.repeat(60)}\n`);

  // Affiche l'état final
  spawnSync('node', [path.join(ROOT, 'engine/show.mjs'), '--player', 'meff'], {
    cwd: ROOT, stdio: 'inherit',
  });

  const keyData = JSON.parse(await fs.readFile(path.join(ROOT, '.btc-key'), 'utf8'));
  const utxos = await (await fetch(`${API}/address/${keyData.taprootAddress}/utxo`)).json();
  const sats = utxos.reduce((s, u) => s + u.value, 0);
  console.log(`\nSolde wallet restant : ${sats} sats`);
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1); });
