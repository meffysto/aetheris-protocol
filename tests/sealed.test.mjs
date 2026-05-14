// Tests du protocole commit-reveal (option B : reveal à l'impact).
// Couvre :
//   1. Scénario nominal — sealed T1, reveal T3, combat résolu T3
//   2. Hash mismatch — reveal rejeté + sceau consommé
//   3. Non-reveal au tick_impact — sceau expire (forfait silencieux v1)
//   4. Déterminisme — même seed + même séquence → même résultat

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTick } from '../engine/tick-core.mjs';
import { computeSealHash } from '../engine/sealed-protocol.mjs';
import * as combat from '../engine/combat.mjs';
import { readYaml, readRules, clone } from './helpers.mjs';

const rules = readRules();
const galaxie = readYaml('world/galaxie.yaml');

function baseManifest(tick = 0) {
  return {
    version: 1,
    serveur: 'test-sealed',
    tick,
    seed: '0xfeedfacecafe1337',
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

function planet(nom, coordonnees = [1, 1, 7], opts = {}) {
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
      // chantier_spatial niv 1 par défaut : depuis le fix gating
      // (tick-core.mjs:requireChantierSpatial), toute mission de flotte
      // exige ce bâtiment. Les tests qui jouent avec une flotte_au_sol
      // pré-positionnée doivent donc avoir le chantier qui va avec.
      chantier_spatial: 1, laboratoire: 0,
    },
    file_chantier: [],
    file_construction: [],
    flotte_au_sol: opts.flotte || {},
    defenses: opts.defenses || {},
  };
}

function makeScenario({ flotteAttaquant = { chasseur_leger: 100 } } = {}) {
  // Attaquant et défenseur dans le même système : distance courte.
  const attaquant = emptyEmpire('attk', [
    planet('attk-base', [1, 1, 7], { flotte: flotteAttaquant }),
  ]);
  const defenseur = emptyEmpire('def', [
    planet('def-base', [1, 1, 8]),
  ]);
  return { attk: attaquant, def: defenseur };
}

function buildSecret(overrides = {}) {
  return {
    type: 'attaque',
    depuis: 'attk-base',
    cible: { joueur: 'def', planete: 'def-base' },
    flotte: { chasseur_leger: 50 },
    vitesse: 100,
    nonce: 'deadbeef',
    ...overrides,
  };
}

test('sealed/reveal : scénario nominal — combat se résout au tick_impact (dérivé du vol)', async () => {
  const empires = makeScenario();
  let manifest = baseManifest(0);

  const secret = buildSecret();
  const hash = computeSealHash(secret);
  const sealedTxid = 'tx-sealed-001';

  // Distance [1,1,7]→[1,1,8] = 1005, chasseur_leger vitesse=12500
  // → flightUTJ = ceil(1005/12500*100) = 9 → flightTicks = ceil(9/6) = 2
  // sealed.tick_depart=1 → reveal attendu au tick 3.
  const EXPECTED_IMPACT = 3;

  // Tick 1 : on enregistre le sceau (tick_depart=1, pas de tick_impact public)
  const sealedOrders = {
    attk: {
      parsed: {
        type: 'sealed', version: 1, joueur: 'attk',
        tick_depart: 1,
        planete_origine: 'attk-base',
        kind: 'militaire',
        hash,
      },
      txid: sealedTxid,
    },
  };

  let result = await runTick({
    manifest, rules, galaxie, empires, orders: {}, identites: {},
    sealedOrders, revealOrders: [], combat,
  });
  manifest = result.newManifest;

  assert.equal(manifest.tick, 1);
  assert.ok(manifest.sealedPending[sealedTxid], 'sceau enregistré dans pending');
  assert.equal(manifest.sealedPending[sealedTxid].joueur, 'attk');
  assert.equal(manifest.sealedPending[sealedTxid].tick_depart, 1);
  assert.equal(manifest.sealedPending[sealedTxid].tick_impact, undefined, 'plus de tick_impact dans le pending');

  // Tick 2 : sceau toujours pending (vol en cours)
  result = await runTick({
    manifest, rules, galaxie, empires: result.newEmpires,
    orders: {}, identites: {}, sealedOrders: {}, revealOrders: [], combat,
  });
  manifest = result.newManifest;
  assert.equal(manifest.tick, 2);
  assert.ok(manifest.sealedPending[sealedTxid], 'sceau toujours en attente (flotte en vol)');

  // Tick 3 : reveal arrive au tick d'arrivée physique — combat se résout
  const flotteAvantAttk = result.newEmpires.attk.planetes[0].flotte_au_sol.chasseur_leger;
  const revealOrders = [{
    parsed: {
      type: 'reveal', version: 1, joueur: 'attk',
      tick_impact: EXPECTED_IMPACT, sealed_txid: sealedTxid,
      secret,
    },
    txid: 'tx-reveal-001',
    joueur: 'attk',
  }];

  result = await runTick({
    manifest, rules, galaxie, empires: result.newEmpires,
    orders: {}, identites: {}, sealedOrders: {}, revealOrders, combat,
  });
  manifest = result.newManifest;

  assert.equal(manifest.tick, EXPECTED_IMPACT);
  assert.ok(!manifest.sealedPending[sealedTxid], 'sceau consommé après reveal');

  // La flotte d'attaque a été débitée de la planète origine
  const flotteApresAttk = result.newEmpires.attk.planetes[0].flotte_au_sol.chasseur_leger || 0;
  assert.equal(flotteApresAttk, flotteAvantAttk - 50, 'flotte débitée pour l\'attaque');

  // Un event reveal-resolu doit être présent
  const ev = result.events.find(e => e.type === 'reveal-resolu');
  assert.ok(ev, 'event reveal-resolu émis');
  assert.equal(ev.joueur, 'attk');
  assert.equal(ev.sealed_txid, sealedTxid);

  // Combat doit avoir eu lieu (event 'bataille' ou flotte de retour côté attaquant)
  const bataille = result.events.find(e => e.type === 'bataille');
  assert.ok(bataille, 'combat résolu ce tick (event bataille)');
});

test('sealed/reveal : hash mismatch → reveal rejeté + sceau consommé', async () => {
  const empires = makeScenario();
  let manifest = baseManifest(0);

  const secret = buildSecret();
  const hash = computeSealHash(secret);
  const sealedTxid = 'tx-sealed-002';

  // T1 : enregistre le sceau
  let result = await runTick({
    manifest, rules, galaxie, empires, orders: {}, identites: {},
    sealedOrders: {
      attk: {
        parsed: {
          type: 'sealed', version: 1, joueur: 'attk',
          tick_depart: 1,
          planete_origine: 'attk-base',
          kind: 'militaire',
          hash,
        },
        txid: sealedTxid,
      },
    },
    revealOrders: [], combat,
  });
  manifest = result.newManifest;
  assert.ok(manifest.sealedPending[sealedTxid]);

  // T2 : avance d'un tick (pas de reveal, vol en cours)
  result = await runTick({
    manifest, rules, galaxie, empires: result.newEmpires,
    orders: {}, identites: {}, sealedOrders: {}, revealOrders: [], combat,
  });
  manifest = result.newManifest;

  // T3 : reveal au bon timing mais avec un secret différent (nonce changé)
  const flotteAvant = result.newEmpires.attk.planetes[0].flotte_au_sol.chasseur_leger;
  const cheatedSecret = buildSecret({ nonce: 'baadcafe' }); // hash sera différent
  result = await runTick({
    manifest, rules, galaxie, empires: result.newEmpires,
    orders: {}, identites: {}, sealedOrders: {},
    revealOrders: [{
      parsed: {
        type: 'reveal', version: 1, joueur: 'attk',
        tick_impact: 3, sealed_txid: sealedTxid,
        secret: cheatedSecret,
      },
      txid: 'tx-reveal-002',
      joueur: 'attk',
    }],
    combat,
  });

  assert.ok(!result.newManifest.sealedPending[sealedTxid], 'sceau consommé même si reveal invalide');
  const flotteApres = result.newEmpires.attk.planetes[0].flotte_au_sol.chasseur_leger || 0;
  assert.equal(flotteApres, flotteAvant, 'flotte intacte (pas de combat)');
  const ev = result.events.find(e => e.type === 'reveal-hash-mismatch');
  assert.ok(ev, 'event reveal-hash-mismatch émis');
});

test('sealed/reveal : timing mismatch — reveal trop tôt ou trop tard → REJETÉ', async () => {
  const empires = makeScenario();
  let manifest = baseManifest(0);

  const secret = buildSecret();
  const hash = computeSealHash(secret);
  const sealedTxid = 'tx-sealed-timing';

  // T1 : sealed (tick_depart=1, flight=2 → impact attendu T3)
  let result = await runTick({
    manifest, rules, galaxie, empires, orders: {}, identites: {},
    sealedOrders: {
      attk: {
        parsed: {
          type: 'sealed', version: 1, joueur: 'attk',
          tick_depart: 1,
          planete_origine: 'attk-base',
          kind: 'militaire',
          hash,
        },
        txid: sealedTxid,
      },
    },
    revealOrders: [], combat,
  });
  manifest = result.newManifest;

  // T2 : reveal qui prétend arriver à T=2 (trop tôt)
  result = await runTick({
    manifest, rules, galaxie, empires: result.newEmpires,
    orders: {}, identites: {}, sealedOrders: {},
    revealOrders: [{
      parsed: {
        type: 'reveal', version: 1, joueur: 'attk',
        tick_impact: 2, sealed_txid: sealedTxid,
        secret,
      },
      txid: 'tx-reveal-early',
      joueur: 'attk',
    }],
    combat,
  });
  manifest = result.newManifest;

  // Le secret du reveal étant déjà public on-chain, le sceau est consommé
  // (le joueur ne peut pas re-tenter avec une surprise — elle est foutue).
  assert.ok(!manifest.sealedPending[sealedTxid], 'sceau consommé (secret déjà leaké par le reveal hors-timing)');
  const ev = result.events.find(e => e.type === 'reveal-timing-mismatch');
  assert.ok(ev, 'event reveal-timing-mismatch émis');
  assert.equal(ev.expectedImpact, 3, 'expected impact = T3 (flight déterministe)');
  assert.equal(ev.actualImpact, 2, 'actual = T2 (reveal trop tôt)');
});

test('sealed/reveal : non-reveal → sceau reste pending tant que patience non dépassée', async () => {
  const empires = makeScenario();
  let manifest = baseManifest(0);

  const secret = buildSecret();
  const hash = computeSealHash(secret);
  const sealedTxid = 'tx-sealed-003';

  // T1 : sealed
  let result = await runTick({
    manifest, rules, galaxie, empires, orders: {}, identites: {},
    sealedOrders: {
      attk: {
        parsed: {
          type: 'sealed', version: 1, joueur: 'attk',
          tick_depart: 1,
          planete_origine: 'attk-base',
          kind: 'militaire',
          hash,
        },
        txid: sealedTxid,
      },
    },
    revealOrders: [], combat,
  });
  manifest = result.newManifest;
  assert.ok(manifest.sealedPending[sealedTxid]);

  // T2..T10 : pas de reveal — sceau doit rester (patience longue)
  for (let i = 0; i < 9; i++) {
    result = await runTick({
      manifest, rules, galaxie, empires: result.newEmpires,
      orders: {}, identites: {}, sealedOrders: {}, revealOrders: [], combat,
    });
    manifest = result.newManifest;
  }
  assert.ok(manifest.sealedPending[sealedTxid], 'sceau toujours pending après 9 ticks sans reveal (patience non dépassée)');
});

test('sealed/reveal : déterminisme — même séquence → même résultat', async () => {
  async function runSequence() {
    const empires = makeScenario();
    let manifest = baseManifest(0);
    const secret = buildSecret();
    const hash = computeSealHash(secret);
    const sealedTxid = 'tx-det-001';

    let result = await runTick({
      manifest, rules, galaxie, empires, orders: {}, identites: {},
      sealedOrders: {
        attk: {
          parsed: {
            type: 'sealed', version: 1, joueur: 'attk',
            tick_depart: 1,
            planete_origine: 'attk-base', kind: 'militaire', hash,
          },
          txid: sealedTxid,
        },
      },
      revealOrders: [], combat,
    });
    manifest = result.newManifest;

    // T2 : flotte en vol
    result = await runTick({
      manifest, rules, galaxie, empires: result.newEmpires,
      orders: {}, identites: {}, sealedOrders: {}, revealOrders: [], combat,
    });
    manifest = result.newManifest;

    // T3 : reveal au tick d'impact dérivé (flight=2 ticks)
    result = await runTick({
      manifest, rules, galaxie, empires: result.newEmpires,
      orders: {}, identites: {}, sealedOrders: {},
      revealOrders: [{
        parsed: {
          type: 'reveal', version: 1, joueur: 'attk',
          tick_impact: 3, sealed_txid: sealedTxid, secret,
        },
        txid: 'tx-rev-det',
        joueur: 'attk',
      }],
      combat,
    });
    return result;
  }

  const r1 = await runSequence();
  const r2 = await runSequence();
  assert.equal(r1.newManifest.hash_etat, r2.newManifest.hash_etat, 'hash_etat identique');
});

test('computeSealHash : déterministe + sensible au nonce', () => {
  const a = { type: 'attaque', depuis: 'x', cible: { joueur: 'y', planete: 'z' }, flotte: { ch: 1 }, vitesse: 100, nonce: 'aa' };
  const b = clone(a);
  const c = { ...clone(a), nonce: 'bb' };
  assert.equal(computeSealHash(a), computeSealHash(b), 'même contenu → même hash');
  assert.notEqual(computeSealHash(a), computeSealHash(c), 'nonce différent → hash différent');
  assert.match(computeSealHash(a), /^[0-9a-f]{64}$/);
});
