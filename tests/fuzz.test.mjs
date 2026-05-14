// Fuzz test : 100 ticks consécutifs sur état généré pseudo-aléatoirement.
// Vérifie qu'aucun crash ne se produit et que les invariants critiques
// tiennent à chaque tick.
//
// Invariants vérifiés :
//   1. Aucun stock de ressource négatif
//   2. Stock ≤ capacité
//   3. Pas de planète à 2 propriétaires
//   4. Tick progresse strictement de +1 à chaque appel
//   5. Pas de NaN/Infinity dans les chiffres
//   6. État reste sérialisable JSON

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTick, rngFromSeed } from '../engine/tick-core.mjs';
import * as combat from '../engine/combat.mjs';
import { readYaml, readRules } from './helpers.mjs';

const rules = readRules();
const galaxie = readYaml('world/galaxie.yaml');

function makeEmpire(name, idx, rng) {
  const stockBase = Math.floor(rng() * 50000) + 5000;
  return {
    version: 1, joueur: name, tick: 0, score_total: 0,
    points_militaires: 0, rang: 999, alliance: null,
    planetes: [{
      nom: `${name}-prima`,
      coordonnees: [1, idx + 1, 7],
      type: 'tellurique',
      champs: { utilises: 0, total: 240 },
      ressources: {
        ferrum: { stock: stockBase, production_par_utj: Math.floor(rng() * 200) + 50, capacite: 100000 },
        lumen: { stock: Math.floor(stockBase / 2), production_par_utj: Math.floor(rng() * 100) + 20, capacite: 100000 },
        plasmide: { stock: 0, production_par_utj: 0, capacite: 100000 },
      },
      energie: { production: 0, consommation: 0 },
      batiments: {
        mine_ferrum: Math.floor(rng() * 4), extracteur_lumen: Math.floor(rng() * 4),
        synthetiseur_plasmide: 0, centrale_solaire: 0, depot: 0,
        usine_robotique: 0, chantier_spatial: 0, laboratoire: 0,
      },
      file_chantier: [],
      file_construction: [],
      flotte_au_sol: { chasseur_leger: Math.floor(rng() * 20) },
      defenses: {},
    }],
    flottes_en_vol: [],
    recherche: {},
    file_recherche: [],
  };
}

function checkInvariants(empires, tick) {
  const planeteOwners = new Map();

  for (const [name, emp] of Object.entries(empires)) {
    assert.ok(Array.isArray(emp.planetes), `[t${tick}] ${name} planetes array`);

    for (const p of emp.planetes) {
      // 3. Pas de planète à 2 propriétaires
      const key = `${p.nom}|${(p.coordonnees || []).join(',')}`;
      const prev = planeteOwners.get(key);
      assert.ok(!prev, `[t${tick}] planète ${key} appartient à ${prev} ET ${name}`);
      planeteOwners.set(key, name);

      // 1, 2, 5. Stock invariants
      for (const [res, info] of Object.entries(p.ressources || {})) {
        assert.ok(Number.isFinite(info.stock), `[t${tick}] ${name}/${p.nom}/${res} stock NaN/Inf`);
        assert.ok(info.stock >= 0, `[t${tick}] ${name}/${p.nom}/${res} stock négatif (${info.stock})`);
        if (info.capacite) {
          assert.ok(info.stock <= info.capacite, `[t${tick}] ${name}/${p.nom}/${res} stock>capacite`);
        }
      }
    }

    // 5. Pas de NaN dans flotte_en_vol
    for (const f of emp.flottes_en_vol || []) {
      for (const [u, n] of Object.entries(f.composition || {})) {
        assert.ok(Number.isFinite(n), `[t${tick}] flotte ${f.id} ${u} NaN/Inf`);
      }
    }
  }

  // 6. Sérialisable
  assert.doesNotThrow(() => JSON.stringify(empires), `[t${tick}] empires non-sérialisable`);
}

test('fuzz : 100 ticks sur 4 empires aléatoires sans crash', async () => {
  const rng = rngFromSeed('fuzz:seed:42');
  let manifest = {
    version: 1, serveur: 'fuzz', tick: 0, seed: '0xfuzz', duree_tick_min: 15,
    parametres: { galaxies: 1, systemes_par_galaxie: 3, positions_par_systeme: 15, planetes_max_par_joueur: 9 },
  };
  let empires = {};
  for (let i = 0; i < 4; i++) {
    const name = `player${i}`;
    empires[name] = makeEmpire(name, i, rng);
  }

  for (let t = 0; t < 100; t++) {
    const tickAvant = manifest.tick;
    const result = await runTick({
      manifest, rules, galaxie, empires, orders: {}, identites: {}, combat,
    });

    // 4. Tick progresse de +1
    assert.equal(result.newManifest.tick, tickAvant + 1, `tick avance de 1 (t=${t})`);

    manifest = result.newManifest;
    empires = result.newEmpires;

    checkInvariants(empires, manifest.tick);
  }
});

test('fuzz : 50 ticks avec chantiers en cours', async () => {
  const rng = rngFromSeed('fuzz:chantiers:7');
  let manifest = {
    version: 1, serveur: 'fuzz', tick: 0, seed: '0xfuzz2', duree_tick_min: 15,
    parametres: { galaxies: 1, systemes_par_galaxie: 3, positions_par_systeme: 15, planetes_max_par_joueur: 9 },
  };
  let empires = { p0: makeEmpire('p0', 0, rng) };
  // injecte une file de 5 chantiers consécutifs
  empires.p0.planetes[0].file_chantier = [
    { batiment: 'mine_ferrum', niveau_cible: 4, fin_utj: 6 },
    { batiment: 'mine_ferrum', niveau_cible: 5, fin_utj: 12 },
    { batiment: 'extracteur_lumen', niveau_cible: 3, fin_utj: 8 },
    { batiment: 'extracteur_lumen', niveau_cible: 4, fin_utj: 14 },
    { batiment: 'mine_ferrum', niveau_cible: 6, fin_utj: 20 },
  ];

  for (let t = 0; t < 50; t++) {
    const result = await runTick({
      manifest, rules, galaxie, empires, orders: {}, identites: {}, combat,
    });
    manifest = result.newManifest;
    empires = result.newEmpires;
    checkInvariants(empires, manifest.tick);
  }

  // file vidée après 50 ticks
  assert.equal(empires.p0.planetes[0].file_chantier.length, 0, 'tous les chantiers complétés');
  // mine_ferrum a monté à 6
  assert.equal(empires.p0.planetes[0].batiments.mine_ferrum, 6);
});
