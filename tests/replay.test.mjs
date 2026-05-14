// Snapshot/integration tests : runTick avec état multi-joueurs construit
// inline. Vérifie les invariants critiques sur les transitions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTick } from '../engine/tick-core.mjs';
import * as combat from '../engine/combat.mjs';
import { readYaml, readRules } from './helpers.mjs';

const rules = readRules();
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

test('runTick : marché — deux ordres opposés se matchent au prix du plus ancien', async () => {
  const alice = emptyEmpire('alice', [planet('p-a', [0, 0, 0])]);
  const bob = emptyEmpire('bob', [planet('p-b', [0, 0, 1])]);
  alice.planetes[0].ressources.ferrum.stock = 10000;
  alice.planetes[0].ressources.lumen.stock = 0;
  alice.planetes[0].ressources.ferrum.production_par_utj = 0;
  alice.planetes[0].ressources.lumen.production_par_utj = 0;
  bob.planetes[0].ressources.ferrum.stock = 0;
  bob.planetes[0].ressources.lumen.stock = 10000;
  bob.planetes[0].ressources.ferrum.production_par_utj = 0;
  bob.planetes[0].ressources.lumen.production_par_utj = 0;

  const orders = {
    alice: { joueur: 'alice', tick_cible: 1, nonce: 'a', ordres: [
      { type: 'marche-poser', depuis: 'p-a', vend: { ferrum: 5000 }, demande: { lumen: 2000 } },
    ]},
    bob: { joueur: 'bob', tick_cible: 1, nonce: 'b', ordres: [
      { type: 'marche-poser', depuis: 'p-b', vend: { lumen: 3000 }, demande: { ferrum: 6000 } },
    ]},
  };

  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires: { alice, bob }, orders, identites: {}, combat,
  });

  // Alice : −5000 Fe (posté), reçoit 2000 × (1−0.05) = 1900 Lu
  assert.equal(result.newEmpires.alice.planetes[0].ressources.ferrum.stock, 5000);
  assert.equal(result.newEmpires.alice.planetes[0].ressources.lumen.stock, 1900);
  // Bob : −3000 Lu (posté), reçoit 5000 × 0.95 = 4750 Fe + refund 500 Lu
  assert.equal(result.newEmpires.bob.planetes[0].ressources.ferrum.stock, 4750);
  assert.equal(result.newEmpires.bob.planetes[0].ressources.lumen.stock, 7500);
  // Book : ordre Bob partiellement rempli (1000 Lu / 1000 Fe restants)
  const book = result.newManifest.marche.books['ferrum-lumen'];
  assert.equal(book.length, 1);
  assert.equal(book[0].joueur, 'bob');
  assert.equal(book[0].qty_vend_restant, 1000);
});

test('runTick : marché — ordre expire et rembourse la planète d\'origine', async () => {
  const alice = emptyEmpire('alice', [planet('p-a')]);
  alice.planetes[0].ressources.ferrum.stock = 10000;
  alice.planetes[0].ressources.ferrum.production_par_utj = 0;

  const orders = {
    alice: { joueur: 'alice', tick_cible: 1, nonce: 'a', ordres: [
      { type: 'marche-poser', depuis: 'p-a', vend: { ferrum: 5000 }, demande: { lumen: 9999 }, expire_dans_ticks: 1 },
    ]},
  };

  // Tick 1 : pose, réserve 5000 Fe.
  const r1 = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires: { alice }, orders, identites: {}, combat,
  });
  assert.equal(r1.newEmpires.alice.planetes[0].ressources.ferrum.stock, 5000);
  assert.equal(r1.newManifest.marche.books['ferrum-lumen'].length, 1);

  // Tick 2 : ordre expire (expire_tick = tick_pose + 1 = 2 → ≤ tickSuivant 2).
  const r2 = await runTick({
    manifest: r1.newManifest, rules, galaxie,
    empires: r1.newEmpires, orders: {}, identites: {}, combat,
  });
  assert.equal(r2.newEmpires.alice.planetes[0].ressources.ferrum.stock, 10000, 'Fe remboursé après expiration');
  assert.equal(r2.newManifest.marche.books['ferrum-lumen'].length, 0);
});

test('runTick : marché — fee réduite par terminal_marchand', async () => {
  const alice = emptyEmpire('alice', [planet('p-a', [0, 0, 0])]);
  const bob = emptyEmpire('bob', [planet('p-b', [0, 0, 1])]);
  alice.planetes[0].ressources.ferrum.stock = 10000;
  alice.planetes[0].ressources.lumen.stock = 0;
  alice.planetes[0].ressources.ferrum.production_par_utj = 0;
  alice.planetes[0].ressources.lumen.production_par_utj = 0;
  bob.planetes[0].ressources.ferrum.stock = 0;
  bob.planetes[0].ressources.lumen.stock = 10000;
  bob.planetes[0].ressources.ferrum.production_par_utj = 0;
  bob.planetes[0].ressources.lumen.production_par_utj = 0;
  // Bob a un terminal niv 5 → fee Alice (qui paie pour recevoir Lu) réduite ×(1−0.05×5) = ×0.75
  bob.planetes[0].batiments.terminal_marchand = 5;

  const orders = {
    alice: { joueur: 'alice', tick_cible: 1, nonce: 'a', ordres: [
      { type: 'marche-poser', depuis: 'p-a', vend: { ferrum: 5000 }, demande: { lumen: 2000 } },
    ]},
    bob: { joueur: 'bob', tick_cible: 1, nonce: 'b', ordres: [
      { type: 'marche-poser', depuis: 'p-b', vend: { lumen: 2000 }, demande: { ferrum: 5000 } },
    ]},
  };

  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires: { alice, bob }, orders, identites: {}, combat,
  });
  // Le terminal de Bob réduit la fee sur le Fe que Bob reçoit (pas sur le Lu d'Alice).
  // Alice (terminal 0) : feeB = 0.05 → reçoit 2000 × 0.95 = 1900 Lu.
  // Bob (terminal 5)   : feeA = 0.05 × (1 − 0.05 × 5) = 0.0375 → reçoit 5000 × 0.9625 = 4812 Fe.
  assert.equal(result.newEmpires.alice.planetes[0].ressources.lumen.stock, 1900);
  assert.equal(result.newEmpires.bob.planetes[0].ressources.ferrum.stock, 4812);
});

test('runTick : dépôt — capacité scale avec niveau et bonus glacée', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  empires.meff.planetes[0].type = 'glacee';
  empires.meff.planetes[0].file_chantier = [
    { batiment: 'depot', niveau_cible: 3, fin_utj: 6 },
  ];

  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  // capacite(3) = 100000 × 1.6^2 × 1.50 (glacée) = 100000 × 2.56 × 1.5 = 384000
  const cap = result.newEmpires.meff.planetes[0].ressources.ferrum.capacite;
  assert.equal(cap, 384000);
});

test('runTick : construction — vitesse lue depuis rules.yaml (chantier_spatial+usine)', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  const p = empires.meff.planetes[0];
  p.batiments.chantier_spatial = 5;
  p.batiments.usine_robotique = 5;
  p.ressources.ferrum.stock = 1000000;
  p.ressources.lumen.stock = 1000000;

  const orders = {
    meff: { joueur: 'meff', tick_cible: 1, nonce: 'a', ordres: [
      { type: 'construction', planete: 'meff-prima', unite: 'chasseur_leger', quantite: 1 },
    ]},
  };
  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });
  // duree = ceil(0.4 * 1 / (1 + 0.10*5 + 0.10*5)) = ceil(0.4 / 2) = ceil(0.2) = 1
  // (sera 1 quel que soit le bonus parce que ceil-clamp à 1)
  // Mais on vérifie surtout qu'aucune erreur n'a été levée et que la file existe.
  const fc = result.newEmpires.meff.planetes[0].file_construction;
  assert.equal(fc.length, 1);
  assert.equal(fc[0].fin_utj, 1);
});

// ─── Gates de prérequis structurels (cf tick-core.mjs queueConstruction/queueRecherche) ──
//
// Convention OGame : on ne construit pas de vaisseau/défense sans chantier_spatial,
// on ne research pas sans laboratoire. Sans ces gates, un joueur peut sortir un
// croiseur sur une planète vierge ou lancer une recherche dès tick 1.

test('runTick : construction REJETÉE sans chantier_spatial', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  const p = empires.meff.planetes[0];
  // chantier_spatial = 0 (valeur par défaut de planet()).
  // Stock < capacité pour pouvoir vérifier qu'il ne descend PAS.
  p.ressources.ferrum.stock = 50000;
  p.ressources.lumen.stock = 50000;

  const orders = {
    meff: { joueur: 'meff', tick_cible: 1, ordres: [
      { type: 'construction', planete: 'meff-prima', unite: 'chasseur_leger', quantite: 1 },
    ]},
  };
  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });
  const fc = result.newEmpires.meff.planetes[0].file_construction;
  assert.equal(fc.length, 0, 'construction doit être rejetée sans chantier_spatial');
  // Et les ressources ne sont PAS consommées par un ordre rejeté.
  // chasseur_leger coûte 3000 ferrum ; après tick : 50000 + 600 (prod) = 50600.
  assert.equal(result.newEmpires.meff.planetes[0].ressources.ferrum.stock, 50000 + 600,
    'ferrum non débité (ordre rejeté) — gain prod seul');
});

test('runTick : construction défense REJETÉE sans chantier_spatial', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  const p = empires.meff.planetes[0];
  p.ressources.ferrum.stock = 1000000;

  const orders = {
    meff: { joueur: 'meff', tick_cible: 1, ordres: [
      { type: 'construction', planete: 'meff-prima', unite: 'lance_missiles', quantite: 1 },
    ]},
  };
  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });
  assert.equal(result.newEmpires.meff.planetes[0].file_construction.length, 0);
});

test('runTick : recherche REJETÉE sans laboratoire', async () => {
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima')]) };
  const p = empires.meff.planetes[0];
  // laboratoire = 0 (valeur par défaut de planet()).
  p.ressources.ferrum.stock = 1000000;
  p.ressources.lumen.stock = 1000000;

  const orders = {
    meff: { joueur: 'meff', tick_cible: 1, ordres: [
      { type: 'recherche', technologie: 'armement', niveau_cible: 1 },
    ]},
  };
  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });
  assert.equal((result.newEmpires.meff.file_recherche || []).length, 0,
    'recherche doit être rejetée sans laboratoire');
});

test('runTick : recherche ACCEPTÉE si labo sur une AUTRE planète de l\'empire', async () => {
  // Multi-planètes : un joueur peut researcher tant qu'au moins une planète
  // de son empire a un laboratoire. Pas besoin que ce soit la planète qui paye.
  const empires = { meff: emptyEmpire('meff', [planet('meff-prima'), planet('meff-secunda', [1, 2, 7])]) };
  empires.meff.planetes[1].batiments.laboratoire = 1;
  const payeur = empires.meff.planetes[0];
  payeur.ressources.ferrum.stock = 1000000;
  payeur.ressources.lumen.stock = 1000000;

  const orders = {
    meff: { joueur: 'meff', tick_cible: 1, ordres: [
      { type: 'recherche', technologie: 'armement', niveau_cible: 1 },
    ]},
  };
  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });
  assert.equal(result.newEmpires.meff.file_recherche.length, 1,
    'recherche acceptée car labo existe ailleurs dans l\'empire');
});

test('runTick : attaque REJETÉE sans chantier_spatial', async () => {
  const empires = {
    attk: emptyEmpire('attk', [planet('attk-base', [1, 1, 7])]),
    def: emptyEmpire('def', [planet('def-base', [1, 1, 8])]),
  };
  // Flotte pré-positionnée mais pas de chantier → attaque rejetée.
  empires.attk.planetes[0].flotte_au_sol = { chasseur_leger: 50 };
  empires.attk.planetes[0].batiments.chantier_spatial = 0;

  const orders = {
    attk: { joueur: 'attk', tick_cible: 1, ordres: [
      { type: 'attaque', depuis: 'attk-base', cible: { joueur: 'def', planete: 'def-base' }, flotte: { chasseur_leger: 50 } },
    ]},
  };
  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });
  // Flotte reste au sol (l'ordre a été rejeté avant débit).
  assert.equal(result.newEmpires.attk.planetes[0].flotte_au_sol.chasseur_leger, 50);
  assert.equal((result.newEmpires.attk.flottes_en_vol || []).length, 0);
});

test('runTick : trêve BILATÉRALE — A déclare → B ne peut PAS attaquer A', async () => {
  // Avant le fix, seul l'empire émetteur était lié. Désormais lecture
  // symétrique : B voit la trêve de A et est bloqué aussi.
  const empires = {
    a: emptyEmpire('a', [planet('a-base', [1, 1, 7])]),
    b: emptyEmpire('b', [planet('b-base', [1, 1, 8])]),
  };
  empires.a.relations = { b: { status: 'treve', expire_tick: 100 } };
  empires.b.planetes[0].flotte_au_sol = { chasseur_leger: 50 };
  empires.b.planetes[0].batiments.chantier_spatial = 1;

  const orders = {
    b: { joueur: 'b', tick_cible: 1, ordres: [
      { type: 'attaque', depuis: 'b-base', cible: { joueur: 'a', planete: 'a-base' }, flotte: { chasseur_leger: 50 } },
    ]},
  };
  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });
  assert.equal((result.newEmpires.b.flottes_en_vol || []).length, 0,
    "attaque de b vers a rejetée car a a déclaré une trêve (lecture symétrique)");
});

test('runTick : rupture efface la trêve des DEUX côtés', async () => {
  // a a posé la trêve, b pose une rupture → relations[a] côté b passe
  // neutre ET relations[b] côté a passe neutre aussi (sinon b reste bloqué).
  const empires = {
    a: emptyEmpire('a', [planet('a-base', [1, 1, 7])]),
    b: emptyEmpire('b', [planet('b-base', [1, 1, 8])]),
  };
  empires.a.relations = { b: { status: 'treve', expire_tick: 100 } };
  empires.b.planetes[0].batiments.centre_diplomatique = 1;
  empires.b.recherche = { diplomatie: 1 };

  const orders = {
    b: { joueur: 'b', tick_cible: 1, ordres: [
      { type: 'diplomatie', action: 'rupture', vers: 'a' },
    ]},
  };
  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });
  assert.equal(result.newEmpires.a.relations.b.status, 'neutre',
    "côté a, la trêve est effacée par la rupture posée par b");
  // Et b écope du malus moral (initiator de la rupture).
  assert.ok(result.newEmpires.b.malus_moral_jusqu_tick > 0);
});

test('runTick : trêve REJETÉE sans centre_diplomatique', async () => {
  const empires = {
    a: emptyEmpire('a', [planet('a-base', [1, 1, 7])]),
    b: emptyEmpire('b', [planet('b-base', [1, 1, 8])]),
  };
  // a a la recherche diplomatie et de l'influence, mais pas de centre.
  empires.a.recherche = { diplomatie: 2 };
  empires.a.ressources_globales = { singularite: 0, influence: 500 };
  empires.a.planetes[0].batiments.centre_diplomatique = 0;

  const orders = {
    a: { joueur: 'a', tick_cible: 1, ordres: [
      { type: 'diplomatie', action: 'treve', vers: 'b' },
    ]},
  };
  const result = await runTick({
    manifest: baseManifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });
  assert.equal(result.newEmpires.a.relations?.b, undefined,
    "trêve non créée sans centre_diplomatique");
  // Influence pas débitée.
  assert.equal(result.newEmpires.a.ressources_globales.influence, 500);
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
