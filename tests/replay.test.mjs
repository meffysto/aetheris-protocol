// Snapshot/integration tests : runTick avec état multi-joueurs construit
// inline. Vérifie les invariants critiques sur les transitions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTick } from '../engine/tick-core.mjs';
import * as combat from '../engine/combat.mjs';
import { readYaml } from './helpers.mjs';

const rules = readYaml('engine/rules.yaml');
const galaxie = readYaml('world/galaxie.yaml');

function baseManifest(tick = 0) {
  return {
    version: 1,
    serveur: 'test',
    tick,
    seed: '0xdeadbeefcafebabe',
    duree_tick_min: 15,
    parametres: {
      galaxies: 1,
      systemes_par_galaxie: 3,
      positions_par_systeme: 15,
      planetes_max_par_joueur: 9,
    },
  };
}

function emptyEmpire(name, planetes = []) {
  return {
    version: 1,
    joueur: name,
    tick: 0,
    score_total: 0,
    points_militaires: 0,
    rang: 999,
    alliance: null,
    planetes,
    flottes_en_vol: [],
    recherche: {},
    file_recherche: [],
  };
}

function planet(nom, coordonnees = [1, 1, 7]) {
  return {
    nom,
    coordonnees,
    type: 'tellurique',
    champs: { utilises: 0, total: 240 },
    ressources: {
      ferrum: { stock: 10000, production_par_utj: 100, capacite: 100000 },
      lumen: { stock: 5000, production_par_utj: 50, capacite: 100000 },
      plasmide: { stock: 0, production_par_utj: 0, capacite: 100000 },
    },
    energie: { production: 0, consommation: 0 },
    batiments: {
      mine_ferrum: 3, extracteur_lumen: 2, synthetiseur_plasmide: 0,
      centrale_solaire: 0, depot: 0, usine_robotique: 0,
      chantier_spatial: 0, laboratoire: 0,
    },
    file_chantier: [],
    file_construction: [],
    flotte_au_sol: {},
    defenses: {},
  };
}

test('runTick : production avance les ressources', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  const ferrumAvant = empires.meff.planetes[0].ressources.ferrum.stock;

  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  const ferrumApres = result.newEmpires.meff.planetes[0].ressources.ferrum.stock;
  assert.ok(ferrumApres > ferrumAvant, 'ferrum doit augmenter');
  // production_par_utj=100 × 6 UTJ = 600
  assert.equal(ferrumApres - ferrumAvant, 600);
});

test('runTick : stock ne dépasse jamais la capacité', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  empires.meff.planetes[0].ressources.ferrum.stock = 99800;
  empires.meff.planetes[0].ressources.ferrum.capacite = 100000;
  empires.meff.planetes[0].ressources.ferrum.production_par_utj = 1000; // 6000/tick

  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  const stock = result.newEmpires.meff.planetes[0].ressources.ferrum.stock;
  assert.equal(stock, 100000, 'stock plafonne à capacite');
});

test('runTick : chantier avance puis se termine', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  empires.meff.planetes[0].file_chantier = [
    { batiment: 'mine_ferrum', niveau_cible: 4, fin_utj: 6 },
  ];

  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  const p = result.newEmpires.meff.planetes[0];
  assert.equal(p.file_chantier.length, 0, 'file vidée');
  assert.equal(p.batiments.mine_ferrum, 4, 'niveau bâtiment monté');
});

test('runTick : recherche avance puis se termine', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  empires.meff.file_recherche = [
    { technologie: 'armement', niveau_cible: 2, fin_utj: 6 },
  ];

  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  const emp = result.newEmpires.meff;
  assert.equal(emp.file_recherche.length, 0);
  assert.equal(emp.recherche.armement, 2);
});

test('runTick : multi-joueurs préserve l\'isolation', async () => {
  const empires = {
    meff: emptyEmpire('meff', [planet('meff-prima')]),
    aurora: emptyEmpire('aurora', [planet('aurora-1')]),
  };
  empires.meff.planetes[0].ressources.ferrum.stock = 1000;
  empires.aurora.planetes[0].ressources.ferrum.stock = 50000;

  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  // Stock de meff ne doit pas être affecté par celui d'aurora
  assert.equal(result.newEmpires.meff.planetes[0].ressources.ferrum.stock, 1600);
  assert.equal(result.newEmpires.aurora.planetes[0].ressources.ferrum.stock, 50600);
});

test('runTick : tick avance de exactement 1', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  for (let t = 0; t < 5; t++) {
    const result = await runTick({
      manifest: baseManifest(t), rules, galaxie,
      empires, orders: {}, identites: {}, combat,
    });
    assert.equal(result.newManifest.tick, t + 1);
  }
});

test('runTick : pas de stock négatif après prod', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  empires.meff.planetes[0].ressources.ferrum.stock = 0;
  empires.meff.planetes[0].ressources.ferrum.production_par_utj = 0;

  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  for (const emp of Object.values(result.newEmpires)) {
    for (const p of emp.planetes || []) {
      for (const [res, info] of Object.entries(p.ressources || {})) {
        assert.ok(info.stock >= 0, `${emp.joueur}/${p.nom}/${res} stock négatif`);
      }
    }
  }
});
