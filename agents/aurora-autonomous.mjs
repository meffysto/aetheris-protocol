#!/usr/bin/env node
// AETHERIS // PROTOCOL — Aurora autonome
// ──────────────────────────────────────
// L'agent IA Aurora joue le rôle d'un joueur humain : il boot la chain
// Mutinynet, lit son empire reconstitué, décide ses ordres, et les inscrit
// directement sur Bitcoin via le même flow que la console (commit + reveal
// taproot envelope op_type=0x02).
//
// Kill switch (3 niveaux) :
//   1. fichier sentinel : `touch agents/.killswitch-aurora` → arrêt propre
//      au prochain cycle (vérifié au début et à la fin de chaque tour).
//   2. env var : `AURORA_KILL=1` → idem
//   3. signal : SIGINT / SIGTERM → arrêt après le tour en cours
//
// Caps de sécurité (refus de continuer si dépassés) :
//   - AURORA_MAX_ITER         (défaut 10000) — nb max de cycles complets
//   - AURORA_MAX_SATS_SPENT   (défaut 50000) — sats max dépensés en fees
//   - AURORA_MAX_CONSECUTIVE_ERRORS (défaut 5) — bail si trop d'erreurs
//
// Stratégie : pluggable via `joueurs/<player>/agent.yaml` (clé `strategie:`).
// Les modules vivent dans `agents/strategies/*.mjs` ; défaut = `eco` (port
// direct du baseline historique, jamais d'attaque). Le fichier est relu à
// chaque cycle → commit + push applique au tour suivant, pas de restart.
//
// Usage :
//   node agents/aurora-autonomous.mjs --player aurora
//   AETH_NETWORK=mutinynet AURORA_POLL_SEC=20 node agents/aurora-autonomous.mjs
//   AURORA_DRY_RUN=1 node agents/aurora-autonomous.mjs   # décide mais n'inscrit pas

import fs from 'node:fs/promises';
import path from 'node:path';
import { bootBitcoin } from '../engine/boot-bitcoin.mjs';
import { inscribe, API_URLS } from '../engine/inscribe-core.mjs';
import { initCache } from '../engine/cache.mjs';
import { makeNodeAdapter } from '../engine/cache-node.mjs';
import { loadStrategy } from './strategies/index.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// ─── args / env ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }

const PLAYER = flag('--player') ?? 'aurora';
const NETWORK = process.env.AETH_NETWORK ?? 'mutinynet';
const KEY_FILE = flag('--key') ?? path.join(ROOT, 'joueurs', PLAYER, '.btc-key.json');
const KILL_FILE = path.join(ROOT, 'agents', `.killswitch-${PLAYER}`);
const POLL_SEC = Number(process.env.AURORA_POLL_SEC ?? '60');
const FEE_RATE = Number(process.env.AETH_FEE_RATE ?? '1');
const DRY_RUN = process.env.AURORA_DRY_RUN === '1' || args.includes('--dry-run');
const MAX_ITER = Number(process.env.AURORA_MAX_ITER ?? '10000');
const MAX_SATS = Number(process.env.AURORA_MAX_SATS_SPENT ?? '50000');
const MAX_ERR = Number(process.env.AURORA_MAX_CONSECUTIVE_ERRORS ?? '5');

let stopRequested = false;
process.on('SIGINT',  () => { console.log('\n[aurora] SIGINT — arrêt après ce cycle.'); stopRequested = true; });
process.on('SIGTERM', () => { console.log('\n[aurora] SIGTERM — arrêt après ce cycle.'); stopRequested = true; });

// ─── kill switch ─────────────────────────────────────────────────────────────

async function shouldStop() {
  if (stopRequested) return 'signal';
  if (process.env.AURORA_KILL === '1') return 'env AURORA_KILL=1';
  try { await fs.access(KILL_FILE); return `fichier ${path.relative(ROOT, KILL_FILE)}`; } catch {}
  return null;
}

// ─── sérialisation YAML (mirror console-live-bitcoin.html) ───────────────────

function inlineMap(m) {
  const e = Object.entries(m ?? {});
  if (!e.length) return '{}';
  return '{ ' + e.map(([k, v]) => `${k}: ${v}`).join(', ') + ' }';
}

function serializeOrder(o) {
  if (o.type === 'chantier') {
    return `  - type: chantier\n    planete: ${o.planete}\n    batiment: ${o.batiment}\n    niveau_cible: ${o.niveau_cible}`;
  }
  if (o.type === 'recherche') {
    return `  - type: recherche\n    technologie: ${o.technologie}\n    niveau_cible: ${o.niveau_cible}`;
  }
  throw new Error(`serializeOrder: type non supporté pour Aurora baseline: ${o.type}`);
}

function randomNonce() {
  return [...crypto.getRandomValues(new Uint8Array(3))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildOrdresYaml({ joueur, tickCible, ordres }) {
  const nonce = randomNonce();
  return `# Aurora autonome (${new Date().toISOString()})\nversion: 1\njoueur: ${joueur}\ntick_cible: ${tickCible}\nnonce: "${nonce}"\n\nordres:\n${ordres.map(serializeOrder).join('\n')}\n`;
}

// ─── état persistant (compteurs cumulés entre runs) ──────────────────────────

const STATE_FILE = path.join(ROOT, '.cache', `aurora-${PLAYER}-state.json`);

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch { return { iterations: 0, satsSpent: 0, lastInscribedTick: null, lastError: null }; }
}
async function saveState(s) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// ─── boot helpers ────────────────────────────────────────────────────────────

async function loadGameYamls() {
  const [genesisYaml, rulesYaml, galaxieYaml] = await Promise.all([
    fs.readFile(path.join(ROOT, 'genesis/genesis.yaml'), 'utf8'),
    fs.readFile(path.join(ROOT, 'engine/rules.yaml'), 'utf8'),
    fs.readFile(path.join(ROOT, 'world/galaxie.yaml'), 'utf8'),
  ]);
  return { genesisYaml, rulesYaml, galaxieYaml };
}

// ─── inscription ─────────────────────────────────────────────────────────────

async function inscribeOrder(yamlText, keyData) {
  const { schnorr } = await import('@noble/curves/secp256k1');
  const btc = await import('@scure/btc-signer');
  return inscribe({
    yamlText, keyData, networkName: NETWORK, feeRate: FEE_RATE,
    libs: { btc, schnorr },
    log: msg => console.log(`  · ${msg}`),
  });
}

// ─── cycle ───────────────────────────────────────────────────────────────────

async function runCycle({ keyData, state }) {
  const { genesisYaml, rulesYaml, galaxieYaml } = await loadGameYamls();

  console.log(`[${new Date().toISOString()}] cycle #${state.iterations + 1} — boot Bitcoin…`);
  const boot = await bootBitcoin({
    api: API_URLS[NETWORK], genesisYaml, rulesYaml, galaxieYaml,
    log: () => {}, // silencieux : on n'a pas besoin du firehose de boot ici
  });

  const empire = boot.empires[PLAYER];
  if (!empire) {
    throw new Error(`Aucun empire on-chain pour ${PLAYER}. Lance d'abord : node agents/aurora-init.mjs --player ${PLAYER} --join`);
  }
  const myPk = boot.identites[PLAYER]?.cle_publique;
  const walletPk = `schnorr:${keyData.pubKeyHex}`;
  if (myPk !== walletPk) {
    throw new Error(`Wallet pubkey ≠ identité on-chain (${walletPk} vs ${myPk}). Refus d'inscrire pour éviter un rejet déterministe.`);
  }

  const tickCourant = boot.tickCourant;
  const tickCible = tickCourant + 1;

  // Déjà inscrit pour ce tick ? (sur la chain OU dans le cycle précédent qui
  // n'a pas encore été vu par le scan)
  const onChain = boot.ordersByTick?.[tickCible]?.[PLAYER];
  if (onChain) {
    console.log(`  ✓ ordre déjà on-chain pour tick ${tickCible} (txid ${onChain.txid.slice(0, 12)}…) — skip`);
    return { inscribed: false, tickCible };
  }
  if (state.lastInscribedTick === tickCible) {
    console.log(`  ✓ déjà inscrit ce cycle pour tick ${tickCible} (mempool) — skip`);
    return { inscribed: false, tickCible };
  }

  const playerDir = path.join(ROOT, 'joueurs', PLAYER);
  const strategy = await loadStrategy({ playerDir });
  const rules = boot.rules ?? null;
  const ordres = strategy.decide({ empire, ctx: { tickCible, rules } });
  if (ordres.length === 0) {
    console.log(`  · aucune décision (files pleines) pour tick ${tickCible} [stratégie ${strategy.name}]`);
    return { inscribed: false, tickCible };
  }
  console.log(`  · ${ordres.length} ordre(s) pour tick ${tickCible} [stratégie ${strategy.name}] :`);
  for (const o of ordres) {
    if (o.type === 'chantier') console.log(`      chantier ${o.planete} · ${o.batiment} → niv ${o.niveau_cible}`);
    if (o.type === 'recherche') console.log(`      recherche ${o.technologie} → niv ${o.niveau_cible}`);
  }

  if (DRY_RUN) {
    console.log('  [DRY_RUN] inscription Bitcoin sautée.');
    return { inscribed: false, tickCible, dryRun: true };
  }

  const yamlText = buildOrdresYaml({ joueur: PLAYER, tickCible, ordres });
  const result = await inscribeOrder(yamlText, keyData);
  state.lastInscribedTick = tickCible;
  // Estimation grossière (commit ≈ 150 vB × feeRate + reveal ≈ leaf/4 vB × feeRate + dust)
  const estSats = 2000 + Math.ceil(result.leafScriptSize / 4 * FEE_RATE) + Math.ceil(150 * FEE_RATE);
  state.satsSpent += estSats;
  console.log(`  ✓ inscrit (≈${estSats} sats) — reveal ${result.revealTxid}`);
  return { inscribed: true, tickCible, ...result };
}

// ─── main loop ───────────────────────────────────────────────────────────────

async function main() {
  initCache(makeNodeAdapter(path.join(ROOT, '.cache')));

  // Sanity : wallet présent ?
  let keyData;
  try { keyData = JSON.parse(await fs.readFile(KEY_FILE, 'utf8')); }
  catch {
    console.error(`✗ Wallet introuvable : ${KEY_FILE}`);
    console.error(`  Lance d'abord : node agents/aurora-init.mjs --player ${PLAYER}`);
    process.exit(1);
  }

  // Probe la stratégie au boot pour échouer vite si agent.yaml est cassé.
  let bootStrategy;
  try { bootStrategy = await loadStrategy({ playerDir: path.join(ROOT, 'joueurs', PLAYER) }); }
  catch (e) {
    console.error(`✗ Stratégie illisible : ${e.message}`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(` AURORA · agent autonome (réseau ${NETWORK})`);
  console.log(`   joueur          : ${PLAYER}`);
  console.log(`   stratégie       : ${bootStrategy.name}${bootStrategy.source ? ` (${path.relative(process.cwd(), bootStrategy.source)})` : ' (défaut, pas d\'agent.yaml)'}`);
  console.log(`   wallet          : ${keyData.taprootAddress}`);
  console.log(`   kill switch     : touch ${path.relative(process.cwd(), KILL_FILE)}`);
  console.log(`                   ou env AURORA_KILL=1, SIGINT, SIGTERM`);
  console.log(`   poll            : ${POLL_SEC}s · feeRate ${FEE_RATE} sat/vB`);
  console.log(`   caps            : iter≤${MAX_ITER} · sats≤${MAX_SATS} · err_streak≤${MAX_ERR}`);
  if (DRY_RUN) console.log('   DRY_RUN         : inscriptions désactivées');
  console.log('═══════════════════════════════════════════════════════════');

  const state = await loadState();
  let errStreak = 0;

  while (true) {
    const stop = await shouldStop();
    if (stop) {
      console.log(`[aurora] kill switch actif (${stop}) — sortie propre.`);
      break;
    }
    if (state.iterations >= MAX_ITER) {
      console.log(`[aurora] cap iter=${MAX_ITER} atteint — sortie.`);
      break;
    }
    if (state.satsSpent >= MAX_SATS) {
      console.log(`[aurora] cap sats=${MAX_SATS} atteint (cumulé ${state.satsSpent}) — sortie.`);
      break;
    }
    if (errStreak >= MAX_ERR) {
      console.log(`[aurora] ${errStreak} erreurs consécutives — bail.`);
      break;
    }

    try {
      await runCycle({ keyData, state });
      errStreak = 0;
      state.lastError = null;
    } catch (e) {
      errStreak++;
      state.lastError = { ts: new Date().toISOString(), msg: e.message ?? String(e) };
      console.error(`[aurora] cycle erreur (${errStreak}/${MAX_ERR}) : ${e.message ?? e}`);
      if (e.code === 'RBF_CONFLICT') {
        console.log('  · RBF conflict — TX commit précédente en mempool, on attend.');
      }
    }

    state.iterations++;
    await saveState(state);

    // Re-check kill switch avant le sleep pour réaction rapide
    if (await shouldStop()) {
      console.log('[aurora] kill switch détecté en fin de cycle — sortie.');
      break;
    }

    // Sleep interruptible (kill switch + signal cassent la boucle)
    const tEnd = Date.now() + POLL_SEC * 1000;
    while (Date.now() < tEnd) {
      if (await shouldStop()) break;
      await new Promise(r => setTimeout(r, Math.min(1000, tEnd - Date.now())));
    }
  }

  await saveState(state);
  console.log(`[aurora] arrêt. iterations=${state.iterations} sats_dépensés≈${state.satsSpent}`);
}

main().catch(e => { console.error(e); process.exit(1); });
