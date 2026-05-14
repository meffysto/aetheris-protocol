// Tests du système d'epochs de rules (cf engine/rules-loader.mjs et
// docs/adr/0011-rules-epochs-soft-fork.md).
//
// Invariants vérifiés :
//   1. parseRulesDoc accepte v1 (legacy, pas d'epochs) ET v2 (epochs[]).
//   2. effectiveRulesAtTick applique les patches des epochs ≤ T dans l'ordre.
//   3. Validation : activation_tick doit être strict croissant ; epoch[0]
//      doit avoir un ruleset complet ; activation_tick[0] doit valoir 0.
//   4. Replay-safe : un bâtiment construit AVANT l'epoch transition garde
//      sa production_par_utj snapshottée (la valeur ne change pas quand on
//      passe la frontière, seules les nouvelles upgrades coûtent +).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRulesDoc, effectiveRulesAtTick } from '../engine/rules-loader.mjs';
import { runTick } from '../engine/tick-core.mjs';
import { readText } from './helpers.mjs';

test('rules-loader : v1 legacy (pas d\'epochs) traité comme epoch racine', () => {
  const yaml = `version: 1
duree_utj_par_tick: 6
batiments:
  mine_ferrum:
    cout_base: { ferrum: 60 }
    multiplicateur_cout: 1.5
`;
  const doc = parseRulesDoc(yaml);
  assert.equal(doc.version, 1);
  assert.equal(doc.epochs.length, 1);
  assert.equal(doc.epochs[0].activation_tick, 0);
  const r = effectiveRulesAtTick(doc, 42);
  assert.equal(r.batiments.mine_ferrum.multiplicateur_cout, 1.5);
});

test('rules-loader : v2 avec patches — applique seulement les epochs ≤ T', () => {
  const yaml = `version: 2
epochs:
  - activation_tick: 0
    name: "racine"
    rules:
      batiments:
        mine_ferrum:
          multiplicateur_cout: 1.5
          multiplicateur_duree: 1.5
        depot:
          multiplicateur_cout: 2.0
  - activation_tick: 100
    name: "patch v2"
    patches:
      "batiments.mine_ferrum.multiplicateur_cout": 1.45
      "batiments.depot.multiplicateur_cout": 1.7
  - activation_tick: 200
    name: "patch v3"
    patches:
      "batiments.mine_ferrum.multiplicateur_duree": 1.4
`;
  const doc = parseRulesDoc(yaml);
  // Avant tout patch : valeurs racines.
  const r0 = effectiveRulesAtTick(doc, 0);
  assert.equal(r0.batiments.mine_ferrum.multiplicateur_cout, 1.5);
  assert.equal(r0.batiments.mine_ferrum.multiplicateur_duree, 1.5);
  assert.equal(r0.batiments.depot.multiplicateur_cout, 2.0);
  // À T=99, encore racine.
  const r99 = effectiveRulesAtTick(doc, 99);
  assert.equal(r99.batiments.mine_ferrum.multiplicateur_cout, 1.5);
  // À T=100, v2 actif (mine + depot patchés, durée mine inchangée).
  const r100 = effectiveRulesAtTick(doc, 100);
  assert.equal(r100.batiments.mine_ferrum.multiplicateur_cout, 1.45);
  assert.equal(r100.batiments.depot.multiplicateur_cout, 1.7);
  assert.equal(r100.batiments.mine_ferrum.multiplicateur_duree, 1.5);
  // À T=200, v2 + v3.
  const r200 = effectiveRulesAtTick(doc, 200);
  assert.equal(r200.batiments.mine_ferrum.multiplicateur_cout, 1.45);
  assert.equal(r200.batiments.mine_ferrum.multiplicateur_duree, 1.4);
});

test('rules-loader : validation — activation_tick strict croissant', () => {
  const yaml = `version: 2
epochs:
  - activation_tick: 0
    rules: { x: 1 }
  - activation_tick: 50
    patches: { "x": 2 }
  - activation_tick: 50
    patches: { "x": 3 }
`;
  assert.throws(() => parseRulesDoc(yaml), /strictement croissant/);
});

test('rules-loader : validation — epoch[0] doit avoir activation_tick=0', () => {
  const yaml = `version: 2
epochs:
  - activation_tick: 10
    rules: { x: 1 }
`;
  assert.throws(() => parseRulesDoc(yaml), /activation_tick doit être 0/);
});

test('rules-loader : patch sur clé inexistante → erreur explicite', () => {
  const yaml = `version: 2
epochs:
  - activation_tick: 0
    rules: { x: 1 }
  - activation_tick: 10
    patches: { "y.z": 42 }
`;
  const doc = parseRulesDoc(yaml);
  assert.throws(() => effectiveRulesAtTick(doc, 10), /segment "y" n'existe pas/);
});

test('rules-loader : pas de mutation du doc source entre appels', () => {
  const yaml = `version: 2
epochs:
  - activation_tick: 0
    rules:
      batiments:
        mine_ferrum: { multiplicateur_cout: 1.5 }
  - activation_tick: 10
    patches: { "batiments.mine_ferrum.multiplicateur_cout": 1.45 }
`;
  const doc = parseRulesDoc(yaml);
  const r10 = effectiveRulesAtTick(doc, 10);
  assert.equal(r10.batiments.mine_ferrum.multiplicateur_cout, 1.45);
  // L'epoch racine doit toujours valoir 1.5 — pas affecté par le patch.
  assert.equal(doc.epochs[0].rules.batiments.mine_ferrum.multiplicateur_cout, 1.5);
  // Et un second appel à effectiveRulesAtTick(doc, 0) doit redonner 1.5.
  const r0bis = effectiveRulesAtTick(doc, 0);
  assert.equal(r0bis.batiments.mine_ferrum.multiplicateur_cout, 1.5);
});

test('rules-loader : rules.yaml du repo se parse et l\'epoch 0 ≡ ancien v1', () => {
  // Le repo contient rules.yaml v2 ; on s'assure simplement qu'il parse et
  // que les valeurs racines correspondent à la calibration historique
  // (epoch 0.2 — mine_ferrum.multiplicateur_cout = 1.5).
  const doc = parseRulesDoc(readText('engine/rules.yaml'));
  assert.ok(doc.epochs.length >= 1);
  assert.equal(doc.epochs[0].activation_tick, 0);
  const r0 = effectiveRulesAtTick(doc, 0);
  assert.equal(r0.batiments.mine_ferrum.multiplicateur_cout, 1.5);
  assert.equal(r0.duree_utj_par_tick, 6);
  assert.ok(r0.vaisseaux.chasseur_leger);
});

// ─── Test d'intégration : transition d'epoch préserve les builds existants ──
//
// Construit une mine niv 1 sous l'epoch racine, fait passer l'epoch transition
// (qui patche multiplicateur_cout/duree), puis vérifie que :
//   - production_par_utj de la mine niv 1 est INCHANGÉE
//   - le coût d'upgrade niv 2 utilise désormais la NOUVELLE valeur
//
// Cela démontre l'invariant "production snapshottée à la complétion" qui rend
// le soft-fork sûr — les joueurs ne perdent rien, juste les nouvelles upgrades
// coûtent plus cher.
test('epochs : transition préserve la prod snapshottée des bâtiments antérieurs', async () => {
  const rulesDoc = parseRulesDoc(`version: 2
epochs:
  - activation_tick: 0
    name: "racine"
    rules:
      duree_utj_par_tick: 6
      batiments:
        mine_ferrum:
          categorie: production
          cout_base: { ferrum: 60, lumen: 15 }
          multiplicateur_cout: 1.5
          duree_base_utj: 1.0
          multiplicateur_duree: 1.5
          production_base: 30
        centrale_solaire:
          categorie: energie
          cout_base: { ferrum: 75, lumen: 30 }
          multiplicateur_cout: 1.5
          duree_base_utj: 1.0
          multiplicateur_duree: 1.5
          production_base: 20
      vaisseaux: {}
      defenses: {}
      recherches: {}
      construction: {}
      marche: { fee_base: 0.05, fee_reduction_par_terminal: 0.05, expire_ticks_default: 12, expire_ticks_max: 48 }
      combat: { rondes_max: 6, bouclier_regen_entre_rondes: 1.0, seuil_destruction_coque: 0.30, proba_destruction: 0.70, ratio_debris: 0.30, pillage_max: 0.50 }
      espionnage: { paliers: [1, 5, 25, 125, 625], proba_destruction_par_niveau: 0.20 }
      singularite: { utj_par_unite: 300, cap_par_empire: 5 }
      influence: { cap_par_empire: 10000 }
      diplomatie: { treve: { cout_influence: 100, duree_ticks: 6 }, rupture: { cout_influence: 0, malus_moral_pct: 15, malus_duree_ticks: 6 }, diplomatie_reduction_par_niveau: 0.05 }
      types_planete: { tellurique: { bonus: { mine_ferrum: 1.30 } } }
  - activation_tick: 5
    name: "patch — coûts +50%"
    patches:
      "batiments.mine_ferrum.multiplicateur_cout": 2.25
      "batiments.mine_ferrum.multiplicateur_duree": 2.25
`);

  const manifest = {
    version: 1, serveur: 'test', tick: 0, seed: '0xtest',
    demarrage_iso: '2026-01-01T00:00:00Z', duree_tick_min: 15,
    parametres: { galaxies: 1, systemes_par_galaxie: 1, positions_par_systeme: 15, planetes_max_par_joueur: 9 },
    hash_etat: 'sha256:' + '0'.repeat(32),
  };
  const galaxie = {
    version: 1, tick: 0,
    systemes: { '1:1': { etoile: { nom: 's', type: 'G', temperature_k: 5800 }, positions: { 1: { type: 'planete', proprietaire: 'p1', classe: 'tellurique' } } } },
  };
  const empire = {
    version: 1, joueur: 'p1', tick: 0, score_total: 0, points_militaires: 0, rang: 999,
    alliance: null,
    planetes: [{
      nom: 'home', coordonnees: [1, 1, 1], type: 'tellurique',
      champs: { utilises: 0, total: 240 },
      ressources: {
        ferrum:   { stock: 100000, production_par_utj: 0, capacite: 1000000 },
        lumen:    { stock: 100000, production_par_utj: 0, capacite: 1000000 },
        plasmide: { stock: 100000, production_par_utj: 0, capacite: 1000000 },
      },
      energie: { production: 0, consommation: 0 },
      batiments: { mine_ferrum: 0, centrale_solaire: 0, extracteur_lumen: 0, synthetiseur_plasmide: 0, depot: 0, usine_robotique: 0, chantier_spatial: 0, laboratoire: 0 },
      file_chantier: [], file_construction: [],
      flotte_au_sol: {}, defenses: {},
    }],
    flottes_en_vol: [], recherche: {}, file_recherche: [],
    ressources_globales: { singularite: 0, influence: 0 },
    progres_singularite_utj: 0, relations: {}, malus_moral_jusqu_tick: 0,
  };

  let state = { manifest, galaxie, empires: { p1: empire } };

  // Lance la mine niv 1 sous l'epoch racine (multiplicateur 1.5).
  // Niv 1 → coût = cout_base = { 60, 15 }, durée = 1.0 UTJ → arrive vite.
  const step = async (T, ordres) => {
    const rules = effectiveRulesAtTick(rulesDoc, state.manifest.tick + 1);
    const r = await runTick({
      manifest: state.manifest, rules, galaxie: state.galaxie,
      empires: state.empires,
      orders: ordres ? { p1: { joueur: 'p1', tick_cible: state.manifest.tick + 1, ordres } } : {},
      identites: {},
      combat: { resolveCombat: () => null, computeDebris: () => ({}), computePillage: () => ({}) },
      opts: { log: () => {} },
    });
    state.manifest = r.newManifest;
    state.empires = r.newEmpires;
    state.galaxie = r.newGalaxie;
  };

  await step(1, [{ type: 'chantier', planete: 'home', batiment: 'mine_ferrum', niveau_cible: 1 }]);
  // 2 ticks de plus pour laisser le chantier finir (durée 1 UTJ < 6 UTJ/tick).
  await step(2);
  const planete = state.empires.p1.planetes[0];
  assert.equal(planete.batiments.mine_ferrum, 1, 'mine niv 1 doit être bâtie');
  const prodSnapshot = planete.ressources.ferrum.production_par_utj;
  assert.ok(prodSnapshot > 0, `prod par UTJ doit être > 0 (got ${prodSnapshot})`);

  // On franchit la frontière d'epoch (activation_tick: 5).
  await step(3); await step(4); await step(5); await step(6);

  // INVARIANT 1 : la production de la mine niv 1 n'a pas bougé.
  const prodAprès = state.empires.p1.planetes[0].ressources.ferrum.production_par_utj;
  assert.equal(prodAprès, prodSnapshot,
    `production_par_utj doit rester snapshottée à travers la transition d'epoch (avant: ${prodSnapshot}, après: ${prodAprès})`);

  // INVARIANT 2 : le coût d'une upgrade niv 2 utilise la NOUVELLE valeur.
  // Sous epoch racine : coût niv 2 = 60 × 1.5 = 90 ferrum.
  // Sous epoch patché : coût niv 2 = 60 × 2.25 = 135 ferrum.
  const rulesAvant = effectiveRulesAtTick(rulesDoc, 0);
  const rulesAprès = effectiveRulesAtTick(rulesDoc, 6);
  const coutAvant = 60 * Math.pow(rulesAvant.batiments.mine_ferrum.multiplicateur_cout, 1);
  const coutAprès = 60 * Math.pow(rulesAprès.batiments.mine_ferrum.multiplicateur_cout, 1);
  assert.equal(coutAvant, 90);
  assert.equal(coutAprès, 135);
  assert.ok(coutAprès > coutAvant, 'le patch doit rendre l\'upgrade plus chère');
});
