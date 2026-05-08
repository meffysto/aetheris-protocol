// CITADEL // PROTOCOL — Résolveur de combat
// Déterministe, pur (pas d'I/O), import-only depuis tick.mjs ou test-combat.mjs.
//
// Modèle :
//   - 6 rondes max
//   - Chaque ronde : chaque type de vaisseau tire une fois, sa puissance est
//     répartie sur les vaisseaux ennemis au prorata du nombre, modulée par
//     bonus_contre.
//   - Boucliers regen 100% chaque ronde.
//   - Coque : pool persistant (les dégâts résiduels reportent ronde+1).
//   - Tech armement +10%/niveau sur attaque & coque, bouclier_graviton +10%/niv.
//   - Fin de ronde : un vaisseau partiellement endommagé sous le seuil
//     (≤ 30% coque) a 70% de chance d'exploser.

export function resolveCombat({ attacker, defender, rules, rng }) {
  const sides = {
    A: cloneSide(attacker),
    D: cloneSide(defender),
  };
  initHullPool(sides.A, rules);
  initHullPool(sides.D, rules);

  const rounds = [];
  const initialA = { ...attacker.ships };
  const initialD = { ...defender.ships };
  const maxRounds = rules.combat?.rondes_max || 6;

  for (let r = 1; r <= maxRounds; r++) {
    const fireA = computeFire(sides.A, sides.D, rules);
    const fireD = computeFire(sides.D, sides.A, rules);

    const lossesD = applyDamage(sides.D, fireA, rules, rng);
    const lossesA = applyDamage(sides.A, fireD, rules, rng);

    rounds.push({
      ronde: r,
      tir_attaquant: Math.round(sumValues(fireA)),
      tir_defenseur: Math.round(sumValues(fireD)),
      pertes_attaquant: pruneZero(lossesA),
      pertes_defenseur: pruneZero(lossesD),
    });

    if (sumShips(sides.A) === 0 || sumShips(sides.D) === 0) break;
  }

  const aAlive = sumShips(sides.A);
  const dAlive = sumShips(sides.D);
  let issue;
  if (aAlive > 0 && dAlive === 0) issue = 'victoire-attaquant';
  else if (dAlive > 0 && aAlive === 0) issue = 'victoire-defenseur';
  else if (aAlive === 0 && dAlive === 0) issue = 'annihilation-mutuelle';
  else issue = 'match-nul';

  return {
    issue,
    rondes: rounds,
    attaquant_initial: initialA,
    defenseur_initial: initialD,
    attaquant_restant: pruneZero(sides.A.ships),
    defenseur_restant: pruneZero(sides.D.ships),
  };
}

export function computeDebris(initial, remaining, rules) {
  const ratio = rules.combat?.ratio_debris ?? 0.30;
  const debris = { ferrum: 0, lumen: 0 };
  for (const [type, n0] of Object.entries(initial)) {
    const n1 = remaining[type] || 0;
    const lost = n0 - n1;
    if (lost <= 0) continue;
    const def = getUnitDef(rules, type);
    if (!def) continue;
    debris.ferrum += Math.floor(lost * (def.cout?.ferrum || 0) * ratio);
    debris.lumen += Math.floor(lost * (def.cout?.lumen || 0) * ratio);
  }
  return debris;
}

export function computePillage(stocks, totalCargo, rules) {
  const max = rules.combat?.pillage_max ?? 0.5;
  const types = ['ferrum', 'lumen', 'plasmide'];
  const loot = { ferrum: 0, lumen: 0, plasmide: 0 };
  let cargo = Math.max(0, Math.floor(totalCargo));

  for (const r of types) {
    const avail = Math.floor((stocks[r]?.stock || 0) * max);
    const take = Math.min(avail, Math.floor(cargo / types.length));
    loot[r] = take;
    cargo -= take;
  }

  const sorted = [...types].sort((a, b) => {
    const remA = Math.floor((stocks[a]?.stock || 0) * max) - loot[a];
    const remB = Math.floor((stocks[b]?.stock || 0) * max) - loot[b];
    return remB - remA;
  });
  for (const r of sorted) {
    if (cargo <= 0) break;
    const remaining = Math.floor((stocks[r]?.stock || 0) * max) - loot[r];
    const take = Math.min(remaining, cargo);
    loot[r] += take;
    cargo -= take;
  }
  return loot;
}

function getUnitDef(rules, type) {
  return rules.vaisseaux?.[type] || rules.defenses?.[type] || null;
}

function cloneSide(s) {
  return {
    ships: { ...(s.ships || {}) },
    tech: { ...(s.tech || {}) },
    hullPool: {},
  };
}

function initHullPool(side, rules) {
  for (const [type, count] of Object.entries(side.ships)) {
    const def = getUnitDef(rules, type);
    if (!def) continue;
    const techArmor = 1 + 0.10 * (side.tech.armement || 0);
    side.hullPool[type] = count * def.coque * techArmor;
  }
}

function sumShips(s) {
  return Object.values(s.ships).reduce((a, b) => a + b, 0);
}

function sumValues(m) {
  return Object.values(m).reduce((a, b) => a + b, 0);
}

function pruneZero(m) {
  const out = {};
  for (const [k, v] of Object.entries(m)) if (v > 0) out[k] = v;
  return out;
}

function computeFire(attackerSide, defenderSide, rules) {
  const fire = {};
  const totalDef = sumShips(defenderSide);
  if (totalDef === 0) return fire;

  const techAtk = 1 + 0.10 * (attackerSide.tech.armement || 0);

  for (const [atkType, atkCount] of Object.entries(attackerSide.ships)) {
    if (atkCount <= 0) continue;
    const def = getUnitDef(rules, atkType);
    if (!def || !def.attaque) continue;

    for (const [tgtType, tgtCount] of Object.entries(defenderSide.ships)) {
      if (tgtCount <= 0) continue;
      const bonus = def.bonus_contre?.[tgtType] || 1.0;
      const shots = atkCount * (tgtCount / totalDef);
      fire[tgtType] = (fire[tgtType] || 0) + shots * def.attaque * techAtk * bonus;
    }
  }
  return fire;
}

function applyDamage(side, damageMap, rules, rng) {
  const losses = {};
  const techShield = 1 + 0.10 * (side.tech.bouclier_graviton || 0);
  const techArmor = 1 + 0.10 * (side.tech.armement || 0);
  const seuil = rules.combat?.seuil_destruction_coque ?? 0.30;
  const probaKill = rules.combat?.proba_destruction ?? 0.70;

  for (const [type, dmg] of Object.entries(damageMap)) {
    const def = getUnitDef(rules, type);
    if (!def) continue;
    const count = side.ships[type] || 0;
    if (count === 0) continue;

    const shieldPool = count * def.bouclier * techShield;
    const hullDamage = Math.max(0, dmg - shieldPool);

    side.hullPool[type] = (side.hullPool[type] || count * def.coque * techArmor) - hullDamage;
    if (side.hullPool[type] < 0) side.hullPool[type] = 0;

    const hullPerShip = def.coque * techArmor;
    const aliveAfterPool = Math.ceil(side.hullPool[type] / hullPerShip);
    const fullKills = Math.max(0, count - aliveAfterPool);
    let totalKills = fullKills;

    const survivorsBefore = count - fullKills;
    if (survivorsBefore > 0 && side.hullPool[type] > 0) {
      const avgRatio = side.hullPool[type] / (survivorsBefore * hullPerShip);
      if (avgRatio <= seuil) {
        let extra = 0;
        for (let i = 0; i < survivorsBefore; i++) {
          if (rng() < probaKill) extra++;
        }
        totalKills += extra;
        side.hullPool[type] = Math.max(0, side.hullPool[type] - extra * hullPerShip * avgRatio);
      }
    }

    totalKills = Math.min(totalKills, count);
    if (totalKills > 0) {
      losses[type] = totalKills;
      side.ships[type] = count - totalKills;
    }
  }
  return losses;
}
