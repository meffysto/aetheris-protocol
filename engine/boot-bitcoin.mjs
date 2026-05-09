// CITADEL // PROTOCOL — Boot Bitcoin (orchestrator browser).
// Reconstitue l'état complet du serveur en scannant la chain Bitcoin
// et en rejouant les ticks via runTick().
//
// Usage browser :
//   import { bootBitcoin } from './engine/boot-bitcoin.mjs';
//   const state = await bootBitcoin({
//     api: 'https://mutinynet.com/api',
//     genesisYaml, rulesYaml, galaxieYaml,  // textes fetched depuis le repo
//     log: msg => console.log(msg),
//   });
//   // → { manifest, rules, galaxie, empires, identites, tickCourant, blocGenesis, tip }

import { scanRange, fetchTipHeight } from './scan-bitcoin.mjs';
import { runTick, yparse, tickFromBlockHeight } from './tick-core.mjs';
import { spawnEmpireFromJoin } from './world-init-core.mjs';
import { resolveCombat, computeDebris, computePillage } from './combat.mjs';
import * as cache from './cache.mjs';

// Clé du cache scan (versionnée — bump si format change)
const SCAN_CACHE_KEY = 'scan-v2';  // v2: inclut inscriberPubKey

/**
 * @param {object} params
 * @param {string} params.api                 base Esplora URL
 * @param {string} params.genesisYaml         contenu de genesis/genesis.yaml
 * @param {string} params.rulesYaml           contenu de engine/rules.yaml
 * @param {string} params.galaxieYaml         contenu de world/galaxie.yaml (snapshot tick 0)
 * @param {function} [params.log]             (msg) => void
 * @param {function} [params.verifySignature] async (yamlContent, pubB64, sigB64) → bool
 * @param {function} [params.onProgress]      ({ phase, current, total }) => void
 * @returns {Promise<{
 *   manifest, rules, galaxie, empires, identites,
 *   tickCourant, blocGenesis, blocsParTick, tip,
 *   joins, ordersByTick,
 * }>}
 */
export async function bootBitcoin({
  api,
  genesisYaml, rulesYaml, galaxieYaml,
  log = () => {},
  verifySignature = null,
  onProgress = () => {},
  fromBlock,        // override pour reprise incrémentale (default = blocGenesis + 1)
}) {
  const genesis = yparse(genesisYaml);
  const rules = yparse(rulesYaml);
  const galaxie = yparse(galaxieYaml);

  const blocGenesis = genesis.ancrage?.bloc_genesis;
  const blocsParTick = genesis.parametres?.blocs_par_tick ?? 1;
  if (!blocGenesis) {
    throw new Error('genesis.ancrage.bloc_genesis manquant — la genesis n\'est probablement pas inscrite sur Bitcoin');
  }
  if (!api) throw new Error('bootBitcoin: api Esplora requis');

  // ─── État initial : manifest dérivé de genesis, empires vides ───────────
  let manifest = {
    version: 1,
    protocol_version: genesis.protocol_version,
    serveur: genesis.serveur,
    tick: 0,
    seed: genesis.seed,
    demarrage_iso: genesis.demarrage_iso,
    duree_tick_min: 15,
    parametres: { ...genesis.parametres },
    hash_etat: 'sha256:' + '0'.repeat(32),
  };
  let empires = {};
  const identites = {};

  // ─── Tip + tick courant ─────────────────────────────────────────────────
  log('▸ Lecture du tip Bitcoin…');
  const tip = await fetchTipHeight(api);
  const tickCourant = tickFromBlockHeight(tip, blocGenesis, blocsParTick, 0);
  log(`  bloc_genesis=${blocGenesis}, tip=${tip}, tick_courant=${tickCourant}`);

  // ─── Charge le cache scan si dispo ──────────────────────────────────────
  let cachedScan = null;
  try { cachedScan = await cache.get(SCAN_CACHE_KEY); } catch {}
  if (cachedScan && cachedScan.blocGenesis !== blocGenesis) {
    log('  ! cache scan d\'un autre serveur (blocGenesis différent) — reset');
    cachedScan = null;
  }

  // ─── Scan : collecte joins + ordres (incrémental) ───────────────────────
  const joins = cachedScan?.joins ? [...cachedScan.joins] : [];
  const ordersByTick = cachedScan?.ordersByTick ? { ...cachedScan.ordersByTick } : {};
  const lastCachedBlock = cachedScan?.lastBlock ?? blocGenesis;
  const scanFrom = fromBlock ?? (lastCachedBlock + 1);

  if (scanFrom > tip) {
    log(`  ✓ cache à jour (${joins.length} join(s) chargé(s) du cache)`);
  } else {
    log(`▸ Scan blocs ${scanFrom}..${tip} (${tip - scanFrom + 1} blocs${cachedScan ? ', incrémental depuis ' + lastCachedBlock : ''})…`);

    let scanned = 0;
    const total = Math.max(1, tip - scanFrom + 1);
    for await (const ins of scanRange(scanFrom, tip, {
      api,
      onBlock: h => {
        scanned = h - scanFrom + 1;
        if (scanned % 10 === 0 || scanned === total) {
          onProgress({ phase: 'scan', current: scanned, total });
        }
      },
    })) {
      if (ins.opType === 'join') {
        const parsed = yparse(ins.yaml);
        if (parsed?.joueur && parsed.joueur !== genesis.serveur) {
          joins.push({
            blockHeight: ins.blockHeight,
            txid: ins.txid,
            yaml: ins.yaml,
            parsed,
            inscriberPubKey: ins.inscriberPubKey,  // pubkey Schnorr de l'inscripteur
          });
        }
      } else if (ins.opType === 'order') {
        const parsed = yparse(ins.yaml);
        if (parsed?.joueur && parsed?.tick_cible) {
          const T = parsed.tick_cible;
          if (!ordersByTick[T]) ordersByTick[T] = {};
          if (!ordersByTick[T][parsed.joueur]) {
            ordersByTick[T][parsed.joueur] = {
              parsed, raw: ins.yaml, blockHeight: ins.blockHeight, txid: ins.txid,
              inscriberPubKey: ins.inscriberPubKey,
            };
          }
        }
      }
    }

    // Persist le cache scan (joins+orders+lastBlock)
    try {
      await cache.set(SCAN_CACHE_KEY, { blocGenesis, lastBlock: tip, joins, ordersByTick });
    } catch (e) {
      log(`  ! cache write skipped: ${e.message}`);
    }
  }

  // Tri des joins par bloc (cache + nouveaux)
  joins.sort((a, b) => a.blockHeight - b.blockHeight);
  log(`  → ${joins.length} join(s), ${Object.values(ordersByTick).reduce((a, m) => a + Object.keys(m).length, 0)} ordre(s) répartis sur ${Object.keys(ordersByTick).length} tick(s)`);

  // ─── Replay : tick par tick, intègre les joins en première fenêtre ─────
  log(`▸ Replay des ${tickCourant} tick(s)…`);
  let processedJoinIdx = 0;

  // Accumulateurs de rapports — l'engine les produit à chaque tick mais ils
  // étaient jetés. On les garde pour les surfacer dans l'UI (onglet Rapports).
  // intelByPlayer[name] = [{ tick, filename, content }]   (espionnages reçus/émis par 'name')
  // alertsByPlayer[name] = [{ tick, filename, content }]  (alertes : on a été espionné)
  // battles = [{ tick, filename, content, attaquant, defenseur, lieu, issue }]
  const intelByPlayer = {};
  const alertsByPlayer = {};
  const battles = [];

  for (let T = 1; T <= tickCourant; T++) {
    onProgress({ phase: 'replay', current: T, total: tickCourant });

    // Intègre les joins dont blockHeight ≤ blocGenesis + T*bpt
    const tickBlockMax = blocGenesis + T * blocsParTick;
    while (processedJoinIdx < joins.length && joins[processedJoinIdx].blockHeight <= tickBlockMax) {
      const j = joins[processedJoinIdx++];
      const playerName = j.parsed.joueur;
      if (empires[playerName]) continue; // déjà créé (rejointe ?)
      // RNG de spawn = seed:join:{player}:{blockHeight}  (déterministe)
      const { rngFromSeed } = await import('./tick-core.mjs');
      const rng = rngFromSeed(`${manifest.seed}:join:${playerName}:${j.blockHeight}`);
      try {
        const result = spawnEmpireFromJoin({
          joinData: j.parsed,
          galaxie,
          tick: T - 1,
          rng,
        });
        if (result) {
          empires[playerName] = result.empire;
          // Identité Bitcoin-native : la pubkey Schnorr de la TX d'inscription.
          // C'est le seul facteur d'authentification pour les ordres futurs.
          identites[playerName] = {
            cle_publique: j.inscriberPubKey ? `schnorr:${j.inscriberPubKey}` : null,
            join_block: j.blockHeight,
            join_txid: j.txid,
          };
          log(`  + join ${playerName} @ bloc ${j.blockHeight} (T=${T-1}) → ${result.empire.planetes[0]?.coordonnees?.join(':')} · pk ${j.inscriberPubKey?.slice(0,12)}…`);
        } else {
          log(`  ! join ${playerName}: aucune planète libre — ignoré`);
        }
      } catch (e) {
        log(`  ! join ${playerName}: ${e.message}`);
      }
    }

    // Récupère ordres pour ce tick — vérifie que l'inscripteur === pubkey du join.
    const orders = {};
    const ordersRawText = {};
    for (const [name, entry] of Object.entries(ordersByTick[T] ?? {})) {
      const expectedPk = identites[name]?.cle_publique;
      const gotPk = entry.inscriberPubKey ? `schnorr:${entry.inscriberPubKey}` : null;
      if (!expectedPk || !gotPk || expectedPk !== gotPk) {
        log(`  ✗ ordre ${name} (tick ${T}) : pubkey ${gotPk?.slice(0,20)}… ≠ identité ${expectedPk?.slice(0,20)}… — REJETÉ`);
        continue;
      }
      orders[name] = entry.parsed;
      ordersRawText[name] = entry.raw;
    }

    // Run le tick
    const result = await runTick({
      manifest, rules, galaxie,
      empires, orders, ordersRawText, identites,
      combat: { resolveCombat, computeDebris, computePillage },
      verifySignature,
      opts: { strict: false, log: () => {} },
    });
    manifest = result.newManifest;
    empires = result.newEmpires;

    // Collecte des rapports produits par ce tick
    const tickReports = result.reports || {};
    for (const r of (tickReports.intel || [])) {
      const player = r.player || _playerFromIntelFilename(r.filename);
      if (!player) continue;
      (intelByPlayer[player] ||= []).push({ tick: T, filename: r.filename, content: r.content });
    }
    for (const r of (tickReports.alerts || [])) {
      const player = r.player || _playerFromIntelFilename(r.filename);
      if (!player) continue;
      (alertsByPlayer[player] ||= []).push({ tick: T, filename: r.filename, content: r.content });
    }
    for (const r of (tickReports.battles || [])) {
      battles.push({ tick: T, filename: r.filename, content: r.content });
    }
    // Évènements de bataille servent à indexer les rapports par participant
    for (const ev of (result.events || [])) {
      if (ev.type === 'bataille') {
        const last = battles[battles.length - 1];
        if (last && last.tick === T && !last.attaquant) {
          last.attaquant = ev.attaquant;
          last.defenseur = ev.defenseur;
          last.lieu = ev.lieu;
          last.issue = ev.issue;
        }
      }
    }
  }

  log(`✓ Boot terminé — tick ${manifest.tick}, ${Object.keys(empires).length} empire(s)`);

  // ─── Roster Nostr : pubkeys Schnorr (32B hex x-only) des joueurs ────────
  // Utilisé par la messagerie NIP-17 pour whitelister les expéditeurs.
  // C'est exactement la même clé qui signe les inscriptions Bitcoin
  // (identites[name].cle_publique = "schnorr:<hex>"), donc l'identité du
  // jeu et l'identité de la messagerie sont une seule et même clé.
  const roster = new Set();
  for (const id of Object.values(identites)) {
    const pk = id?.cle_publique;
    if (typeof pk === 'string' && pk.startsWith('schnorr:')) {
      roster.add(pk.slice('schnorr:'.length));
    }
  }
  // Hook browser : expose globalement pour la console / la messagerie.
  if (typeof globalThis.window !== 'undefined') {
    globalThis.window.aetheris = globalThis.window.aetheris || {};
    globalThis.window.aetheris.roster = roster;
  }

  return {
    manifest, rules, galaxie, empires, identites,
    tickCourant, blocGenesis, blocsParTick, tip,
    joins, ordersByTick,
    roster,
    reports: { intelByPlayer, alertsByPlayer, battles },
  };
}

// joueurs/<name>/intel/tick-NNNN-...md → <name>
function _playerFromIntelFilename(fn) {
  const m = /^joueurs\/([^\/]+)\//.exec(fn || '');
  return m ? m[1] : null;
}
