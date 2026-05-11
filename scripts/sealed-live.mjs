#!/usr/bin/env node
// Live test du protocole commit-reveal sur mutinynet.
//
// Le but n'est PAS de jouer un vrai combat (ça nécessite empires + flottes
// existants on-chain) — c'est de prouver que les bytes que nous écrivons
// survivent à un vrai broadcast → re-scan via Esplora.
//
// Phases :
//   1. seal    → génère un secret aléatoire, calcule le hash, inscrit le
//                sealed (op_type 0x03) sur mutinynet. Sauve l'état dans
//                .sealed-live-state.json pour la phase 2.
//   2. reveal  → lit l'état, inscrit le reveal (op_type 0x04) avec le secret
//                en clair. Vérifie via scan que le hash matche bien.
//   3. verify  → re-scan les blocs correspondants et confirme que :
//                  - le sealed est trouvé avec op_type='sealed' et hash correct
//                  - le reveal est trouvé avec op_type='reveal' et secret correct
//                  - computeSealHash(reveal.secret) === sealed.hash
//
// Par défaut TOUT est en dry-run (aucun broadcast). Ajouter --broadcast pour
// publier réellement. Mutinynet utilise des sats de faucet (gratuits).
//
// Usage:
//   node scripts/sealed-live.mjs seal --player meff --from meff-prima \
//        --target-player rival --target-planet rival-1 --fleet 'chasseur_leger:10'
//   node scripts/sealed-live.mjs seal ... --broadcast
//   node scripts/sealed-live.mjs reveal --broadcast
//   node scripts/sealed-live.mjs verify
//   node scripts/sealed-live.mjs cleanup

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { inscribe, API_URLS, OP_TYPES } from '../engine/inscribe-core.mjs';
import { scanRange, fetchTipHeight } from '../engine/scan-bitcoin.mjs';
import { computeSealHash } from '../engine/sealed-protocol.mjs';
import { tickFromBlockHeight, blockHeightForTick, yparse } from '../engine/tick-core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE_FILE = path.join(ROOT, '.sealed-live-state.json');
const NETWORK = process.env.AETH_NETWORK ?? 'mutinynet';
const FEE_RATE = Number(process.env.AETH_FEE_RATE ?? '1');

// ─── argv parsing minimaliste ───────────────────────────────────────────────

function parseArgs(argv) {
  const [, , cmd, ...rest] = argv;
  const flags = { broadcast: false, dryRun: true };
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--broadcast') { flags.broadcast = true; flags.dryRun = false; }
    else if (a === '--dry-run') { flags.dryRun = true; flags.broadcast = false; }
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
      opts[key] = val;
    }
  }
  return { cmd, opts, flags };
}

function usage() {
  console.log(`Usage: node scripts/sealed-live.mjs <cmd> [options]

Commands:
  seal      Inscrit un sealed (génère secret + hash, sauve l'état).
            Required: --player, --from, --target-player, --target-planet
            Optional: --fleet 'unite:n,unite:n' (défaut: chasseur_leger:0)
                      --distance N  (default 100 = fallback engine pour planètes
                                     hors empire actifs ; mets la vraie distance
                                     entre planète origine et cible pour prédire
                                     correctement le tick_impact)
  reveal    Inscrit le reveal correspondant au sealed précédent.
            (Lit .sealed-live-state.json — pas d'options requises.)
  verify    Re-scan les blocs concernés et vérifie le round-trip on-chain.
  cleanup   Supprime .sealed-live-state.json.

Flags:
  --broadcast   Publie réellement sur ${NETWORK} (sinon: dry-run).
  --dry-run     Default. Affiche les YAMLs sans broadcaster.

Env:
  AETH_NETWORK=${NETWORK}    AETH_FEE_RATE=${FEE_RATE}
`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function randomNonce() {
  return crypto.randomBytes(8).toString('hex');
}

function parseFleet(str) {
  if (!str || typeof str !== 'string') return { chasseur_leger: 0 };
  const out = {};
  for (const pair of str.split(',')) {
    const [k, v] = pair.split(':').map(s => s.trim());
    if (k) out[k] = parseInt(v, 10) || 0;
  }
  return out;
}

async function loadKey() {
  return JSON.parse(await fs.readFile(path.join(ROOT, '.btc-key'), 'utf8'));
}

async function loadGenesis() {
  const text = await fs.readFile(path.join(ROOT, 'genesis/genesis.yaml'), 'utf8');
  return yparse(text);
}

async function loadRules() {
  const text = await fs.readFile(path.join(ROOT, 'engine/rules.yaml'), 'utf8');
  return yparse(text);
}

// Calcule le tick_impact attendu à partir de distance + vitesse min de la flotte.
// Reproduit la formule de tick-core.mjs::queueAttaque et la verif au reveal.
function computeExpectedImpact(tick_depart, distance, fleet, rules) {
  const UTJ_PAR_TICK = rules.duree_utj_par_tick || 6;
  const ships = Object.keys(fleet || {});
  if (ships.length === 0) throw new Error('flotte vide');
  const vMin = Math.min(...ships.map(s => rules.vaisseaux?.[s]?.vitesse || 1000));
  if (!Number.isFinite(vMin) || vMin <= 0) throw new Error('vMin invalide');
  const flightUTJ = Math.max(1, Math.ceil(distance / vMin * 100));
  const flightTicks = Math.ceil(flightUTJ / UTJ_PAR_TICK);
  return { tick_impact: tick_depart + flightTicks, vMin, flightUTJ, flightTicks };
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// Build the literal YAML strings (controlled formatting → reproductible hash).
function buildSealedYaml({ joueur, tick_depart, planete_origine, hash }) {
  return [
    'type: sealed',
    'version: 1',
    `joueur: ${joueur}`,
    `tick_depart: ${tick_depart}`,
    `planete_origine: ${planete_origine}`,
    'kind: militaire',
    `hash: ${hash}`,
    '',
  ].join('\n');
}

function buildRevealYaml({ joueur, tick_impact, sealed_txid, secret }) {
  const fleetLines = Object.entries(secret.flotte || {})
    .map(([k, n]) => `    ${k}: ${n}`)
    .join('\n');
  return [
    'type: reveal',
    'version: 1',
    `joueur: ${joueur}`,
    `tick_impact: ${tick_impact}`,
    `sealed_txid: ${sealed_txid}`,
    'secret:',
    `  type: ${secret.type}`,
    `  depuis: ${secret.depuis}`,
    '  cible:',
    `    joueur: ${secret.cible.joueur}`,
    `    planete: ${secret.cible.planete}`,
    '  flotte:',
    fleetLines || '    chasseur_leger: 0',
    `  vitesse: ${secret.vitesse}`,
    `  nonce: ${secret.nonce}`,
    '',
  ].join('\n');
}

async function broadcastInscription(yamlText, label) {
  const keyData = await loadKey();
  const { schnorr } = await import('@noble/curves/secp256k1');
  const btc = await import('@scure/btc-signer');
  console.log(`▸ Broadcasting ${label} sur ${NETWORK} (feeRate=${FEE_RATE})…`);
  const result = await inscribe({
    yamlText,
    keyData,
    networkName: NETWORK,
    feeRate: FEE_RATE,
    libs: { btc, schnorr },
    log: (m) => console.log(`  ${m}`),
  });
  console.log(`  commit : ${result.commitTxid}`);
  console.log(`  reveal : ${result.revealTxid}`);
  console.log(`  ${API_URLS[NETWORK].replace('/api', '')}/tx/${result.revealTxid}`);
  return result;
}

// ─── commandes ──────────────────────────────────────────────────────────────

async function cmdSeal({ opts, flags }) {
  const required = ['player', 'from', 'target-player', 'target-planet'];
  const missing = required.filter(k => !opts[k]);
  if (missing.length) {
    console.error(`✗ options manquantes : ${missing.join(', ')}`);
    usage();
    process.exit(1);
  }

  const genesis = await loadGenesis();
  const rules = await loadRules();
  const blocGenesis = genesis.ancrage?.bloc_genesis;
  const bpt = genesis.parametres?.blocs_par_tick ?? 1;
  const api = API_URLS[NETWORK];

  const tip = await fetchTipHeight(api);
  const tickCourant = tickFromBlockHeight(tip, blocGenesis, bpt, 0);
  const tick_depart = tickCourant + 1;

  const fleet = parseFleet(opts.fleet);
  const distance = Number.isFinite(parseInt(opts.distance, 10)) ? parseInt(opts.distance, 10) : 100;
  const { tick_impact, vMin, flightUTJ, flightTicks } = computeExpectedImpact(tick_depart, distance, fleet, rules);
  const blockImpactStart = blockHeightForTick(tick_impact, blocGenesis, bpt, 0);
  const blockImpactEnd = blockImpactStart + bpt - 1;

  const nonce = randomNonce();
  const secret = {
    type: 'attaque',
    depuis: opts.from,
    cible: { joueur: opts['target-player'], planete: opts['target-planet'] },
    flotte: fleet,
    vitesse: 100,
    nonce,
  };
  const hash = computeSealHash(secret);
  const sealedYaml = buildSealedYaml({
    joueur: opts.player,
    tick_depart,
    planete_origine: opts.from,
    hash,
  });

  console.log('━━━ SEAL ━━━');
  console.log(`  réseau         : ${NETWORK}`);
  console.log(`  tip courant    : ${tip} (tick ${tickCourant})`);
  console.log(`  bloc_genesis   : ${blocGenesis}, blocs/tick: ${bpt}`);
  console.log(`  tick_depart    : ${tick_depart}`);
  console.log(`  distance       : ${distance}${opts.distance ? '' : ' (fallback — utilise --distance pour override)'}`);
  console.log(`  vMin flotte    : ${vMin}`);
  console.log(`  flight         : ${flightUTJ} UTJ = ${flightTicks} tick(s)`);
  console.log(`  tick_impact*   : ${tick_impact}  (blocs ${blockImpactStart}..${blockImpactEnd})`);
  console.log(`  attente impact : ~${(tick_impact - tickCourant) * bpt * 30}s (~${Math.round((tick_impact - tickCourant) * bpt * 30 / 60)} min)`);
  console.log(`  secret hash    : ${hash}`);
  console.log('  * tick_impact n\'est PAS dans le sealed YAML — dérivé au reveal par l\'engine.');
  console.log('');
  console.log('--- sealed.yaml ---');
  console.log(sealedYaml);

  if (flags.dryRun) {
    console.log('(dry-run) — ajoute --broadcast pour publier');
    return;
  }

  const result = await broadcastInscription(sealedYaml, 'SEALED');

  const state = {
    phase: 'sealed',
    network: NETWORK,
    blocGenesis, bpt,
    sealed_txid: result.revealTxid,  // l'inscription Citadel = la "reveal TX" Bitcoin (étape 2 du commit-reveal taproot)
    sealed_commit_txid: result.commitTxid,
    joueur: opts.player,
    tick_depart,
    tick_impact,   // calculé localement pour savoir quand publier le reveal
    distance,
    planete_origine: opts.from,
    hash,
    secret,
    sealedYaml,
    createdAt: new Date().toISOString(),
  };
  await saveState(state);
  console.log(`\n✓ État sauvé dans ${path.relative(ROOT, STATE_FILE)}`);
  console.log(`  Attends que le bloc impact soit miné (~${Math.round((tick_impact - tickCourant) * bpt * 30 / 60)} min),`);
  console.log(`  puis lance : node scripts/sealed-live.mjs reveal --broadcast`);
}

async function cmdReveal({ flags }) {
  const state = await loadState();
  if (!state) {
    console.error(`✗ pas d'état trouvé dans ${path.relative(ROOT, STATE_FILE)} — lance 'seal' d'abord`);
    process.exit(1);
  }
  if (state.phase === 'revealed') {
    console.error('✗ ce sceau a déjà été révélé — lance "cleanup" pour repartir');
    process.exit(1);
  }

  const api = API_URLS[state.network];
  const tip = await fetchTipHeight(api);
  const tickCourant = tickFromBlockHeight(tip, state.blocGenesis, state.bpt, 0);
  const blockImpact = blockHeightForTick(state.tick_impact, state.blocGenesis, state.bpt, 0);

  const revealYaml = buildRevealYaml({
    joueur: state.joueur,
    tick_impact: state.tick_impact,
    sealed_txid: state.sealed_txid,
    secret: state.secret,
  });

  console.log('━━━ REVEAL ━━━');
  console.log(`  sealed_txid    : ${state.sealed_txid}`);
  console.log(`  tip courant    : ${tip} (tick ${tickCourant})`);
  console.log(`  tick_impact    : ${state.tick_impact}  (bloc ≥ ${blockImpact})`);
  if (tickCourant < state.tick_impact) {
    console.log(`  ⚠ encore ${state.tick_impact - tickCourant} tick(s) avant impact — le reveal sera scanné mais ignoré par boot tant que tip < ${blockImpact}`);
  }
  console.log('');
  console.log('--- reveal.yaml ---');
  console.log(revealYaml);

  if (flags.dryRun) {
    console.log('(dry-run) — ajoute --broadcast pour publier');
    return;
  }

  const result = await broadcastInscription(revealYaml, 'REVEAL');
  state.phase = 'revealed';
  state.reveal_txid = result.revealTxid;
  state.reveal_commit_txid = result.commitTxid;
  state.revealedAt = new Date().toISOString();
  await saveState(state);
  console.log(`\n✓ Reveal publié. Lance : node scripts/sealed-live.mjs verify`);
}

async function cmdVerify() {
  const state = await loadState();
  if (!state) {
    console.error('✗ pas d\'état');
    process.exit(1);
  }
  const api = API_URLS[state.network];

  console.log('━━━ VERIFY ━━━');
  console.log(`  scan API : ${api}`);

  // 1. Récupérer la TX sealed pour trouver son bloc
  async function fetchTxBlock(txid) {
    const r = await fetch(`${api}/tx/${txid}`);
    if (!r.ok) return null;
    const tx = await r.json();
    return tx.status?.block_height ?? null;
  }
  const sealedBlock = await fetchTxBlock(state.sealed_txid);
  console.log(`  sealed_txid    : ${state.sealed_txid}`);
  console.log(`  sealed dans bloc : ${sealedBlock ?? '(non confirmé)'}`);
  if (sealedBlock === null) {
    console.log('  ⚠ sealed pas encore dans un bloc — attends la confirmation');
    return;
  }

  // 2. Scanner ce bloc et confirmer notre sealed
  let foundSealed = null;
  for await (const ins of scanRange(sealedBlock, sealedBlock, { api, concurrency: 1 })) {
    if (ins.txid === state.sealed_txid) { foundSealed = ins; break; }
  }
  if (!foundSealed) {
    console.error('  ✗ scan n\'a pas retrouvé le sealed dans le bloc — wire format problème ?');
    process.exit(2);
  }
  console.log(`  ✓ sealed retrouvé via scan : opType=${foundSealed.opType}, opTypeByte=0x${foundSealed.opTypeByte.toString(16).padStart(2, '0')}`);
  const parsedOnChain = yparse(foundSealed.yaml);
  if (parsedOnChain.hash !== state.hash) {
    console.error(`  ✗ hash on-chain (${parsedOnChain.hash}) ≠ hash local (${state.hash})`);
    process.exit(3);
  }
  console.log(`  ✓ hash on-chain identique au hash local`);

  // 3. Idem pour le reveal s'il existe
  if (state.reveal_txid) {
    const revealBlock = await fetchTxBlock(state.reveal_txid);
    console.log(`  reveal_txid    : ${state.reveal_txid}`);
    console.log(`  reveal dans bloc : ${revealBlock ?? '(non confirmé)'}`);
    if (revealBlock) {
      let foundReveal = null;
      for await (const ins of scanRange(revealBlock, revealBlock, { api, concurrency: 1 })) {
        if (ins.txid === state.reveal_txid) { foundReveal = ins; break; }
      }
      if (!foundReveal) {
        console.error('  ✗ scan n\'a pas retrouvé le reveal');
        process.exit(4);
      }
      console.log(`  ✓ reveal retrouvé via scan : opType=${foundReveal.opType}, opTypeByte=0x${foundReveal.opTypeByte.toString(16).padStart(2, '0')}`);
      const revParsed = yparse(foundReveal.yaml);
      const recomputed = computeSealHash(revParsed.secret);
      if (recomputed !== state.hash) {
        console.error(`  ✗ hash recalculé depuis reveal on-chain (${recomputed}) ≠ hash sealed (${state.hash})`);
        process.exit(5);
      }
      console.log(`  ✓ sha256(canonicalJSON(reveal.secret)) === sealed.hash`);
      console.log(`\n🎉 Round-trip on-chain validé : sealed + reveal scellement opérationnel sur ${state.network}.`);
    } else {
      console.log('  ⚠ reveal pas encore dans un bloc');
    }
  } else {
    console.log(`  (pas encore de reveal — lance 'reveal --broadcast')`);
  }
}

async function cmdCleanup() {
  try {
    await fs.unlink(STATE_FILE);
    console.log(`✓ ${path.relative(ROOT, STATE_FILE)} supprimé`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.log('(rien à nettoyer)');
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const { cmd, opts, flags } = parseArgs(process.argv);
  if (!cmd || cmd === '--help' || cmd === '-h') { usage(); return; }
  switch (cmd) {
    case 'seal':    return cmdSeal({ opts, flags });
    case 'reveal':  return cmdReveal({ flags });
    case 'verify':  return cmdVerify();
    case 'cleanup': return cmdCleanup();
    default:
      console.error(`✗ commande inconnue : ${cmd}`);
      usage();
      process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
