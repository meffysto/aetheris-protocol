// AETHERIS // PROTOCOL — Stratégie "turtle"
// ──────────────────────────────────────────
// Tortue : biais recherche prononcé. Si la file de recherche est libre, on
// inscrit toujours une recherche en plus du chantier — la R&D prend le pas
// sur l'expansion brute. Pas d'attaque. Bâtiments défensifs prioritaires.
//
// Si la stratégie eco tourne un peu trop sur la prod, turtle décale vers
// laboratoire et centrale solaire en tête, puis recherche systématique.

import { decide as ecoDecide } from './eco.mjs';

export const name = 'turtle';

const DEFAULT_BATIMENTS = [
  'laboratoire', 'centrale_solaire', 'depot',
  'mine_ferrum', 'extracteur_lumen', 'synthetiseur_plasmide',
  'usine_robotique',
];

const DEFAULT_RECHERCHE = [
  'robotique', 'fusion_controlee', 'automation_miniere',
  'drives_impulsion', 'armement',
];

export function decide({ empire, config = {}, ctx }) {
  const merged = {
    priorites_batiments: config.priorites_batiments ?? DEFAULT_BATIMENTS,
    priorites_recherche: config.priorites_recherche ?? DEFAULT_RECHERCHE,
  };
  return ecoDecide({ empire, config: merged, ctx });
}
