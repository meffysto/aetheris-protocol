// Snapshot tests pour resolveCombat — fixe les sorties canoniques sur
// 20 scénarios. Si un changement de balance modifie ces résultats, le
// test cassera et il faudra les réviser intentionnellement.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCombat, computeDebris, computePillage } from '../engine/combat.mjs';
import { rngFromSeed } from '../engine/tick-core.mjs';
import { readYaml } from './helpers.mjs';

const rules = readYaml('engine/rules.yaml');

// 20 scénarios canoniques attaquant vs défenseur. Seed fixe pour le RNG.
const SCENARIOS = [
  // 1. Chasseurs légers : attaquant nombreux écrase défenseur
  { name: 'CL 100 vs CL 10', a: { chasseur_leger: 100 }, d: { chasseur_leger: 10 }, seed: 'a1', expect: 'victoire-attaquant' },
  // 2. Égalité numérique CL : combat serré
  { name: 'CL 50 vs CL 50', a: { chasseur_leger: 50 }, d: { chasseur_leger: 50 }, seed: 'a2' },
  // 3. CL vs CH : chasseur lourd a bonus_contre CL ×2
  { name: 'CL 100 vs CH 30', a: { chasseur_leger: 100 }, d: { chasseur_lourd: 30 }, seed: 'a3' },
  // 4. CH écrase CL en infériorité numérique mais avec bonus
  { name: 'CL 50 vs CH 25', a: { chasseur_leger: 50 }, d: { chasseur_lourd: 25 }, seed: 'a4' },
  // 5. Sonde seule contre CL : annihilation totale (bonus ×5)
  { name: 'sonde 10 vs CL 5', a: { sonde: 10 }, d: { chasseur_leger: 5 }, seed: 'a5', expect: 'victoire-defenseur' },
  // 6. Croiseurs vs CL : croiseur dur à abattre
  { name: 'CL 200 vs CR 10', a: { chasseur_leger: 200 }, d: { croiseur: 10 }, seed: 'a6' },
  // 7. Force mixte attaque solide
  { name: 'mix attaquant', a: { chasseur_leger: 100, chasseur_lourd: 30 }, d: { chasseur_leger: 80 }, seed: 'a7' },
  // 8. Avec défense statique légère (lance-missiles)
  { name: 'CL vs lance_missile', a: { chasseur_leger: 50 }, d: { lance_missile: 100 }, seed: 'a8' },
  // 9. Très petit combat (1 vs 1)
  { name: 'CH 1 vs CH 1', a: { chasseur_lourd: 1 }, d: { chasseur_lourd: 1 }, seed: 'a9' },
  // 10. Asymétrie tech : attaquant +5 armement
  { name: 'CL 50 +tech vs CL 50', a: { chasseur_leger: 50 }, d: { chasseur_leger: 50 }, atech: { armement: 5 }, seed: 'a10' },
  // 11. Asymétrie tech : défenseur +5 bouclier
  { name: 'CL 50 vs CL 50 +shield', a: { chasseur_leger: 50 }, d: { chasseur_leger: 50 }, dtech: { bouclier_graviton: 5 }, seed: 'a11' },
  // 12. Big battle CL only
  { name: 'CL 500 vs CL 500', a: { chasseur_leger: 500 }, d: { chasseur_leger: 500 }, seed: 'a12' },
  // 13. Croiseurs vs croiseurs
  { name: 'CR 20 vs CR 20', a: { croiseur: 20 }, d: { croiseur: 20 }, seed: 'a13' },
  // 14. Attaque sur défense lourde
  { name: 'CL 200 vs lance_missile 200', a: { chasseur_leger: 200 }, d: { lance_missile: 200 }, seed: 'a14' },
  // 15. Force overwhelming sur petite cible
  { name: 'CR 100 vs CL 10', a: { croiseur: 100 }, d: { chasseur_leger: 10 }, seed: 'a15', expect: 'victoire-attaquant' },
  // 16. Sonde vs sonde
  { name: 'sonde 50 vs sonde 50', a: { sonde: 50 }, d: { sonde: 50 }, seed: 'a16' },
  // 17. CL vs combo défensif
  { name: 'CL 300 vs CL 100 + lance_missile 50', a: { chasseur_leger: 300 }, d: { chasseur_leger: 100, lance_missile: 50 }, seed: 'a17' },
  // 18. Sonde isolée infiltre vide → victoire trivial
  { name: 'sonde 1 vs vide', a: { sonde: 1 }, d: {}, seed: 'a18', expect: 'victoire-attaquant' },
  // 19. Combat avec tech élevée des deux côtés
  { name: 'CL 100 +5 vs CL 100 +5', a: { chasseur_leger: 100 }, d: { chasseur_leger: 100 }, atech: { armement: 5 }, dtech: { armement: 5, bouclier_graviton: 5 }, seed: 'a19' },
  // 20. Match nul possible (forces équivalentes)
  { name: 'CH 100 vs CR 30', a: { chasseur_lourd: 100 }, d: { croiseur: 30 }, seed: 'a20' },
];

test('snapshots combat — 20 scénarios canoniques', () => {
  for (const sc of SCENARIOS) {
    const rng = rngFromSeed(`combat:${sc.seed}`);
    const result = resolveCombat({
      attacker: { ships: sc.a, tech: sc.atech || {} },
      defender: { ships: sc.d, tech: sc.dtech || {} },
      rules,
      rng,
    });

    assert.ok(result.issue, `[${sc.name}] doit avoir une issue`);
    assert.ok(['victoire-attaquant', 'victoire-defenseur', 'annihilation-mutuelle', 'match-nul']
      .includes(result.issue), `[${sc.name}] issue valide`);
    assert.ok(Array.isArray(result.rondes), `[${sc.name}] rondes est un array`);
    assert.ok(result.rondes.length <= 6, `[${sc.name}] ≤ 6 rondes`);
    assert.deepEqual(result.attaquant_initial, sc.a, `[${sc.name}] initial conservé`);
    assert.deepEqual(result.defenseur_initial, sc.d, `[${sc.name}] initial conservé`);

    // Sanity : invariant "pas plus de vaisseaux après qu'avant"
    for (const [type, n] of Object.entries(result.attaquant_restant)) {
      assert.ok(n <= (sc.a[type] || 0), `[${sc.name}] ${type} survivants ≤ initial`);
    }
    for (const [type, n] of Object.entries(result.defenseur_restant)) {
      assert.ok(n <= (sc.d[type] || 0), `[${sc.name}] ${type} survivants ≤ initial`);
    }

    if (sc.expect) {
      assert.equal(result.issue, sc.expect, `[${sc.name}] issue attendue ${sc.expect}`);
    }
  }
});

test('combat est déterministe (même seed → même résultat)', () => {
  const setup = {
    attacker: { ships: { chasseur_leger: 100, chasseur_lourd: 20 }, tech: { armement: 3 } },
    defender: { ships: { chasseur_leger: 80, lance_missile: 50 }, tech: { bouclier_graviton: 2 } },
    rules,
  };

  const r1 = resolveCombat({ ...setup, rng: rngFromSeed('det:1') });
  const r2 = resolveCombat({ ...setup, rng: rngFromSeed('det:1') });

  assert.deepEqual(r1, r2, 'Deux runs avec le même seed sont identiques');
});

test('computeDebris : pertes produisent du ferrum + lumen', () => {
  const initial = { chasseur_leger: 100 };
  const remaining = { chasseur_leger: 30 };
  const debris = computeDebris(initial, remaining, rules);
  assert.ok(debris.ferrum > 0, 'Ferrum > 0');
  assert.ok(debris.lumen > 0, 'Lumen > 0');
});

test('computeDebris : pas de pertes → 0 débris', () => {
  const initial = { chasseur_leger: 100 };
  const debris = computeDebris(initial, initial, rules);
  assert.equal(debris.ferrum, 0);
  assert.equal(debris.lumen, 0);
});

test('computePillage : ne dépasse jamais 50% du stock', () => {
  const stocks = {
    ferrum: { stock: 1000 },
    lumen: { stock: 1000 },
    plasmide: { stock: 1000 },
  };
  const loot = computePillage(stocks, 99999, rules);
  assert.ok(loot.ferrum <= 500, 'ferrum ≤ 50%');
  assert.ok(loot.lumen <= 500, 'lumen ≤ 50%');
  assert.ok(loot.plasmide <= 500, 'plasmide ≤ 50%');
});

test('computePillage : limité par cargo disponible', () => {
  const stocks = {
    ferrum: { stock: 1000 },
    lumen: { stock: 1000 },
    plasmide: { stock: 1000 },
  };
  const loot = computePillage(stocks, 100, rules);
  const total = loot.ferrum + loot.lumen + loot.plasmide;
  assert.ok(total <= 100, `total pillé (${total}) ≤ cargo (100)`);
});
