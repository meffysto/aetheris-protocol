// AETHERIS // PROTOCOL — Initialisation du monde (logique iso).
// Importable depuis Node ou navigateur.
//
// Exports :
//   - spawnEmpireFromJoin({joinData, galaxie, tick, rng}) → { empire, mutated }
//   - createInitialGalaxie({nbSystemes, seed}) → galaxie object
//   - createInitialManifest({serveur, seed, nbSystemes, demarrage_iso}) → manifest

import { rngFromSeed } from './tick-core.mjs';

// ════════════════════════════════════════════════════════════════════════
// spawnEmpireFromJoin : crée l'empire d'un joueur depuis son inscription join.
//
// MUTE galaxie en attribuant la planète choisie au joueur.
// Détermisme : sélection = première tellurique libre (ou première libre tout court),
// ordre des systèmes/positions = clés numériques croissantes.
// ════════════════════════════════════════════════════════════════════════

/**
 * @param {object} params
 * @param {object} params.joinData     Yaml join parsé : { joueur, cle_publique?, alliance? }
 * @param {object} params.galaxie      Galaxie courante (mutée — réserve la planète choisie)
 * @param {number} [params.tick=0]
 * @param {function} params.rng        RNG déterministe ; obligatoire pour les champs
 * @returns {{ empire: object } | null}  null si pas de planète libre
 */
export function spawnEmpireFromJoin({ joinData, galaxie, tick = 0, rng }) {
  if (!joinData || !joinData.joueur) throw new Error('spawnEmpireFromJoin: joinData.joueur manquant');
  if (typeof rng !== 'function') throw new Error('spawnEmpireFromJoin: rng fourni requis');
  const name = joinData.joueur;
  const alliance = (joinData.alliance && joinData.alliance !== '~' && joinData.alliance !== 'null') ? joinData.alliance : null;

  const systemes = galaxie.systemes || {};
  // Tri par "g:s" lexicographique (déterministe)
  const sysKeys = Object.keys(systemes).sort();

  // Cherche la première planète libre (priorité tellurique)
  let chosen = null;
  for (const sk of sysKeys) {
    const sys = systemes[sk];
    const positions = sys.positions || {};
    const posKeys = Object.keys(positions).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    for (const p of posKeys) {
      const pos = positions[p];
      if (!pos || pos.type !== 'planete') continue;
      const owner = pos.proprietaire;
      if (owner !== null && owner !== undefined && owner !== '~' && owner !== 'null') continue;
      // Place candidate
      if (pos.classe === 'tellurique') { chosen = { sys: sk, p, pos, classe: pos.classe }; break; }
      if (!chosen) chosen = { sys: sk, p, pos, classe: pos.classe };
    }
    if (chosen?.classe === 'tellurique') break;
  }

  if (!chosen) return null;

  // Réserve la planète (mute galaxie)
  const planetName = `${name}-prima`;
  chosen.pos.proprietaire = name;
  chosen.pos.nom = planetName;

  // Coordonnées
  const [g, s] = chosen.sys.split(':').map(Number);

  // Champs (déterministe via rng)
  let champsTotal;
  if (chosen.classe === 'tellurique')      champsTotal = 200 + Math.floor(rng() * 80);
  else if (chosen.classe === 'cristalline') champsTotal = 130 + Math.floor(rng() * 90);
  else                                       champsTotal = 100 + Math.floor(rng() * 100);

  const empire = {
    version: 1,
    joueur: name,
    tick,
    score_total: 0,
    points_militaires: 0,
    rang: 999,
    alliance,
    planetes: [{
      nom: planetName,
      coordonnees: [g, s, chosen.p],
      type: chosen.classe,
      champs: { utilises: 0, total: champsTotal },
      ressources: {
        ferrum:   { stock: 500, production_par_utj: 30, capacite: 100000 },
        lumen:    { stock: 500, production_par_utj: 20, capacite: 100000 },
        plasmide: { stock: 0,   production_par_utj: 0,  capacite: 100000 },
      },
      energie: { production: 0, consommation: 0 },
      batiments: {
        mine_ferrum: 0, extracteur_lumen: 0, synthetiseur_plasmide: 0,
        centrale_solaire: 0, depot: 0, usine_robotique: 0,
        chantier_spatial: 0, laboratoire: 0,
      },
      file_chantier: [],
      file_construction: [],
      flotte_au_sol: {},
      defenses: {},
    }],
    flottes_en_vol: [],
    recherche: {},
    file_recherche: [],
  };

  return { empire };
}

// ════════════════════════════════════════════════════════════════════════
// createInitialGalaxie : génère la galaxie de départ depuis un seed.
// Déterministe (xoshiro128** seedé via SHA256).
// ════════════════════════════════════════════════════════════════════════

const PLANET_TYPES = ['tellurique', 'cristalline', 'volcanique', 'glacee', 'gazeuse'];

/**
 * @param {{ nbSystemes: number, seed: string, galaxie?: number }} params
 * @returns {object}
 */
export function createInitialGalaxie({ nbSystemes, seed, galaxie = 1 }) {
  const rng = rngFromSeed(seed + ':galaxie');
  const systemes = {};
  for (let s = 1; s <= nbSystemes; s++) {
    const positions = {};
    for (let p = 1; p <= 15; p++) {
      if (rng() < 0.45) {
        const t = PLANET_TYPES[Math.floor(rng() * PLANET_TYPES.length)];
        positions[p] = { type: 'planete', proprietaire: null, classe: t };
      } else {
        positions[p] = { type: 'asteroide' };
      }
    }
    systemes[`${galaxie}:${s}`] = {
      etoile: { nom: `stelara-${s}`, type: 'G', temperature_k: 5000 + Math.floor(rng() * 2000) },
      positions,
    };
  }
  return { version: 1, tick: 0, systemes };
}

/**
 * @param {{ serveur: string, seed: string, nbSystemes: number, demarrage_iso?: string, dureeTickMin?: number }} params
 * @returns {object}
 */
export function createInitialManifest({ serveur, seed, nbSystemes, demarrage_iso, dureeTickMin = 15 }) {
  return {
    version: 1,
    protocol_version: 0.1,
    serveur,
    tick: 0,
    seed,
    demarrage_iso: demarrage_iso || new Date().toISOString(),
    duree_tick_min: dureeTickMin,
    parametres: {
      galaxies: 1,
      systemes_par_galaxie: nbSystemes,
      positions_par_systeme: 15,
      planetes_max_par_joueur: 9,
    },
    hash_etat: 'sha256:' + '0'.repeat(32),
  };
}
