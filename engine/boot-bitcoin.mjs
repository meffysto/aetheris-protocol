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
const SCAN_CACHE_KEY = 'scan-v3';  // v3: inclut sealedByTick + revealsByTick

// Clé du snapshot replay (versionnée — bump si format change ou si
// la sémantique de runTick évolue de façon non-rétrocompatible).
// Au boot, un snapshot dont la version diffère est ignoré (full replay).
const REPLAY_SNAPSHOT_KEY = 'replay-snapshot-v1';
const REPLAY_SNAPSHOT_VERSION = 1;

// Fréquence d'écriture du snapshot pendant le replay (resilience aux crashes
// d'onglet). À la fin du replay, un snapshot final est toujours écrit.
const SNAPSHOT_EVERY_TICKS = 200;

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

  // Mutinynet vise 30s/bloc ; mainnet 10min/bloc. Pour l'instant on assume
  // Mutinynet (le seul réseau supporté par boot-bitcoin), donc 1 tick =
  // blocsParTick × 30s. duree_tick_min sert au countdown UI et aux ETA.
  const SEC_PAR_BLOC = 30;
  const dureeTickMin = (blocsParTick * SEC_PAR_BLOC) / 60;

  // ─── État initial : manifest dérivé de genesis, empires vides ───────────
  let manifest = {
    version: 1,
    protocol_version: genesis.protocol_version,
    serveur: genesis.serveur,
    tick: 0,
    seed: genesis.seed,
    demarrage_iso: genesis.demarrage_iso,
    duree_tick_min: dureeTickMin,
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
  // sealedByTick[T_depart][joueur] = { parsed, raw, txid, blockHeight, inscriberPubKey }
  // revealsByTick[T_impact] = [{ parsed, raw, txid, blockHeight, inscriberPubKey, joueur }]
  // (plusieurs reveals possibles par tick par joueur — un par sceau distinct)
  const sealedByTick = cachedScan?.sealedByTick ? { ...cachedScan.sealedByTick } : {};
  const revealsByTick = cachedScan?.revealsByTick ? { ...cachedScan.revealsByTick } : {};
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
      } else if (ins.opType === 'sealed') {
        const parsed = yparse(ins.yaml);
        if (parsed?.joueur && Number.isInteger(parsed?.tick_depart)) {
          const T = parsed.tick_depart;
          if (!sealedByTick[T]) sealedByTick[T] = {};
          // Un seul sceau actif par (tick_depart, joueur) — last-wins.
          // Si un joueur veut sceller plusieurs attaques le même tick, il les
          // groupera dans un seul commit en v2 (v1 = un sceau / tick).
          const prev = sealedByTick[T][parsed.joueur];
          const isNewer = !prev
            || ins.blockHeight > prev.blockHeight
            || (ins.blockHeight === prev.blockHeight && ins.txid > prev.txid);
          if (isNewer) {
            sealedByTick[T][parsed.joueur] = {
              parsed, raw: ins.yaml, txid: ins.txid,
              blockHeight: ins.blockHeight, inscriberPubKey: ins.inscriberPubKey,
            };
          }
        }
      } else if (ins.opType === 'reveal') {
        const parsed = yparse(ins.yaml);
        if (parsed?.joueur && Number.isInteger(parsed?.tick_impact)) {
          const T = parsed.tick_impact;
          if (!revealsByTick[T]) revealsByTick[T] = [];
          // Dédupe par sealed_txid (le même reveal peut être réinscrit accidentellement)
          if (!revealsByTick[T].some(r => r.parsed?.sealed_txid === parsed.sealed_txid)) {
            revealsByTick[T].push({
              parsed, raw: ins.yaml, txid: ins.txid,
              blockHeight: ins.blockHeight, inscriberPubKey: ins.inscriberPubKey,
              joueur: parsed.joueur,
            });
          }
        }
      } else if (ins.opType === 'order') {
        const parsed = yparse(ins.yaml);
        if (parsed?.joueur && parsed?.tick_cible) {
          const T = parsed.tick_cible;
          if (!ordersByTick[T]) ordersByTick[T] = {};
          // Last-wins par (tick, joueur) : la dernière inscription remplace
          // les précédentes pour le même tick cible. Côté UX, le client
          // accumule les ordres dans un panier local et fait UNE inscription
          // par tick — mais si jamais l'utilisateur force plusieurs pushes
          // (edge case), c'est la plus récente qui fait foi.
          // Tri : blockHeight DESC, txid lexicographique DESC en tiebreaker
          // (txid est inversé little-endian, mais une comparaison stable
          // suffit pour départager deux inscriptions dans le même bloc).
          const prev = ordersByTick[T][parsed.joueur];
          const isNewer = !prev
            || ins.blockHeight > prev.blockHeight
            || (ins.blockHeight === prev.blockHeight && ins.txid > prev.txid);
          if (isNewer) {
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
      await cache.set(SCAN_CACHE_KEY, { blocGenesis, lastBlock: tip, joins, ordersByTick, sealedByTick, revealsByTick });
    } catch (e) {
      log(`  ! cache write skipped: ${e.message}`);
    }
  }

  // Tri des joins par bloc (cache + nouveaux)
  joins.sort((a, b) => a.blockHeight - b.blockHeight);
  log(`  → ${joins.length} join(s), ${Object.values(ordersByTick).reduce((a, m) => a + Object.keys(m).length, 0)} ordre(s) répartis sur ${Object.keys(ordersByTick).length} tick(s)`);

  // ─── Replay : tick par tick, intègre les joins en première fenêtre ─────
  // Accumulateurs de rapports — l'engine les produit à chaque tick mais ils
  // étaient jetés. On les garde pour les surfacer dans l'UI (onglet Rapports).
  let intelByPlayer = {};
  let alertsByPlayer = {};
  let battles = [];

  // Tentative de reprise sur snapshot. Si valide (même genesis, même version)
  // et tick ≤ tickCourant, on saute le replay des ticks déjà calculés.
  // Sinon : fallback transparent vers full replay depuis le tick 1.
  let startTick = 1;
  let cachedSnapshot = null;
  try { cachedSnapshot = await cache.get(REPLAY_SNAPSHOT_KEY); } catch {}
  if (cachedSnapshot
      && cachedSnapshot.version === REPLAY_SNAPSHOT_VERSION
      && cachedSnapshot.blocGenesis === blocGenesis
      && Number.isInteger(cachedSnapshot.tick)
      && cachedSnapshot.tick >= 1
      && cachedSnapshot.tick <= tickCourant) {
    try {
      manifest = cachedSnapshot.manifest;
      empires = cachedSnapshot.empires;
      Object.assign(identites, cachedSnapshot.identites || {});
      // La galaxie évolue par mutation (colonisations) — la restaurer depuis le snapshot
      // sinon les coordonnées des planètes colonisées disparaîtraient.
      if (cachedSnapshot.galaxie) {
        Object.keys(galaxie).forEach(k => delete galaxie[k]);
        Object.assign(galaxie, cachedSnapshot.galaxie);
      }
      intelByPlayer = cachedSnapshot.intelByPlayer || {};
      alertsByPlayer = cachedSnapshot.alertsByPlayer || {};
      battles = cachedSnapshot.battles || [];
      startTick = cachedSnapshot.tick + 1;
      log(`✓ Snapshot reprise tick ${cachedSnapshot.tick} (saute ${cachedSnapshot.tick} tick(s) du replay)`);
    } catch (e) {
      log(`  ! snapshot corrompu (${e.message}) — full replay`);
      startTick = 1;
      intelByPlayer = {};
      alertsByPlayer = {};
      battles = [];
    }
  }

  log(`▸ Replay tick ${startTick}..${tickCourant} (${tickCourant - startTick + 1} tick(s))…`);

  // processedJoinIdx avance jusqu'au premier join non encore intégré dans
  // l'état actuel. Si on reprend sur snapshot, on saute les joins déjà
  // intégrés (blockHeight ≤ blocGenesis + (startTick-1)*bpt).
  let processedJoinIdx = 0;
  if (startTick > 1) {
    const cutBlock = blocGenesis + (startTick - 1) * blocsParTick;
    while (processedJoinIdx < joins.length && joins[processedJoinIdx].blockHeight <= cutBlock) {
      processedJoinIdx++;
    }
  }

  // Helper : sérialise l'état courant en snapshot. Async, fail-soft.
  const writeSnapshot = async (atTick) => {
    try {
      await cache.set(REPLAY_SNAPSHOT_KEY, {
        version: REPLAY_SNAPSHOT_VERSION,
        blocGenesis,
        tick: atTick,
        manifest, empires, galaxie, identites,
        intelByPlayer, alertsByPlayer, battles,
        writtenAt: Date.now(),
      });
    } catch (e) {
      log(`  ! snapshot write skipped @ tick ${atTick}: ${e.message}`);
    }
  };

  for (let T = startTick; T <= tickCourant; T++) {
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

    // Sealed du tick T (sealed.tick_depart === T) : vérifie pubkey inscripteur.
    // sealedOrders[name] = { parsed, txid }  — un sceau / joueur / tick (v1).
    const sealedOrders = {};
    for (const [name, entry] of Object.entries(sealedByTick[T] ?? {})) {
      const expectedPk = identites[name]?.cle_publique;
      const gotPk = entry.inscriberPubKey ? `schnorr:${entry.inscriberPubKey}` : null;
      if (!expectedPk || !gotPk || expectedPk !== gotPk) {
        log(`  ✗ sealed ${name} (tick ${T}) : pubkey ${gotPk?.slice(0,20)}… ≠ identité — REJETÉ`);
        continue;
      }
      sealedOrders[name] = { parsed: entry.parsed, txid: entry.txid };
    }

    // Reveals du tick T (reveal.tick_impact === T) : vérifie pubkey inscripteur.
    // revealOrders = [{ parsed, txid, joueur }] — plusieurs sceaux peuvent
    // arriver à impact au même tick.
    const revealOrders = [];
    for (const entry of (revealsByTick[T] ?? [])) {
      const expectedPk = identites[entry.joueur]?.cle_publique;
      const gotPk = entry.inscriberPubKey ? `schnorr:${entry.inscriberPubKey}` : null;
      if (!expectedPk || !gotPk || expectedPk !== gotPk) {
        log(`  ✗ reveal ${entry.joueur} (tick ${T}) : pubkey ${gotPk?.slice(0,20)}… ≠ identité — REJETÉ`);
        continue;
      }
      revealOrders.push({ parsed: entry.parsed, txid: entry.txid, joueur: entry.joueur });
    }

    // Run le tick
    const result = await runTick({
      manifest, rules, galaxie,
      empires, orders, ordersRawText, identites,
      sealedOrders, revealOrders,
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

    // Snapshot intermédiaire — resilience aux crashes d'onglet pendant le
    // replay. À éviter d'await dans la boucle (perf), donc fire-and-forget.
    if (T % SNAPSHOT_EVERY_TICKS === 0 && T < tickCourant) {
      writeSnapshot(T);
    }
  }

  // Snapshot final — toujours awaité pour que le prochain boot bénéficie
  // du replay qu'on vient de terminer.
  if (tickCourant >= 1) await writeSnapshot(tickCourant);

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
