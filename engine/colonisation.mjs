// CITADEL // PROTOCOL — Colonisation des planètes inhabitées.
// Module pur : la logique iso vit ici, tick-core.mjs orchestre les appels.
//
// Exports :
//   - queueColonisation(emp, action, ctx)            — validation + push flotte à l'envoi
//   - resolveColonisationArrivee(arr, ctx)           — résolution succès/échec à l'arrivée
//   - validateNomColonie(nom, emp, galaxie)          — validation du nom (testable)
//   - autoFallbackName(emp)                          — nom auto déterministe
//
// Décisions de design (voir engine/PROTOCOL.md) :
//   - Type d'ordre dédié `colonisation` (canal scellé : engagements[].type = 'colonial').
//   - Cible adressée par { systeme: "g:s", position: N } (pas de nom, la case est inhabitée).
//   - Double-check (envoi + arrivée) sur disponibilité + cap planetes_max_par_joueur.
//   - À la réussite : 1 vaisseau_colon consommé, escorte + cargo atterrissent.
//   - À l'échec : flotte transformée en retour vers la planète source.

import { createBlankPlanete } from './world-init-core.mjs';

const NOM_REGEX = /^[a-z][a-z0-9\-]{2,39}$/;
const RESERVED_NAMES = new Set(['null', 'none', 'undefined', 'true', 'false']);
const AUTO_NAME_RE = /^(.+)-c\d+$/;

// ════════════════════════════════════════════════════════════════════════
// validateNomColonie : vérifie qu'un nom proposé est acceptable.
// Retourne { ok: true, nom } ou { ok: false, raison }.
// Si nom absent → fallback déterministe <joueur>-c<n>.
// ════════════════════════════════════════════════════════════════════════
export function validateNomColonie(nom, emp, galaxie) {
  if (!nom || typeof nom !== 'string' || nom.trim() === '') {
    return { ok: true, nom: autoFallbackName(emp) };
  }
  const n = nom.trim();
  if (!NOM_REGEX.test(n)) return { ok: false, raison: 'format-invalide' };
  if (RESERVED_NAMES.has(n)) return { ok: false, raison: 'nom-reserve' };
  // Format <joueur>-c<digits> est réservé au fallback auto. Un joueur ne peut
  // poser ce format que pour son propre namespace (et même là on l'évite —
  // ça pourrait collisionner avec le compteur futur).
  const autoMatch = AUTO_NAME_RE.exec(n);
  if (autoMatch) return { ok: false, raison: 'format-reserve-auto' };
  // Unicité globale dans la galaxie.
  for (const sys of Object.values(galaxie.systemes || {})) {
    for (const pos of Object.values(sys.positions || {})) {
      if (pos && pos.nom === n) return { ok: false, raison: 'nom-deja-pris' };
    }
  }
  return { ok: true, nom: n };
}

export function autoFallbackName(emp) {
  return `${emp.joueur}-c${(emp.planetes || []).length + 1}`;
}

// ════════════════════════════════════════════════════════════════════════
// queueColonisation : appelé depuis applyOrder (tick-core) à la révélation
// d'un ordre `colonisation`. Valide tout, consomme les ressources/vaisseaux
// sur la planète source, et pousse une flotte en vol.
// ════════════════════════════════════════════════════════════════════════
export function queueColonisation(emp, action, ctx) {
  const { galaxie, manifest, log, playerName, tickSuivant, rng, computeDistanceToCoords } = ctx;

  // 1) Planète source.
  const src = (emp.planetes || []).find(p => p.nom === action.depuis);
  if (!src) { log(`  · ${playerName}: colonisation depuis ${action.depuis} introuvable`); return; }

  // 2) Cible bien formée.
  const cible = action.cible || {};
  if (!cible.systeme || cible.position === undefined || cible.position === null) {
    log(`  · ${playerName}: colonisation sans cible valide`);
    return;
  }
  const sysKey = String(cible.systeme);
  const posKey = String(cible.position);
  const sysObj = galaxie?.systemes?.[sysKey];
  if (!sysObj) { log(`  · ${playerName}: colonisation : système ${sysKey} introuvable`); return; }
  const cell = sysObj.positions?.[posKey];
  if (!cell || cell.type !== 'planete') {
    log(`  · ${playerName}: colonisation : ${sysKey}:${posKey} n'est pas une planète`);
    return;
  }
  // Re-check libre (Q3 — double-check).
  if (cell.proprietaire !== null && cell.proprietaire !== undefined && cell.proprietaire !== '~') {
    log(`  · ${playerName}: colonisation : ${sysKey}:${posKey} déjà possédée par ${cell.proprietaire}`);
    return;
  }

  // 3) Cap planètes (planetes possédées + colons déjà en vol).
  const cap = manifest?.parametres?.planetes_max_par_joueur ?? 9;
  const colonsEnVol = (emp.flottes_en_vol || []).filter(f => f.type_mission === 'colonisation').length;
  if ((emp.planetes?.length || 0) + colonsEnVol >= cap) {
    log(`  · ${playerName}: colonisation : cap ${cap} planètes (possédées + en cours) atteint`);
    return;
  }

  // 4) Flotte : au moins 1 vaisseau_colon.
  const flotte = action.flotte || {};
  const nbColons = parseInt(flotte.vaisseau_colon, 10) || 0;
  if (nbColons < 1) {
    log(`  · ${playerName}: colonisation requiert au moins 1 vaisseau_colon`);
    return;
  }
  // Vérification des disponibilités au sol.
  for (const [ship, n] of Object.entries(flotte)) {
    if ((src.flotte_au_sol?.[ship] || 0) < n) {
      log(`  · ${playerName}: colonisation : flotte insuffisante (${ship}) sur ${src.nom}`);
      return;
    }
  }
  // Vérification de la cargaison.
  const cargaison = action.cargaison || {};
  for (const [res, n] of Object.entries(cargaison)) {
    if ((src.ressources?.[res]?.stock || 0) < n) {
      log(`  · ${playerName}: colonisation : cargaison ${res} insuffisante sur ${src.nom}`);
      return;
    }
  }

  // 5) Validation du nom de colonie (avec fallback auto).
  const v = validateNomColonie(action.nom_colonie, emp, galaxie);
  if (!v.ok) {
    log(`  · ${playerName}: colonisation : nom invalide (${v.raison})`);
    return;
  }
  const nomColonie = v.nom;

  // 6) Coordonnées cibles + durée de vol.
  const [g, s] = sysKey.split(':').map(Number);
  const p = parseInt(posKey, 10);
  const cibleCoords = [g, s, p];
  const distance = computeDistanceToCoords(action.depuis, cibleCoords, playerName);
  // La vitesse limite la flotte = min des vitesses (déjà la convention transport).
  // Recherches `drives_impulsion` (sub-FTL) et `drive_hyperspatial` (FTL) :
  // +5%/niv. vaisseau_colon est FTL ; cargo_lourd est sub-FTL.
  const SHIPS_FTL = new Set(['cuirasse', 'vaisseau_colon', 'recycleur']);
  const rech = emp.recherche || {};
  const vMin = Math.min(
    ...Object.keys(flotte).map(ship => {
      const base = ctx.rules?.vaisseaux?.[ship]?.vitesse || 1000;
      const tech = SHIPS_FTL.has(ship) ? (rech.drive_hyperspatial || 0) : (rech.drives_impulsion || 0);
      return base * (1 + 0.05 * tech);
    })
  );
  const dureeUTJ = Math.max(1, Math.ceil((distance / vMin) * 100));

  // 7) Consommation des ressources/flotte.
  for (const [ship, n] of Object.entries(flotte)) src.flotte_au_sol[ship] -= n;
  for (const [res, n] of Object.entries(cargaison)) src.ressources[res].stock -= n;

  // 8) Push flotte en vol.
  emp.flottes_en_vol = emp.flottes_en_vol || [];
  emp.flottes_en_vol.push({
    id: `flt-${tickSuivant}-${rng().toString(36).slice(2, 6)}`,
    type_mission: 'colonisation',
    depuis: { joueur: playerName, planete: action.depuis },
    vers: { systeme: sysKey, position: p },
    cible_coords: cibleCoords,
    nom_colonie: nomColonie,
    arrivee_utj: dureeUTJ,
    duree_aller_utj: dureeUTJ,
    composition: { ...flotte },
    cargaison: { ...cargaison },
  });

  log(`  🌱 ${playerName}: colonisation ${action.depuis} → ${sysKey}:${p} (${nomColonie}, ${dureeUTJ} UTJ)`);
}

// ════════════════════════════════════════════════════════════════════════
// resolveColonisationArrivee : appelé en fin de phase 4 pour chaque flotte
// dont le type_mission est 'colonisation' et qui arrive ce tick.
// Tie-break (multi-arrivées même case) géré par l'appelant via sort lex
// (joueur ASC, id ASC). Cette fonction se contente d'observer l'état actuel
// de la galaxie : la première qui s'exécute gagne, les suivantes voient
// proprietaire != null et échouent.
// ════════════════════════════════════════════════════════════════════════
export function resolveColonisationArrivee(arr, ctx) {
  const { galaxie, manifest, empires, log, events, reports, rng, tickSuivant } = ctx;
  const flt = arr.flotte;
  const playerName = arr.proprietaire;
  const emp = empires[playerName];
  if (!emp) { log(`  · colonisation: empire ${playerName} introuvable`); return; }

  const sysKey = String(flt.vers?.systeme);
  const posKey = String(flt.vers?.position);
  const cell = galaxie?.systemes?.[sysKey]?.positions?.[posKey];

  let raison = null;
  if (!cell || cell.type !== 'planete') {
    raison = 'cible-invalide';
  } else if (cell.proprietaire !== null && cell.proprietaire !== undefined && cell.proprietaire !== '~') {
    raison = 'cible-occupee';
  } else {
    const cap = manifest?.parametres?.planetes_max_par_joueur ?? 9;
    if ((emp.planetes?.length || 0) >= cap) raison = 'cap-atteint';
  }

  if (raison) {
    spawnRetour(emp, flt, raison, { rng, tickSuivant, events, reports, log, playerName });
    return;
  }

  // Succès : créer la planète, muter galaxie, déposer escorte + cargaison.
  const [g, s, p] = flt.cible_coords || [];
  const planete = createBlankPlanete({
    classe: cell.classe,
    coordonnees: [g, s, p],
    nom: flt.nom_colonie,
    rng,
  });
  // Cargaison livrée (clampée à la capacité existante = 100k par ressource).
  for (const [res, n] of Object.entries(flt.cargaison || {})) {
    if (!planete.ressources[res]) continue;
    const cap = planete.ressources[res].capacite || 0;
    planete.ressources[res].stock = Math.min(cap, n);
  }
  // Escorte : tous les vaisseaux SAUF 1 vaisseau_colon (consommé).
  const restants = { ...flt.composition };
  restants.vaisseau_colon = (restants.vaisseau_colon || 0) - 1;
  if (restants.vaisseau_colon <= 0) delete restants.vaisseau_colon;
  for (const [ship, n] of Object.entries(restants)) {
    if (n > 0) planete.flotte_au_sol[ship] = n;
  }

  emp.planetes = emp.planetes || [];
  emp.planetes.push(planete);

  // Mutation galaxie.
  cell.proprietaire = playerName;
  cell.nom = flt.nom_colonie;

  events.push({
    type: 'colonisation-reussie',
    joueur: playerName,
    nom: flt.nom_colonie,
    systeme: sysKey, position: p,
    classe: cell.classe,
  });

  const tickStr = String(tickSuivant).padStart(4, '0');
  reports.battles.push({
    player: playerName,
    filename: `world/events/tick-${tickStr}-colonisation-${flt.nom_colonie}.md`,
    content: renderColonisationMd({
      joueur: playerName,
      nom: flt.nom_colonie,
      systeme: sysKey,
      position: p,
      classe: cell.classe,
      tick: tickSuivant,
      composition_atterrie: restants,
      cargaison: flt.cargaison || {},
    }),
  });

  log(`  🌱 ${playerName}: colonie ${flt.nom_colonie} fondée sur ${sysKey}:${p} (${cell.classe})`);
}

// ── Internes ────────────────────────────────────────────────────────────

function spawnRetour(emp, flt, raison, { rng, tickSuivant, events, reports, log, playerName }) {
  const dureeRetour = flt.duree_aller_utj || flt.arrivee_utj || 1;
  emp.flottes_en_vol = emp.flottes_en_vol || [];
  emp.flottes_en_vol.push({
    id: `flt-${tickSuivant}-cret-${rng().toString(36).slice(2, 4)}`,
    type_mission: 'retour',
    depuis: { joueur: playerName, planete: `${flt.vers.systeme}:${flt.vers.position}` },
    vers: { joueur: playerName, planete: flt.depuis.planete },
    arrivee_utj: dureeRetour,
    composition: { ...flt.composition },
    cargaison: { ...flt.cargaison },
  });

  events.push({
    type: 'colonisation-echouee',
    joueur: playerName,
    systeme: flt.vers.systeme,
    position: flt.vers.position,
    raison,
    retour_eta_utj: dureeRetour,
  });

  const tickStr = String(tickSuivant).padStart(4, '0');
  reports.alerts.push({
    player: playerName,
    filename: `joueurs/${playerName}/intel/tick-${tickStr}-colonisation-echec.md`,
    content: renderColonisationEchecMd({
      joueur: playerName,
      systeme: flt.vers.systeme,
      position: flt.vers.position,
      raison,
      tick: tickSuivant,
      retour_eta_utj: dureeRetour,
      vers_planete: flt.depuis.planete,
    }),
  });

  log(`  ✗ ${playerName}: colonisation ${flt.vers.systeme}:${flt.vers.position} échouée (${raison}) → retour ${flt.depuis.planete} (${dureeRetour} UTJ)`);
}

function renderColonisationMd({ joueur, nom, systeme, position, classe, tick, composition_atterrie, cargaison }) {
  const compoLines = Object.entries(composition_atterrie || {}).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (aucune)';
  const cargoLines = Object.entries(cargaison || {}).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (aucune)';
  return `---
type: colonisation
tick: ${tick}
joueur: ${joueur}
nom_colonie: ${nom}
lieu: { systeme: "${systeme}", position: ${position} }
classe: ${classe}
---

# Colonisation de ${nom} — tick ${tick}

${joueur} a fondé une nouvelle colonie sur ${systeme}:${position} (planète ${classe}).
Un vaisseau_colon a été consommé pour fonder l'installation.

## Garnison atterrie
${compoLines}

## Cargaison livrée
${cargoLines}
`;
}

function renderColonisationEchecMd({ joueur, systeme, position, raison, tick, retour_eta_utj, vers_planete }) {
  const raisons = {
    'cible-occupee': 'Une autre puissance a colonisé la case avant ton arrivée.',
    'cap-atteint':   'Ton empire a atteint son quota maximum de planètes.',
    'cible-invalide': 'La case n\'est plus une planète valide.',
  };
  return `---
type: colonisation-echec
tick: ${tick}
joueur: ${joueur}
lieu: { systeme: "${systeme}", position: ${position} }
raison: ${raison}
retour_eta_utj: ${retour_eta_utj}
vers_planete: ${vers_planete}
---

# Colonisation échouée — tick ${tick}

Cible : ${systeme}:${position}.
Cause : ${raisons[raison] || raison}.

Ta flotte fait demi-tour vers **${vers_planete}** (ETA ${retour_eta_utj} UTJ).
Le vaisseau_colon n'a pas été consommé.
`;
}
