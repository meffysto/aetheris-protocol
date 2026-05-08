// AETHERIS // PROTOCOL — Boot Bitcoin (orchestrator browser).
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

  // ─── Scan : collecte joins + ordres ─────────────────────────────────────
  const scanFrom = fromBlock ?? (blocGenesis + 1);
  log(`▸ Scan blocs ${scanFrom}..${tip} (${tip - scanFrom + 1} blocs)…`);

  const joins = []; // [{ blockHeight, yaml, parsed, txid }]
  const ordersByTick = {}; // { tick → { player → { parsed, raw, blockHeight, txid } } }

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
      // On ignore la genesis elle-même (joueur === serveur)
      if (parsed?.joueur && parsed.joueur !== genesis.serveur) {
        joins.push({ blockHeight: ins.blockHeight, txid: ins.txid, yaml: ins.yaml, parsed });
      }
    } else if (ins.opType === 'order') {
      const parsed = yparse(ins.yaml);
      if (parsed?.joueur && parsed?.tick_cible) {
        const T = parsed.tick_cible;
        if (!ordersByTick[T]) ordersByTick[T] = {};
        // Si plusieurs ordres pour le même joueur+tick, garde le 1er (= confirmé en premier)
        if (!ordersByTick[T][parsed.joueur]) {
          ordersByTick[T][parsed.joueur] = {
            parsed, raw: ins.yaml, blockHeight: ins.blockHeight, txid: ins.txid,
          };
        }
      }
    }
  }

  log(`  → ${joins.length} join(s), ${Object.values(ordersByTick).reduce((a, m) => a + Object.keys(m).length, 0)} ordre(s) répartis sur ${Object.keys(ordersByTick).length} tick(s)`);

  // ─── Replay : tick par tick, intègre les joins en première fenêtre ─────
  log(`▸ Replay des ${tickCourant} tick(s)…`);
  let processedJoinIdx = 0;

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
          if (j.parsed.cle_publique) {
            identites[playerName] = { cle_publique: j.parsed.cle_publique };
          }
          log(`  + join ${playerName} @ bloc ${j.blockHeight} (T=${T-1}) → ${result.empire.planetes[0]?.coordonnees?.join(':')}`);
        } else {
          log(`  ! join ${playerName}: aucune planète libre — ignoré`);
        }
      } catch (e) {
        log(`  ! join ${playerName}: ${e.message}`);
      }
    }

    // Récupère ordres pour ce tick
    const orders = {};
    const ordersRawText = {};
    for (const [name, entry] of Object.entries(ordersByTick[T] ?? {})) {
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
  }

  log(`✓ Boot terminé — tick ${manifest.tick}, ${Object.keys(empires).length} empire(s)`);

  return {
    manifest, rules, galaxie, empires, identites,
    tickCourant, blocGenesis, blocsParTick, tip,
    joins, ordersByTick,
  };
}
