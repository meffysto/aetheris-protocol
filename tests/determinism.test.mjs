// Vérifie que runTick() est purement déterministe : pour un même état
// d'entrée, deux exécutions séparées produisent un hash byte-identique.
//
// Si ce test casse, c'est qu'une source de non-déterminisme s'est glissée
// dans le moteur (Math.random, Date.now, ordre d'itération non stable, etc.).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTick } from '../engine/tick-core.mjs';
import * as combat from '../engine/combat.mjs';
import { loadFixtures, clone, hashState } from './helpers.mjs';

async function runN(n, fixtures) {
  let { manifest, empires } = clone(fixtures);
  const { rules, galaxie, identites } = fixtures;
  for (let i = 0; i < n; i++) {
    const result = await runTick({
      manifest, rules, galaxie,
      empires, orders: {}, identites,
      combat,
    });
    manifest = result.newManifest;
    empires = result.newEmpires;
  }
  return { manifest, empires };
}

test('runTick est déterministe sur 50 ticks (état réel)', async () => {
  const fixtures = loadFixtures();
  if (!Object.keys(fixtures.empires).length) {
    // Pas de joueurs locaux → skip (CI sans état). Note plutôt qu'on échoue.
    console.warn('[determinism] aucun empire local — test skippé');
    return;
  }

  const a = await runN(50, fixtures);
  const b = await runN(50, fixtures);

  const hashA = hashState(a.empires);
  const hashB = hashState(b.empires);

  assert.equal(hashA, hashB, 'Deux runs identiques doivent produire le même hash');
  assert.equal(a.manifest.tick, b.manifest.tick, 'Tick final identique');
});

test('runTick est déterministe sur 100 ticks (stress)', async () => {
  const fixtures = loadFixtures();
  if (!Object.keys(fixtures.empires).length) return;

  const a = await runN(100, fixtures);
  const b = await runN(100, fixtures);

  assert.equal(hashState(a.empires), hashState(b.empires));
});

test('runTick fait avancer manifest.tick de 1', async () => {
  const fixtures = loadFixtures();
  if (!Object.keys(fixtures.empires).length) return;

  const tickInitial = fixtures.manifest.tick;
  const result = await runTick({
    manifest: clone(fixtures.manifest),
    rules: fixtures.rules,
    galaxie: fixtures.galaxie,
    empires: clone(fixtures.empires),
    orders: {},
    identites: fixtures.identites,
    combat,
  });

  assert.equal(result.newManifest.tick, tickInitial + 1);
});
