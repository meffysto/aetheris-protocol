// AETHERIS // PROTOCOL — Stratégie "eco"
// ──────────────────────────────────────
// Économique pure : monte les bâtiments de production en premier, ne touche
// jamais aux files si elles sont déjà occupées, et empile la recherche dans
// l'ordre des priorités. Jamais d'attaque. Port direct du baseline historique.
//
// Interface : decide({ empire, config, ctx }) → ordres[]
//   - empire : objet empire reconstitué par boot-bitcoin
//   - config : { priorites_batiments?, priorites_recherche?, ratio_recherche? }
//   - ctx    : { tickCible, rules } (non utilisé ici, mais transmis)

export const name = 'eco';

const DEFAULT_BATIMENTS = [
  'mine_ferrum', 'extracteur_lumen', 'synthetiseur_plasmide',
  'centrale_solaire', 'depot', 'usine_robotique', 'laboratoire',
];

const DEFAULT_RECHERCHE = [
  'robotique', 'automation_miniere', 'fusion_controlee',
  'drives_impulsion', 'armement',
];

function decideChantier(planete, prio) {
  if ((planete.file_chantier ?? []).length > 0) return null;
  const bat = planete.batiments ?? {};
  const sorted = [...prio].map(b => [b, bat[b] ?? 0]).sort((a, b) => a[1] - b[1]);
  const [cible, niveau] = sorted[0];
  return { type: 'chantier', planete: planete.nom, batiment: cible, niveau_cible: niveau + 1 };
}

function decideRecherche(empire, prio) {
  if ((empire.file_recherche ?? []).length > 0) return null;
  const rec = empire.recherche ?? {};
  const sorted = [...prio].map(t => [t, rec[t] ?? 0]).sort((a, b) => a[1] - b[1]);
  const [cible, niveau] = sorted[0];
  return { type: 'recherche', technologie: cible, niveau_cible: niveau + 1 };
}

export function decide({ empire, config = {} }) {
  const prioBat = config.priorites_batiments ?? DEFAULT_BATIMENTS;
  const prioRec = config.priorites_recherche ?? DEFAULT_RECHERCHE;

  const ordres = [];
  for (const p of empire.planetes ?? []) {
    const o = decideChantier(p, prioBat);
    if (o) ordres.push(o);
  }
  const r = decideRecherche(empire, prioRec);
  if (r) ordres.push(r);
  return ordres;
}
