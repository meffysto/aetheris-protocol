// Tests dédiés à la colonisation des planètes inhabitées.
// Couvre : envoi (validation), arrivée (succès, échecs, tie-break),
// mutation galaxie, événements, retour auto sur échec.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTick } from '../engine/tick-core.mjs';
import * as combat from '../engine/combat.mjs';
import { validateNomColonie, autoFallbackName } from '../engine/colonisation.mjs';
import { readYaml, readRules, clone } from './helpers.mjs';

const rules = readRules();

// ── Fixtures synthétiques ───────────────────────────────────────────────

function manifest(tick = 0) {
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

function buildGalaxie() {
  return {
    version: 1,
    tick: 0,
    systemes: {
      '1:1': {
        etoile: { nom: 'stelara-1', type: 'G', temperature_k: 5800 },
        positions: {
          1: { type: 'planete', proprietaire: 'kael', nom: 'kael-prima', classe: 'tellurique' },
          2: { type: 'planete', proprietaire: null, classe: 'tellurique' },
          3: { type: 'planete', proprietaire: null, classe: 'cristalline' },
          4: { type: 'asteroide' },
          5: { type: 'planete', proprietaire: null, classe: 'volcanique' },
        },
      },
      '1:2': {
        etoile: { nom: 'stelara-2', type: 'K', temperature_k: 4800 },
        positions: {
          1: { type: 'planete', proprietaire: 'vexor', nom: 'pyra', classe: 'volcanique' },
          7: { type: 'planete', proprietaire: null, classe: 'glacee' },
        },
      },
    },
  };
}

function planete(nom, coords, classe = 'tellurique', overrides = {}) {
  return {
    nom,
    coordonnees: coords,
    type: classe,
    champs: { utilises: 0, total: 240 },
    ressources: {
      ferrum:   { stock: 500000, production_par_utj: 100, capacite: 1000000 },
      lumen:    { stock: 500000, production_par_utj: 50,  capacite: 1000000 },
      plasmide: { stock: 200000, production_par_utj: 30,  capacite: 1000000 },
    },
    energie: { production: 0, consommation: 0 },
    batiments: {
      mine_ferrum: 5, extracteur_lumen: 5, synthetiseur_plasmide: 3,
      centrale_solaire: 0, depot: 0, usine_robotique: 0,
      chantier_spatial: 0, laboratoire: 0,
    },
    file_chantier: [],
    file_construction: [],
    flotte_au_sol: { vaisseau_colon: 3, chasseur_leger: 100, ...overrides.flotte_au_sol },
    defenses: {},
    ...overrides,
  };
}

function empire(name, planetes) {
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
    recherche: { drives_impulsion: 5 },
    file_recherche: [],
    ressources_globales: { singularite: 0, influence: 0 },
    progres_singularite_utj: 0,
    relations: {},
    malus_moral_jusqu_tick: 0,
  };
}

function colonisationOrder(depuis, sysKey, position, opts = {}) {
  return {
    type: 'colonisation',
    depuis,
    cible: { systeme: sysKey, position },
    nom_colonie: opts.nom_colonie,
    flotte: opts.flotte || { vaisseau_colon: 1 },
    cargaison: opts.cargaison || {},
  };
}

function ordersFor(player, actions, tickCible = 1) {
  return { [player]: { joueur: player, tick_cible: tickCible, ordres: actions } };
}

// ── 1) validateNomColonie — règles pures ────────────────────────────────

test('validateNomColonie : auto-fallback si nom absent', () => {
  const emp = { joueur: 'kael', planetes: [{}, {}] };
  const galaxie = { systemes: {} };
  const v = validateNomColonie(undefined, emp, galaxie);
  assert.equal(v.ok, true);
  assert.equal(v.nom, 'kael-c3');
});

test('validateNomColonie : rejet format invalide', () => {
  const emp = { joueur: 'kael', planetes: [] };
  const galaxie = { systemes: {} };
  assert.equal(validateNomColonie('AB', emp, galaxie).ok, false);
  assert.equal(validateNomColonie('1bad', emp, galaxie).ok, false);
  assert.equal(validateNomColonie('-bad', emp, galaxie).ok, false);
  assert.equal(validateNomColonie('a', emp, galaxie).ok, false);
  assert.equal(validateNomColonie('avec espaces', emp, galaxie).ok, false);
});

test('validateNomColonie : rejet noms réservés', () => {
  const emp = { joueur: 'kael', planetes: [] };
  const galaxie = { systemes: {} };
  assert.equal(validateNomColonie('null', emp, galaxie).ok, false);
  assert.equal(validateNomColonie('undefined', emp, galaxie).ok, false);
});

test('validateNomColonie : rejet format auto-fallback', () => {
  const emp = { joueur: 'kael', planetes: [] };
  const galaxie = { systemes: {} };
  assert.equal(validateNomColonie('kael-c2', emp, galaxie).ok, false);
  assert.equal(validateNomColonie('vexor-c1', emp, galaxie).ok, false);
});

test('validateNomColonie : rejet nom déjà pris', () => {
  const emp = { joueur: 'kael', planetes: [] };
  const galaxie = {
    systemes: {
      '1:1': { positions: { 1: { type: 'planete', nom: 'pyra' } } },
    },
  };
  assert.equal(validateNomColonie('pyra', emp, galaxie).ok, false);
});

test('validateNomColonie : accepte nom valide', () => {
  const emp = { joueur: 'kael', planetes: [] };
  const galaxie = { systemes: {} };
  const v = validateNomColonie('ferrolune', emp, galaxie);
  assert.equal(v.ok, true);
  assert.equal(v.nom, 'ferrolune');
});

test('autoFallbackName : compteur basé sur planètes possédées', () => {
  assert.equal(autoFallbackName({ joueur: 'kael', planetes: [] }), 'kael-c1');
  assert.equal(autoFallbackName({ joueur: 'kael', planetes: [{}, {}, {}] }), 'kael-c4');
});

// ── 2) Chemin heureux : envoi → arrivée → planète créée ────────────────

test('colonisation : envoi met la flotte en vol et consomme les ressources', async () => {
  const galaxie = buildGalaxie();
  const empires = {
    kael: empire('kael', [planete('kael-prima', [1, 1, 1])]),
  };
  const orders = ordersFor('kael', [
    colonisationOrder('kael-prima', '1:1', 2, {
      nom_colonie: 'ferrolune',
      flotte: { vaisseau_colon: 1, chasseur_leger: 30 },
      cargaison: { ferrum: 100000 },
    }),
  ]);

  const result = await runTick({
    manifest: manifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });

  const emp = result.newEmpires.kael;
  // Ressources/flotte consommées sur la source.
  assert.equal(emp.planetes[0].ressources.ferrum.stock < 500000 + 600, true);
  assert.equal(emp.planetes[0].flotte_au_sol.vaisseau_colon, 2);
  assert.equal(emp.planetes[0].flotte_au_sol.chasseur_leger, 70);
  // Flotte en vol présente.
  assert.equal(emp.flottes_en_vol.length, 1);
  const flt = emp.flottes_en_vol[0];
  assert.equal(flt.type_mission, 'colonisation');
  assert.equal(flt.nom_colonie, 'ferrolune');
  assert.equal(flt.vers.systeme, '1:1');
  assert.equal(flt.vers.position, 2);
});

test('colonisation : arrivée crée la planète et mute galaxie', async () => {
  const galaxie = buildGalaxie();
  const empires = {
    kael: empire('kael', [planete('kael-prima', [1, 1, 1])]),
  };
  // Pré-positionne une flotte qui arrive ce tick.
  empires.kael.flottes_en_vol.push({
    id: 'flt-test-colon',
    type_mission: 'colonisation',
    depuis: { joueur: 'kael', planete: 'kael-prima' },
    vers: { systeme: '1:1', position: 2 },
    cible_coords: [1, 1, 2],
    nom_colonie: 'ferrolune',
    arrivee_utj: 1,  // arrive ce tick après décrément (1 - 6 ≤ 0)
    duree_aller_utj: 12,
    composition: { vaisseau_colon: 1, chasseur_leger: 30 },
    cargaison: { ferrum: 50000, lumen: 30000 },
  });

  const result = await runTick({
    manifest: manifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  const emp = result.newEmpires.kael;
  // Nouvelle planète présente.
  assert.equal(emp.planetes.length, 2);
  const newPlanete = emp.planetes.find(p => p.nom === 'ferrolune');
  assert.ok(newPlanete, 'ferrolune doit exister');
  assert.deepEqual(newPlanete.coordonnees, [1, 1, 2]);
  assert.equal(newPlanete.type, 'tellurique');
  // Cargaison livrée (clampée à la capacité 100k).
  assert.equal(newPlanete.ressources.ferrum.stock, 50000);
  assert.equal(newPlanete.ressources.lumen.stock, 30000);
  // 1 colon consommé, 30 chasseurs atterris.
  assert.equal(newPlanete.flotte_au_sol.vaisseau_colon, undefined);
  assert.equal(newPlanete.flotte_au_sol.chasseur_leger, 30);
  // Flotte retirée.
  assert.equal(emp.flottes_en_vol.length, 0);
  // Galaxie mutée.
  assert.equal(result.newGalaxie.systemes['1:1'].positions[2].proprietaire, 'kael');
  assert.equal(result.newGalaxie.systemes['1:1'].positions[2].nom, 'ferrolune');
  // Événement public émis.
  assert.ok(result.events.some(e => e.type === 'colonisation-reussie' && e.nom === 'ferrolune'));
});

// ── 3) Échec : cible déjà occupée → flotte retour ───────────────────────

test('colonisation : cible occupée à l\'arrivée → retour auto', async () => {
  const galaxie = buildGalaxie();
  // On occupe la cible avant l'arrivée.
  galaxie.systemes['1:1'].positions[2].proprietaire = 'vexor';
  galaxie.systemes['1:1'].positions[2].nom = 'pyra-secunda';

  const empires = {
    kael: empire('kael', [planete('kael-prima', [1, 1, 1])]),
    vexor: empire('vexor', [planete('vexor-base', [1, 2, 1], 'volcanique')]),
  };
  empires.kael.flottes_en_vol.push({
    id: 'flt-test-fail',
    type_mission: 'colonisation',
    depuis: { joueur: 'kael', planete: 'kael-prima' },
    vers: { systeme: '1:1', position: 2 },
    cible_coords: [1, 1, 2],
    nom_colonie: 'ferrolune',
    arrivee_utj: 1,
    duree_aller_utj: 12,
    composition: { vaisseau_colon: 1, chasseur_leger: 30 },
    cargaison: { ferrum: 50000 },
  });

  const result = await runTick({
    manifest: manifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  const emp = result.newEmpires.kael;
  // Pas de planète créée.
  assert.equal(emp.planetes.length, 1);
  // Flotte transformée en retour (1 flotte en vol vers kael-prima).
  assert.equal(emp.flottes_en_vol.length, 1);
  assert.equal(emp.flottes_en_vol[0].type_mission, 'retour');
  assert.equal(emp.flottes_en_vol[0].vers.planete, 'kael-prima');
  // Colon NON consommé (toujours 1 dans la composition).
  assert.equal(emp.flottes_en_vol[0].composition.vaisseau_colon, 1);
  // Événement d'échec.
  assert.ok(result.events.some(e => e.type === 'colonisation-echouee' && e.raison === 'cible-occupee'));
});

// ── 4) Échec : cap planètes atteint à l'arrivée ────────────────────────

test('colonisation : cap planètes atteint à l\'arrivée → retour', async () => {
  const galaxie = buildGalaxie();
  // 9 planètes possédées (cap par défaut).
  const planetes = [];
  for (let i = 1; i <= 9; i++) {
    planetes.push(planete(`kael-p${i}`, [1, 1, i]));
  }
  const empires = { kael: empire('kael', planetes) };
  empires.kael.flottes_en_vol.push({
    id: 'flt-cap',
    type_mission: 'colonisation',
    depuis: { joueur: 'kael', planete: 'kael-p1' },
    vers: { systeme: '1:1', position: 5 },  // position 5 = volcanique libre
    cible_coords: [1, 1, 5],
    nom_colonie: 'overflow',
    arrivee_utj: 1,
    duree_aller_utj: 10,
    composition: { vaisseau_colon: 1 },
    cargaison: {},
  });

  const result = await runTick({
    manifest: manifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  assert.equal(result.newEmpires.kael.planetes.length, 9, 'pas de 10e planète');
  assert.ok(result.events.some(e => e.type === 'colonisation-echouee' && e.raison === 'cap-atteint'));
  // Galaxie NON mutée.
  assert.equal(result.newGalaxie.systemes['1:1'].positions[5].proprietaire, null);
});

// ── 5) Tie-break déterministe : 2 colons même cible même tick ──────────

test('colonisation : tie-break (joueur ASC) → premier alphabétique gagne', async () => {
  const galaxie = buildGalaxie();
  const empires = {
    kael: empire('kael', [planete('kael-prima', [1, 1, 1])]),
    vexor: empire('vexor', [planete('vexor-base', [1, 2, 1], 'volcanique')]),
  };
  // Les deux arrivent ce tick sur la même case (1:1 pos 2).
  for (const [pName, fltId] of [['kael', 'flt-kael'], ['vexor', 'flt-vexor']]) {
    empires[pName].flottes_en_vol.push({
      id: fltId,
      type_mission: 'colonisation',
      depuis: { joueur: pName, planete: pName === 'kael' ? 'kael-prima' : 'vexor-base' },
      vers: { systeme: '1:1', position: 2 },
      cible_coords: [1, 1, 2],
      nom_colonie: `${pName}-colony`,
      arrivee_utj: 1,
      duree_aller_utj: 10,
      composition: { vaisseau_colon: 1 },
      cargaison: {},
    });
  }

  const result = await runTick({
    manifest: manifest(0), rules, galaxie,
    empires, orders: {}, identites: {}, combat,
  });

  // kael < vexor lexicographique → kael gagne.
  assert.equal(result.newGalaxie.systemes['1:1'].positions[2].proprietaire, 'kael');
  assert.equal(result.newEmpires.kael.planetes.length, 2);
  // vexor échoue → flotte retour.
  assert.equal(result.newEmpires.vexor.planetes.length, 1);
  assert.equal(result.newEmpires.vexor.flottes_en_vol[0].type_mission, 'retour');
});

// ── 6) Rejet à l'envoi : cap, cible occupée, nom invalide ──────────────

test('colonisation : rejet envoi si cible occupée visible', async () => {
  const galaxie = buildGalaxie();
  const empires = { kael: empire('kael', [planete('kael-prima', [1, 1, 1])]) };
  const orders = ordersFor('kael', [
    colonisationOrder('kael-prima', '1:2', 1),  // pos 1 du 1:2 = pyra (occupé par vexor)
  ]);

  const result = await runTick({
    manifest: manifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });

  assert.equal(result.newEmpires.kael.flottes_en_vol.length, 0, 'pas de flotte créée');
});

test('colonisation : rejet envoi si nom invalide', async () => {
  const galaxie = buildGalaxie();
  const empires = { kael: empire('kael', [planete('kael-prima', [1, 1, 1])]) };
  const orders = ordersFor('kael', [
    colonisationOrder('kael-prima', '1:1', 2, { nom_colonie: 'BAD NAME' }),
  ]);

  const result = await runTick({
    manifest: manifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });

  assert.equal(result.newEmpires.kael.flottes_en_vol.length, 0);
});

test('colonisation : rejet envoi sans vaisseau_colon', async () => {
  const galaxie = buildGalaxie();
  const empires = { kael: empire('kael', [planete('kael-prima', [1, 1, 1])]) };
  const orders = ordersFor('kael', [
    colonisationOrder('kael-prima', '1:1', 2, { flotte: { chasseur_leger: 50 } }),
  ]);

  const result = await runTick({
    manifest: manifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });

  assert.equal(result.newEmpires.kael.flottes_en_vol.length, 0);
});

test('colonisation : cap envoi compte les colons en vol', async () => {
  const galaxie = buildGalaxie();
  // 8 planètes + 1 colon déjà en vol = quota plein.
  const planetes = [];
  for (let i = 1; i <= 8; i++) planetes.push(planete(`kael-p${i}`, [1, 1, i]));
  const empires = { kael: empire('kael', planetes) };
  empires.kael.flottes_en_vol.push({
    id: 'flt-deja-en-vol',
    type_mission: 'colonisation',
    depuis: { joueur: 'kael', planete: 'kael-p1' },
    vers: { systeme: '1:2', position: 7 },
    cible_coords: [1, 2, 7],
    nom_colonie: 'kael-c9',
    arrivee_utj: 100,  // n'arrive pas ce tick
    duree_aller_utj: 100,
    composition: { vaisseau_colon: 1 },
    cargaison: {},
  });

  const orders = ordersFor('kael', [
    colonisationOrder('kael-p1', '1:1', 5),  // tentative d'un 10e
  ]);

  const result = await runTick({
    manifest: manifest(0), rules, galaxie,
    empires, orders, identites: {}, combat,
  });

  // Le seul colon en vol doit rester celui pré-existant (pas de 2e poussé).
  const colsEnVol = result.newEmpires.kael.flottes_en_vol.filter(f => f.type_mission === 'colonisation');
  assert.equal(colsEnVol.length, 1);
});

// ── 7) Déterminisme : 2 runs identiques avec colonisation ──────────────

test('colonisation : déterminisme sur 10 ticks avec mission active', async () => {
  function setup() {
    const galaxie = buildGalaxie();
    const empires = {
      kael: empire('kael', [planete('kael-prima', [1, 1, 1])]),
    };
    empires.kael.flottes_en_vol.push({
      id: 'flt-det',
      type_mission: 'colonisation',
      depuis: { joueur: 'kael', planete: 'kael-prima' },
      vers: { systeme: '1:1', position: 2 },
      cible_coords: [1, 1, 2],
      nom_colonie: 'det-colony',
      arrivee_utj: 18,
      duree_aller_utj: 18,
      composition: { vaisseau_colon: 1, chasseur_leger: 10 },
      cargaison: { ferrum: 1000 },
    });
    return { galaxie, empires };
  }

  async function runN(n) {
    let { galaxie, empires } = setup();
    let m = manifest(0);
    for (let i = 0; i < n; i++) {
      const r = await runTick({
        manifest: m, rules, galaxie, empires, orders: {}, identites: {}, combat,
      });
      m = r.newManifest;
      empires = r.newEmpires;
      galaxie = r.newGalaxie;
    }
    return { m, empires, galaxie };
  }

  const a = await runN(10);
  const b = await runN(10);
  assert.equal(JSON.stringify(a.empires), JSON.stringify(b.empires));
  assert.equal(JSON.stringify(a.galaxie), JSON.stringify(b.galaxie));
});
