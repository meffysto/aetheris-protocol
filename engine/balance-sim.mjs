#!/usr/bin/env node
// CITADEL // PROTOCOL — Simulateur de balance.
//
// Joue un build canonique sur N ticks et sort une courbe CSV des
// métriques clés (ressources, score, flotte, recherche). Utilisé pour
// évaluer l'équilibre de rules.yaml et détecter les seuils où la
// progression colle ou explose.
//
// Usage :
//   node engine/balance-sim.mjs <strategie> [--ticks=50] [--seed=0xabc]
//   node engine/balance-sim.mjs --list
//
// Stratégies disponibles : voir STRATEGIES en bas du fichier.
//
// Sortie : CSV sur stdout (tick, ressources, score, …) + un résumé final
// sur stderr avec alertes (stocks plafonnés, score qui stagne, etc.).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTick, yparse, rngFromSeed } from './tick-core.mjs';
import * as combat from './combat.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── Args parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { ticks: 50, seed: '0xbalance-sim', strategie: null, list: false };
  for (const a of argv.slice(2)) {
    if (a === '--list') args.list = true;
    else if (a.startsWith('--ticks=')) args.ticks = parseInt(a.slice(8), 10);
    else if (a.startsWith('--seed=')) args.seed = a.slice(7);
    else if (!a.startsWith('--')) args.strategie = a;
  }
  return args;
}

// ── Fixtures de départ ──────────────────────────────────────────────────
// Un joueur, 1 planète tellurique avec le starter pack standard (cohérent
// avec spawnEmpireFromJoin). Une mini-galaxie pour avoir des cibles si la
// stratégie veut envoyer un colon.

// Lit blocs_par_tick depuis genesis.yaml et dérive la durée d'un tick en
// minutes réelles (Mutinynet 30s/bloc). Aligné sur boot-bitcoin.mjs pour
// que la sim refléte exactement la cadence du serveur.
function readTickDurationMin() {
  try {
    const genesis = yparse(fs.readFileSync(path.join(ROOT, 'genesis/genesis.yaml'), 'utf8'));
    const blocsParTick = genesis?.parametres?.blocs_par_tick ?? 1;
    const SEC_PAR_BLOC = 30;
    return (blocsParTick * SEC_PAR_BLOC) / 60;
  } catch {
    return 3;  // fallback raisonnable si genesis absent (mode test)
  }
}

function buildInitialState({ seed }) {
  const rules = yparse(fs.readFileSync(path.join(ROOT, 'engine/rules.yaml'), 'utf8'));
  const dureeTickMin = readTickDurationMin();
  const manifest = {
    version: 1, serveur: 'balance-sim', tick: 0, seed,
    demarrage_iso: new Date().toISOString(),
    duree_tick_min: dureeTickMin,
    parametres: {
      galaxies: 1, systemes_par_galaxie: 3, positions_par_systeme: 15,
      planetes_max_par_joueur: 9,
    },
    hash_etat: 'sha256:' + '0'.repeat(32),
  };
  const galaxie = {
    version: 1, tick: 0,
    systemes: {
      '1:1': {
        etoile: { nom: 'stelara-1', type: 'G', temperature_k: 5800 },
        positions: {
          1: { type: 'planete', proprietaire: 'sim', nom: 'sim-prima', classe: 'tellurique' },
          2: { type: 'planete', proprietaire: null, classe: 'tellurique' },
          3: { type: 'planete', proprietaire: null, classe: 'cristalline' },
          4: { type: 'planete', proprietaire: null, classe: 'volcanique' },
          5: { type: 'asteroide' },
        },
      },
      '1:2': {
        etoile: { nom: 'stelara-2', type: 'K', temperature_k: 4800 },
        positions: {
          1: { type: 'planete', proprietaire: null, classe: 'glacee' },
          7: { type: 'planete', proprietaire: null, classe: 'tellurique' },
        },
      },
    },
  };

  const empire = {
    version: 1, joueur: 'sim', tick: 0, score_total: 0, points_militaires: 0, rang: 999,
    alliance: null,
    planetes: [{
      nom: 'sim-prima', coordonnees: [1, 1, 1], type: 'tellurique',
      champs: { utilises: 0, total: 240 },
      ressources: {
        ferrum:   { stock: 1000, production_par_utj: 0, capacite: 100000 },
        lumen:    { stock: 500,  production_par_utj: 0, capacite: 100000 },
        plasmide: { stock: 100,  production_par_utj: 0, capacite: 100000 },
      },
      energie: { production: 0, consommation: 0 },
      batiments: {
        mine_ferrum: 0, extracteur_lumen: 0, synthetiseur_plasmide: 0,
        centrale_solaire: 0, depot: 0, usine_robotique: 0,
        chantier_spatial: 0, laboratoire: 0,
        reacteur_fusion: 0, silo_missiles: 0,
        terminal_marchand: 0, centre_diplomatique: 0,
      },
      file_chantier: [], file_construction: [],
      flotte_au_sol: {}, defenses: {},
    }],
    flottes_en_vol: [], recherche: {}, file_recherche: [],
    ressources_globales: { singularite: 0, influence: 0 },
    progres_singularite_utj: 0, relations: {}, malus_moral_jusqu_tick: 0,
  };

  return { manifest, rules, galaxie, empires: { sim: empire } };
}

// ── Stratégies ──────────────────────────────────────────────────────────
// Une stratégie est une fonction (emp, manifest, rules, tick) -> ordres[].
// Elle inspecte l'état courant et décide quels ordres pousser pour ce tick.
// Convention : ne pousser un ordre que si on a les ressources pour le payer
// (sinon il sera rejeté et la stratégie semble stagner sans raison).

function canAffordChantier(planete, rules, batiment) {
  const cible = (planete.batiments[batiment] || 0) + 1;
  const def = rules.batiments?.[batiment];
  if (!def) return false;
  const mult = Math.pow(def.multiplicateur_cout || 1, cible - 1);
  for (const [res, n] of Object.entries(def.cout_base || {})) {
    if ((planete.ressources[res]?.stock || 0) < n * mult) return false;
  }
  return true;
}

function isQueueFree(planete) {
  return (planete.file_chantier || []).length === 0;
}

function buildOrder(planete, batiment) {
  return {
    type: 'chantier',
    planete: planete.nom,
    batiment,
    niveau_cible: (planete.batiments[batiment] || 0) + 1,
  };
}

// 1) Économie pure — rush mines/extracteurs, puis plasmide, puis dépôt.
function econRush(emp, manifest, rules, tick) {
  const p = emp.planetes[0];
  if (!isQueueFree(p)) return [];
  // Priorité : mine_ferrum < extracteur_lumen +2, synthetiseur dès qu'on peut.
  const mf = p.batiments.mine_ferrum || 0;
  const el = p.batiments.extracteur_lumen || 0;
  const sp = p.batiments.synthetiseur_plasmide || 0;
  const dep = p.batiments.depot || 0;
  // Si stock saturé ressources → monter dépôt.
  for (const r of ['ferrum', 'lumen']) {
    const info = p.ressources[r];
    if (info && info.stock > info.capacite * 0.9 && dep < 12) {
      if (canAffordChantier(p, rules, 'depot')) return [buildOrder(p, 'depot')];
    }
  }
  // Sinon, courbes d'investissement : mine prioritaire, lumen suit, plasmide arrive.
  const candidates = [];
  if (mf <= el) candidates.push('mine_ferrum');
  if (el < mf + 2) candidates.push('extracteur_lumen');
  if (mf >= 5 && sp < Math.floor(mf * 0.6)) candidates.push('synthetiseur_plasmide');
  candidates.push('mine_ferrum', 'extracteur_lumen');  // fallback
  for (const b of candidates) {
    if (canAffordChantier(p, rules, b)) return [buildOrder(p, b)];
  }
  return [];
}

// 2) Rush militaire — chantier_spatial dès que possible, puis construction
//    en flux continu de chasseur_leger.
function militaryRush(emp, manifest, rules, tick) {
  const p = emp.planetes[0];
  const orders = [];

  // Préreqs : mines/extracteurs/plasmide (usine demande 200 plasmide),
  // usine_robotique 2, puis chantier_spatial.
  if (isQueueFree(p)) {
    const ur = p.batiments.usine_robotique || 0;
    const cs = p.batiments.chantier_spatial || 0;
    const mf = p.batiments.mine_ferrum || 0;
    const el = p.batiments.extracteur_lumen || 0;
    const sp = p.batiments.synthetiseur_plasmide || 0;
    // Ordre de priorité avec fallbacks (le premier affordable l'emporte).
    const candidates = [];
    if (mf < 3) candidates.push('mine_ferrum');
    if (el < 3) candidates.push('extracteur_lumen');
    if (sp < 1) candidates.push('synthetiseur_plasmide');  // débloquer plasmide
    if (ur < 2) candidates.push('usine_robotique');
    if (cs < 4) candidates.push('chantier_spatial');
    if (mf < cs + 3) candidates.push('mine_ferrum');
    if (el < cs + 3) candidates.push('extracteur_lumen');
    candidates.push('mine_ferrum', 'extracteur_lumen', 'synthetiseur_plasmide');  // fallback
    for (const b of candidates) {
      if (canAffordChantier(p, rules, b)) { orders.push(buildOrder(p, b)); break; }
    }
  }

  // Construction continue dès que chantier_spatial ≥ 1.
  if ((p.batiments.chantier_spatial || 0) >= 1 && (p.file_construction || []).length < 1) {
    // Combien on peut s'en payer ? On en pousse 5 à la fois pour ne pas
    // saturer la file.
    const def = rules.vaisseaux?.chasseur_leger;
    if (def) {
      const qty = 5;
      const ferrumOk = (p.ressources.ferrum?.stock || 0) >= (def.cout?.ferrum || 0) * qty;
      const lumenOk = (p.ressources.lumen?.stock || 0) >= (def.cout?.lumen || 0) * qty;
      if (ferrumOk && lumenOk) {
        orders.push({ type: 'construction', planete: p.nom, unite: 'chasseur_leger', quantite: qty });
      }
    }
  }
  return orders;
}

// 3) Rush tech — laboratoire d'abord, puis enchaîne les recherches.
function techRush(emp, manifest, rules, tick) {
  const p = emp.planetes[0];
  const orders = [];

  // Laboratoire requiert 200 plasmide — il faut un synthétiseur d'abord.
  // Recherches consomment plus de lumen que de ferrum → équilibrer mines/extracteurs.
  if (isQueueFree(p)) {
    const lab = p.batiments.laboratoire || 0;
    const mf = p.batiments.mine_ferrum || 0;
    const el = p.batiments.extracteur_lumen || 0;
    const sp = p.batiments.synthetiseur_plasmide || 0;
    const candidates = [];
    // Garder mines/extracteurs équilibrés (extracteur prioritaire pour la recherche).
    if (el < mf - 1) candidates.push('extracteur_lumen');
    if (mf < 3) candidates.push('mine_ferrum');
    if (el < 3) candidates.push('extracteur_lumen');
    if (sp < 1) candidates.push('synthetiseur_plasmide');
    if (lab < 8) candidates.push('laboratoire');
    if (el < lab + 2) candidates.push('extracteur_lumen');
    if (mf < lab) candidates.push('mine_ferrum');
    if (sp < Math.floor(lab / 2)) candidates.push('synthetiseur_plasmide');
    candidates.push('extracteur_lumen', 'mine_ferrum', 'synthetiseur_plasmide');
    for (const b of candidates) {
      if (canAffordChantier(p, rules, b)) { orders.push(buildOrder(p, b)); break; }
    }
  }

  // Recherche : monte robotique, automation_miniere, fusion_controlee en boucle.
  if ((emp.file_recherche || []).length === 0 && (p.batiments.laboratoire || 0) >= 1) {
    const techs = ['robotique', 'automation_miniere', 'armement', 'fusion_controlee', 'drives_impulsion'];
    for (const tech of techs) {
      const cur = emp.recherche?.[tech] || 0;
      if (cur < 6) {
        const def = rules.recherches?.[tech];
        if (!def) continue;
        const mult = Math.pow(def.mult || 1, cur);
        const cout = def.cout_base || {};
        let canPay = true;
        for (const [res, n] of Object.entries(cout)) {
          if ((p.ressources[res]?.stock || 0) < n * mult) { canPay = false; break; }
        }
        if (canPay) {
          orders.push({ type: 'recherche', technologie: tech, niveau_cible: cur + 1 });
          break;
        }
      }
    }
  }
  return orders;
}

// 4) Coloniseur — économie de base puis vaisseau_colon dès que possible,
//    coloniser la première case libre du système voisin.
function colonRush(emp, manifest, rules, tick) {
  const p = emp.planetes[0];
  const orders = [];

  // Économie + chantier + laboratoire (drives_impulsion requis pour colon).
  if (isQueueFree(p)) {
    const mf = p.batiments.mine_ferrum || 0;
    const el = p.batiments.extracteur_lumen || 0;
    const sp = p.batiments.synthetiseur_plasmide || 0;
    const ur = p.batiments.usine_robotique || 0;
    const cs = p.batiments.chantier_spatial || 0;
    const lab = p.batiments.laboratoire || 0;
    const candidates = [];
    if (mf < 3) candidates.push('mine_ferrum');
    if (el < 3) candidates.push('extracteur_lumen');
    if (sp < 1) candidates.push('synthetiseur_plasmide');
    if (lab < 3) candidates.push('laboratoire');
    if (mf < 5) candidates.push('mine_ferrum');
    if (el < 5) candidates.push('extracteur_lumen');
    if (sp < 3) candidates.push('synthetiseur_plasmide');
    if (ur < 2) candidates.push('usine_robotique');
    if (cs < 2) candidates.push('chantier_spatial');
    if (mf < 8) candidates.push('mine_ferrum');
    if (el < 8) candidates.push('extracteur_lumen');
    candidates.push('mine_ferrum', 'extracteur_lumen', 'synthetiseur_plasmide');
    for (const b of candidates) {
      if (canAffordChantier(p, rules, b)) { orders.push(buildOrder(p, b)); break; }
    }
  }

  // Recherche drives_impulsion 3 (requis pour vaisseau_colon).
  if ((emp.recherche?.drives_impulsion || 0) < 3 && (emp.file_recherche || []).length === 0
      && (p.batiments.laboratoire || 0) >= 1) {
    const def = rules.recherches?.drives_impulsion;
    const cur = emp.recherche?.drives_impulsion || 0;
    const mult = Math.pow(def.mult || 1, cur);
    if ((p.ressources.ferrum?.stock || 0) >= (def.cout_base.ferrum || 0) * mult
     && (p.ressources.lumen?.stock || 0) >= (def.cout_base.lumen || 0) * mult) {
      orders.push({ type: 'recherche', technologie: 'drives_impulsion', niveau_cible: cur + 1 });
    }
  }

  // Construction d'un colon dès que prérequis OK et ressources dispo.
  if ((p.batiments.chantier_spatial || 0) >= 1
      && (emp.recherche?.drives_impulsion || 0) >= 3
      && (p.flotte_au_sol?.vaisseau_colon || 0) === 0
      && (p.file_construction || []).length === 0) {
    const def = rules.vaisseaux.vaisseau_colon;
    const ferrumOk = (p.ressources.ferrum?.stock || 0) >= (def.cout.ferrum || 0);
    const lumenOk  = (p.ressources.lumen?.stock || 0) >= (def.cout.lumen || 0);
    const plasmOk  = (p.ressources.plasmide?.stock || 0) >= (def.cout.plasmide || 0);
    if (ferrumOk && lumenOk && plasmOk) {
      orders.push({ type: 'construction', planete: p.nom, unite: 'vaisseau_colon', quantite: 1 });
    }
  }

  // Envoi colonisation si un colon est prêt.
  if ((p.flotte_au_sol?.vaisseau_colon || 0) >= 1
      && (emp.flottes_en_vol || []).filter(f => f.type_mission === 'colonisation').length === 0) {
    orders.push({
      type: 'colonisation',
      depuis: p.nom,
      cible: { systeme: '1:1', position: 2 },
      flotte: { vaisseau_colon: 1 },
      cargaison: {},
    });
  }

  return orders;
}

const STRATEGIES = {
  'econ-rush':     { fn: econRush,     desc: 'Économie pure : mines + extracteurs + plasmide + dépôt' },
  'military-rush': { fn: militaryRush, desc: 'Militaire précoce : chantier_spatial + chasseur_leger en flux' },
  'tech-rush':     { fn: techRush,     desc: 'Laboratoire + enchaînement recherches' },
  'colon-rush':    { fn: colonRush,    desc: 'Économie + colon + colonisation 1:1:2' },
};

// ── Runner ──────────────────────────────────────────────────────────────

async function runSim({ strategie, ticks, seed }) {
  const fn = STRATEGIES[strategie]?.fn;
  if (!fn) throw new Error(`Stratégie inconnue: ${strategie}. Voir --list.`);

  let state = buildInitialState({ seed });
  const dureeTickMin = state.manifest.duree_tick_min;
  const csv = [];
  csv.push('tick,minutes,ferrum,lumen,plasmide,score,planetes,flotte_au_sol,recherches,en_vol');

  for (let t = 0; t < ticks; t++) {
    const emp = state.empires.sim;
    const orders = fn(emp, state.manifest, state.rules, t);
    const ordresPkg = orders.length
      ? { sim: { joueur: 'sim', tick_cible: state.manifest.tick + 1, ordres: orders } }
      : {};

    const result = await runTick({
      manifest: state.manifest,
      rules: state.rules,
      galaxie: state.galaxie,
      empires: state.empires,
      orders: ordresPkg,
      identites: {},
      combat,
      opts: { log: () => {} },  // silence
    });

    state.manifest = result.newManifest;
    state.empires = result.newEmpires;
    state.galaxie = result.newGalaxie;

    const e2 = state.empires.sim;
    const p = e2.planetes[0];
    const ships = Object.values(p.flotte_au_sol || {}).reduce((a, b) => a + b, 0);
    const techs = Object.entries(e2.recherche || {}).filter(([, v]) => v > 0).length;
    const enVol = (e2.flottes_en_vol || []).length;
    const minutes = Math.round((t + 1) * dureeTickMin);
    csv.push([
      t + 1,
      minutes,
      Math.floor(p.ressources.ferrum.stock),
      Math.floor(p.ressources.lumen.stock),
      Math.floor(p.ressources.plasmide.stock),
      e2.score_total,
      e2.planetes.length,
      ships,
      techs,
      enVol,
    ].join(','));
  }

  return { csv, finalState: state, dureeTickMin };
}

// ── Diagnostics ─────────────────────────────────────────────────────────

function diagnose(rows) {
  const alerts = [];
  // Score stagne sur >10 ticks d'affilée ?
  let stagnePour = 0, lastScore = -1;
  for (const r of rows.slice(1)) {
    const score = parseInt(r.split(',')[5], 10);
    if (score === lastScore) stagnePour++; else stagnePour = 0;
    lastScore = score;
    if (stagnePour >= 10) {
      alerts.push(`Score stagne ${stagnePour} ticks consécutifs (tick ${r.split(',')[0]}) — la stratégie est probablement bloquée par ressources/prérequis.`);
      break;
    }
  }
  // Stock plafonné ? (égal à 100000 sur >5 ticks)
  for (const r of rows.slice(-10)) {
    const [, , ferrum, lumen] = r.split(',').map(Number);
    if (ferrum >= 100000) {
      alerts.push(`Ferrum plafonné à ${ferrum} dans les derniers ticks — dépôt sous-investi.`);
      break;
    }
    if (lumen >= 100000) {
      alerts.push(`Lumen plafonné à ${lumen} — dépôt sous-investi.`);
      break;
    }
  }
  return alerts;
}

// ── Main ────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);
if (args.list) {
  console.log('Stratégies disponibles :');
  for (const [k, v] of Object.entries(STRATEGIES)) {
    console.log(`  ${k.padEnd(16)} ${v.desc}`);
  }
  process.exit(0);
}
if (!args.strategie) {
  console.error('Usage: node engine/balance-sim.mjs <strategie> [--ticks=50] [--seed=...]');
  console.error('Voir : node engine/balance-sim.mjs --list');
  process.exit(2);
}

const { csv, finalState, dureeTickMin } = await runSim(args);
process.stdout.write(csv.join('\n') + '\n');

const alerts = diagnose(csv);
if (alerts.length) {
  process.stderr.write('\n⚠ Diagnostics :\n');
  for (const a of alerts) process.stderr.write(`  - ${a}\n`);
}

const e = finalState.empires.sim;
const p = e.planetes[0];
const totalMin = Math.round(args.ticks * dureeTickMin);
process.stderr.write(`\n✓ Sim terminée — ${args.ticks} ticks × ${dureeTickMin} min/tick = ~${totalMin} min de jeu réel\n`);
process.stderr.write(`  Stratégie  : ${args.strategie}\n`);
process.stderr.write(`  Score final: ${e.score_total}\n`);
process.stderr.write(`  Planètes   : ${e.planetes.length}\n`);
process.stderr.write(`  Bâtiments  : ${Object.entries(p.batiments).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ')}\n`);
process.stderr.write(`  Recherches : ${Object.entries(e.recherche || {}).map(([k, n]) => `${k}=${n}`).join(' ') || '(aucune)'}\n`);
process.stderr.write(`  Flotte     : ${Object.entries(p.flotte_au_sol).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ') || '(aucune)'}\n`);
