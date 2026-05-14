// CITADEL // PROTOCOL — Résolveur de tick (logique iso, pas de fs).
// Importable Node ou navigateur.
//
// Exports :
//   - runTick({...}) → { newManifest, newEmpires, events, reports, eventsLog }
//   - yparse, ystringify, canonicalJSON, rngFromSeed, tickFromBlockHeight,
//     blockHeightForTick (re-exports depuis les modules dédiés, pour
//     préserver la compatibilité avec les imports existants).
//
// Le caller (CLI Node ou console browser) charge l'état, appelle runTick,
// puis persiste le résultat (fs ou IndexedDB).
//
// Découpage (v0.2 #2) :
//   - yaml-mini.mjs : yparse / ystringify
//   - rng.mjs       : rngFromSeed / canonicalJSON / sha256Hex
//   - time.mjs      : tickFromBlockHeight / blockHeightForTick
//   - reports.mjs   : helpers de rendu Markdown
// Les phases internes de runTick sont encore dans ce fichier sous forme de
// commentaires "// ─── Phase N ───" (cf ADR-0008 backlog) — extraction par
// phase à faire dans un prochain milestone.

import { queueColonisation, resolveColonisationArrivee } from './colonisation.mjs';
import { computeSealHash, validateSealedShape, validateRevealShape, SEALED_MAX_PATIENCE_TICKS } from './sealed-protocol.mjs';

import { yparse, ystringify } from './yaml-mini.mjs';
import { rngFromSeed, canonicalJSON, sha256Hex } from './rng.mjs';
import { tickFromBlockHeight, blockHeightForTick } from './time.mjs';
import {
  renderIntelReport, renderAlerteEspionnage, renderBattleReport, renderEmpireMd,
} from './reports.mjs';

// Re-exports : préserve la surface d'API publique de tick-core.
export { yparse, ystringify } from './yaml-mini.mjs';
export { rngFromSeed, canonicalJSON } from './rng.mjs';
export { tickFromBlockHeight, blockHeightForTick } from './time.mjs';

// ════════════════════════════════════════════════════════════════════════
// runTick — pure function
// ════════════════════════════════════════════════════════════════════════

/**
 * Exécute un tick.
 *
 * @param {object} params
 * @param {object} params.manifest             world/manifest.yaml parsé
 * @param {object} params.rules                engine/rules.yaml parsé
 * @param {object} params.galaxie              world/galaxie.yaml parsé
 * @param {Object<string, object>} params.empires       { player → empire }
 * @param {Object<string, object>} params.orders        { player → ordres }
 * @param {Object<string, string>} params.ordersRawText { player → yaml brut } (pour vérification sig)
 * @param {Object<string, object>} params.identites     { player → identite }
 * @param {object} params.combat               { resolveCombat, computeDebris, computePillage }
 * @param {function} [params.verifySignature]  async (yamlContent, pubKeyB64) → bool
 * @param {object}   [params.opts]
 * @param {boolean}  [params.opts.strict=false]
 * @param {function} [params.opts.log]         (msg) => void
 * @returns {Promise<{
 *   newManifest, newEmpires, events,
 *   reports: { intel, alerts, battles },  // [{ player, filename, content }] / [{ filename, content }]
 *   eventsLog: { filename, content } | null,
 *   empireFiles: [{ player, yaml, md }],
 * }>}
 */
export async function runTick({
  manifest, rules, galaxie,
  empires, orders, ordersRawText = {}, identites = {},
  sealedOrders = {}, revealOrders = [],
  combat, verifySignature = null, opts = {},
}) {
  const { resolveCombat, computeDebris, computePillage } = combat;
  const { strict = false, log = () => {} } = opts;

  const UTJ_PAR_TICK = rules.duree_utj_par_tick || 6;
  const tickSuivant = manifest.tick + 1;
  const rng = rngFromSeed(`${manifest.seed}:${tickSuivant}`);
  const events = [];
  const reports = { intel: [], alerts: [], battles: [] };

  // Table des sceaux en attente de reveal — persiste à travers les ticks via manifest.
  // Clé = sealed_txid (immutable). Valeur = { joueur, tick_depart, tick_impact,
  // planete_origine, kind, hash }.
  manifest.sealedPending = manifest.sealedPending || {};

  // Vitesse effective d'un vaisseau, en tenant compte des recherches.
  //   - drives_impulsion : +5%/niv pour les vaisseaux sub-FTL
  //   - drive_hyperspatial : +5%/niv pour les vaisseaux long-range (FTL)
  // Liste explicite des vaisseaux FTL (rules.yaml ne classifie pas par catégorie ;
  // ce sont les vaisseaux long-range qui requièrent drive_hyperspatial).
  const SHIPS_FTL = new Set(['cuirasse', 'vaisseau_colon', 'recycleur']);
  function shipSpeed(shipType, emp) {
    const base = rules.vaisseaux?.[shipType]?.vitesse || 1000;
    if (!emp) return base;
    const rech = emp.recherche || {};
    const ftl = SHIPS_FTL.has(shipType);
    const tech = ftl ? (rech.drive_hyperspatial || 0) : (rech.drives_impulsion || 0);
    return base * (1 + 0.05 * tech);
  }

  // ─── Phase 0 — Expiration des effets temporels (relations, moral, marché)
  // Avant la production, on nettoie : trêves échues passent à 'neutre',
  // malus moraux passés sont oubliés, ordres marché expirés sont
  // remboursés à la planète d'origine. Cela garantit que le tick courant
  // applique des effets cohérents.
  for (const emp of Object.values(empires)) {
    emp.relations = emp.relations || {};
    for (const [autre, rel] of Object.entries(emp.relations)) {
      if (rel.status !== 'neutre' && rel.expire_tick != null && rel.expire_tick <= tickSuivant) {
        emp.relations[autre] = { status: 'neutre', expire_tick: null };
      }
    }
  }

  // Order book galactique : structure persistante sur le manifest.
  // Clés normalisées en ordre alphabétique, e.g. 'ferrum-lumen'.
  manifest.marche = manifest.marche || { books: {} };
  const PAIRES_MARCHE = ['ferrum-lumen', 'ferrum-plasmide', 'lumen-plasmide'];
  for (const k of PAIRES_MARCHE) {
    manifest.marche.books[k] = manifest.marche.books[k] || [];
  }
  // Expirer + rembourser
  for (const k of PAIRES_MARCHE) {
    const restants = [];
    for (const ord of manifest.marche.books[k]) {
      if ((ord.expire_tick || 0) <= tickSuivant) {
        const emp = empires[ord.joueur];
        const planete = emp ? (emp.planetes || []).find(p => p.nom === ord.planete) : null;
        if (planete && planete.ressources?.[ord.vend]) {
          planete.ressources[ord.vend].stock = Math.min(
            (planete.ressources[ord.vend].stock || 0) + ord.qty_vend_restant,
            planete.ressources[ord.vend].capacite || Infinity,
          );
        }
        events.push({ type: 'marche-expire', joueur: ord.joueur, paire: k, qty_remboursee: ord.qty_vend_restant, ressource: ord.vend });
      } else {
        restants.push(ord);
      }
    }
    manifest.marche.books[k] = restants;
  }

  // ─── Phase 0.5 — Énergie (production, consommation, facteur production) ─
  // Production = somme(centrale_solaire + reacteur_fusion) par planète.
  // Consommation = somme(flotte_au_sol × conso_par_utj) + flottes en vol
  //                (attribuées à la planète d'origine).
  // Facteur production : si déficit, malus proportionnel sur prod ressources,
  // floor 50%. Si surplus ou égalité, facteur 1.0.
  for (const [, emp] of Object.entries(empires)) {
    const planetByName = {};
    for (const p of emp.planetes || []) planetByName[p.nom] = p;
    // Recherche `fusion_controlee` : +10%/niv sur la prod du reacteur_fusion
    // uniquement (centrale_solaire non affectée).
    const nivFusion = (emp.recherche || {}).fusion_controlee || 0;
    const factFusion = 1 + 0.10 * nivFusion;
    for (const planete of emp.planetes || []) {
      let prod = 0;
      for (const bat of ['centrale_solaire', 'reacteur_fusion']) {
        const niv = planete.batiments?.[bat] || 0;
        if (niv <= 0) continue;
        const base = rules.batiments?.[bat]?.production_base || 0;
        const mult = bat === 'reacteur_fusion' ? factFusion : 1.0;
        prod += Math.floor(base * niv * Math.pow(1.1, niv) * mult);
      }
      let cons = 0;
      for (const [ship, qty] of Object.entries(planete.flotte_au_sol || {})) {
        if (qty <= 0) continue;
        const u = rules.vaisseaux?.[ship]?.consommation_par_utj || 0;
        cons += u * qty;
      }
      planete.energie = { production: prod, consommation: cons, facteur_production: 1.0 };
    }
    for (const flt of emp.flottes_en_vol || []) {
      const orig = planetByName[flt.depuis?.planete];
      if (!orig?.energie) continue;
      let cons = 0;
      for (const [ship, qty] of Object.entries(flt.composition || {})) {
        if (qty <= 0) continue;
        const u = rules.vaisseaux?.[ship]?.consommation_par_utj || 0;
        cons += u * qty;
      }
      orig.energie.consommation += cons;
    }
    for (const planete of emp.planetes || []) {
      const e = planete.energie;
      if (e.consommation > e.production && e.consommation > 0) {
        const ratio = 1 - (e.consommation - e.production) / e.consommation;
        e.facteur_production = Math.max(0.5, ratio);
      }
    }
  }

  // ─── Phase 1 — Production ──────────────────────────────────────────────
  log(`▸ Phase 1/6 — Production de ressources (×${UTJ_PAR_TICK} UTJ)`);
  const utjParSingularite = rules.singularite?.utj_par_unite || 300;
  const capSingularite = rules.singularite?.cap_par_empire || 5;
  const capInfluence = rules.influence?.cap_par_empire || 10000;
  const malusMoralPct = (rules.diplomatie?.rupture?.malus_moral_pct || 15) / 100;
  for (const [name, emp] of Object.entries(empires)) {
    // Malus moral après rupture de trêve : production réduite tant que
    // tickSuivant ≤ malus_moral_jusqu_tick.
    const moralActif = (emp.malus_moral_jusqu_tick || 0) >= tickSuivant;
    const factMoral = moralActif ? (1 - malusMoralPct) : 1.0;
    for (const planete of emp.planetes || []) {
      const factEnergie = planete.energie?.facteur_production ?? 1.0;
      for (const info of Object.values(planete.ressources || {})) {
        const prod = (info.production_par_utj || 0) * UTJ_PAR_TICK * factMoral * factEnergie;
        info.stock = Math.min((info.stock || 0) + prod, info.capacite || Infinity);
      }
    }
    // Influence : produite par centre_diplomatique (0.5 × niv / UTJ).
    emp.ressources_globales = emp.ressources_globales || { singularite: 0, influence: 0 };
    // Recherche `doctrine_imperiale` : +0.2/niv ajouté au bonus d'influence
    // par niveau de centre_diplomatique (additif au 0.5 de base).
    const nivDoctrine = (emp.recherche || {}).doctrine_imperiale || 0;
    const cdBonus = 0.5 + 0.2 * nivDoctrine;
    let influenceParUtj = 0;
    for (const p of emp.planetes || []) {
      const nivCD = p.batiments?.centre_diplomatique || 0;
      if (nivCD > 0) influenceParUtj += cdBonus * nivCD;
    }
    if (influenceParUtj > 0) {
      const gain = influenceParUtj * UTJ_PAR_TICK;
      emp.ressources_globales.influence = Math.min(
        capInfluence,
        (emp.ressources_globales.influence || 0) + gain,
      );
    }
    // Singularité : produite passivement par chaque planète anomalie colonisée.
    // Le progrès est cumulé en UTJ ; chaque palier `utjParSingularite` consomme
    // le quota et incrémente la ressource empire (capée).
    emp.ressources_globales = emp.ressources_globales || { singularite: 0, influence: 0 };
    emp.progres_singularite_utj = emp.progres_singularite_utj || 0;
    const anomaliesColonisees = (emp.planetes || []).filter(p => {
      const def = rules.types_planete?.[p.type];
      return def?.produit_singularite;
    }).length;
    if (anomaliesColonisees > 0 && emp.ressources_globales.singularite < capSingularite) {
      emp.progres_singularite_utj += anomaliesColonisees * UTJ_PAR_TICK;
      while (emp.progres_singularite_utj >= utjParSingularite && emp.ressources_globales.singularite < capSingularite) {
        emp.progres_singularite_utj -= utjParSingularite;
        emp.ressources_globales.singularite += 1;
        events.push({ type: 'singularite-produite', joueur: name, total: emp.ressources_globales.singularite });
      }
      // Si le cap est atteint, on plafonne le progrès pour éviter l'accumulation
      // qui se libérerait d'un coup si une singularité était dépensée plus tard.
      if (emp.ressources_globales.singularite >= capSingularite) {
        emp.progres_singularite_utj = Math.min(emp.progres_singularite_utj, utjParSingularite - 1);
      }
    }
  }

  // ─── Phase 2 — Avancement chantiers / recherches / constructions ───────
  log(`▸ Phase 2/6 — Avancement chantiers, recherches & constructions`);
  for (const [name, emp] of Object.entries(empires)) {
    for (const planete of emp.planetes || []) {
      const file = planete.file_chantier || [];
      if (file.length > 0) {
        file[0].fin_utj = (file[0].fin_utj || 0) - UTJ_PAR_TICK;
        if (file[0].fin_utj <= 0) {
          const done = file.shift();
          planete.batiments[done.batiment] = done.niveau_cible;
          const prodMap = {
            mine_ferrum: 'ferrum',
            extracteur_lumen: 'lumen',
            synthetiseur_plasmide: 'plasmide',
          };
          if (prodMap[done.batiment]) {
            const res = prodMap[done.batiment];
            const def = rules.batiments[done.batiment];
            const niv = done.niveau_cible;
            const base = def.production_base || 30;
            const bonus = def.bonus_planete?.[planete.type] || 1.0;
            // Le synthétiseur de plasmide subit l'efficacité thermique de
            // l'étoile-hôte : `temp = temperature_k / 100` ∈ [50,70] →
            // multiplicateur (1.44 − 0.004·temp) ∈ [1.16, 1.24]. Étoiles
            // froides ≈ rendement supérieur (formule rules.yaml:40).
            let thermal = 1.0;
            if (done.batiment === 'synthetiseur_plasmide') {
              const [g, s] = planete.coordonnees || [];
              const tempK = galaxie?.systemes?.[`${g}:${s}`]?.etoile?.temperature_k ?? 6000;
              const temp = tempK / 100;
              thermal = Math.max(0.5, 1.44 - 0.004 * temp);
            }
            // Recherche `automation_miniere` : +10%/niv sur la production des
            // mines/extracteurs/synthétiseurs. Figé au moment de la complétion
            // du chantier (cohérent avec le design existant : production_par_utj
            // est snapshotté ici, pas recalculé chaque tick).
            const nivAutomation = (emp.recherche || {}).automation_miniere || 0;
            const factAutomation = 1 + 0.10 * nivAutomation;
            const prod = Math.floor(base * niv * Math.pow(1.1, niv) * bonus * thermal * factAutomation);
            if (planete.ressources?.[res]) {
              planete.ressources[res].production_par_utj = prod;
            }
          }
          // Dépôt : recompute la capacité de chaque ressource en fonction
          // du niveau et du bonus_planete (e.g. glacée +50%).
          if (done.batiment === 'depot') {
            const def = rules.batiments.depot || {};
            const base = def.capacite_base || 100000;
            const mult = def.capacite_multiplicateur || 1.6;
            const niv = done.niveau_cible;
            const bonus = def.bonus_planete?.[planete.type] || 1.0;
            const cap = Math.floor(base * Math.pow(mult, niv - 1) * bonus);
            for (const info of Object.values(planete.ressources || {})) {
              info.capacite = cap;
            }
          }
          events.push({ type: 'chantier-acheve', joueur: name, planete: planete.nom, batiment: done.batiment, niveau: done.niveau_cible });
        }
      }

      const fc = planete.file_construction || [];
      if (fc.length > 0) {
        fc[0].fin_utj = (fc[0].fin_utj || 0) - UTJ_PAR_TICK;
        if (fc[0].fin_utj <= 0) {
          const done = fc.shift();
          if (done.categorie === 'defense') {
            planete.defenses = planete.defenses || {};
            planete.defenses[done.unite] = (planete.defenses[done.unite] || 0) + done.quantite;
          } else {
            planete.flotte_au_sol = planete.flotte_au_sol || {};
            planete.flotte_au_sol[done.unite] = (planete.flotte_au_sol[done.unite] || 0) + done.quantite;
          }
          events.push({ type: 'construction-achevee', joueur: name, planete: planete.nom, unite: done.unite, quantite: done.quantite, categorie: done.categorie });
        }
      }
    }
    const fr = emp.file_recherche || [];
    if (fr.length > 0) {
      fr[0].fin_utj = (fr[0].fin_utj || 0) - UTJ_PAR_TICK;
      if (fr[0].fin_utj <= 0) {
        const done = fr.shift();
        emp.recherche = emp.recherche || {};
        emp.recherche[done.technologie] = done.niveau_cible;
        events.push({ type: 'recherche-achevee', joueur: name, technologie: done.technologie, niveau: done.niveau_cible });
      }
    }
  }

  // ─── Phase 2.5 — Résolution des reveals scellés (option B) ─────────────
  // Pour chaque reveal du tick courant : matche le sealed dans sealedPending,
  // vérifie le hash, et — si valide — enqueue une attaque avec impact immédiat
  // (arrivee_utj = UTJ_PAR_TICK → décrément Phase 4 → résolution Phase 5).
  //
  // Tri déterministe par sealed_txid pour garantir reproductibilité du replay
  // (l'ordre du scan parallèle n'est pas garanti).
  log(`▸ Phase 2.5/6 — Résolution des sceaux révélés`);
  const sortedReveals = [...revealOrders].sort((a, b) =>
    (a.parsed?.sealed_txid || '') < (b.parsed?.sealed_txid || '') ? -1 :
    (a.parsed?.sealed_txid || '') > (b.parsed?.sealed_txid || '') ? 1 : 0
  );
  for (const rev of sortedReveals) {
    const errR = validateRevealShape(rev.parsed);
    if (errR) { log(`  ✗ reveal ${rev.joueur}: ${errR}`); continue; }

    const sealed = manifest.sealedPending[rev.parsed.sealed_txid];
    if (!sealed) {
      log(`  ✗ reveal ${rev.joueur}: sealed_txid ${rev.parsed.sealed_txid.slice(0, 16)}… introuvable — IGNORÉ`);
      continue;
    }
    if (sealed.joueur !== rev.joueur) {
      log(`  ✗ reveal ${rev.joueur}: sceau appartient à ${sealed.joueur} — REJETÉ`);
      continue;
    }
    if (rev.parsed.tick_impact !== tickSuivant) {
      log(`  ✗ reveal ${rev.joueur}: reveal.tick_impact ${rev.parsed.tick_impact} ≠ tick courant ${tickSuivant} — IGNORÉ`);
      continue;
    }

    // Cœur du protocole : recalcul + comparaison stricte
    const computed = computeSealHash(rev.parsed.secret);
    if (computed !== sealed.hash) {
      log(`  ✗ reveal ${rev.joueur}: hash ${computed.slice(0, 12)}… ≠ sealed.hash ${sealed.hash.slice(0, 12)}… — REJETÉ (sceau consommé)`);
      delete manifest.sealedPending[rev.parsed.sealed_txid];
      events.push({ type: 'reveal-hash-mismatch', joueur: rev.joueur, sealed_txid: rev.parsed.sealed_txid });
      continue;
    }
    if (rev.parsed.secret.depuis !== sealed.planete_origine) {
      log(`  ✗ reveal ${rev.joueur}: depuis=${rev.parsed.secret.depuis} ≠ planete_origine=${sealed.planete_origine} — REJETÉ`);
      delete manifest.sealedPending[rev.parsed.sealed_txid];
      continue;
    }

    // Vérification physique : le tick_impact déclaré doit correspondre à
    // ceil(distance / vMin × 100) UTJ ÷ UTJ_PAR_TICK depuis tick_depart.
    // Empêche un joueur de révéler trop tôt ou trop tard sa flotte.
    const distance = computeDistance(rev.parsed.secret.depuis, rev.parsed.secret.cible.planete, rev.joueur);
    const empRev = empires[rev.joueur];
    const vMin = Math.min(
      ...Object.keys(rev.parsed.secret.flotte || {}).map(s => shipSpeed(s, empRev))
    );
    if (!Number.isFinite(vMin) || vMin <= 0) {
      log(`  ✗ reveal ${rev.joueur}: flotte vide ou vaisseaux inconnus — REJETÉ`);
      delete manifest.sealedPending[rev.parsed.sealed_txid];
      continue;
    }
    const flightUTJ = Math.max(1, Math.ceil(distance / vMin * 100));
    const flightTicks = Math.ceil(flightUTJ / UTJ_PAR_TICK);
    const expectedImpact = sealed.tick_depart + flightTicks;
    if (expectedImpact !== tickSuivant) {
      log(`  ✗ reveal ${rev.joueur}: tick_impact ${tickSuivant} ≠ tick_depart+flight ${expectedImpact} (distance=${distance}, vMin=${vMin}, flightTicks=${flightTicks}) — REJETÉ`);
      delete manifest.sealedPending[rev.parsed.sealed_txid];
      events.push({ type: 'reveal-timing-mismatch', joueur: rev.joueur, sealed_txid: rev.parsed.sealed_txid, expectedImpact, actualImpact: tickSuivant });
      continue;
    }

    // Match valide → enqueue attaque avec impact immédiat
    const emp = empires[rev.joueur];
    if (!emp) {
      log(`  ✗ reveal ${rev.joueur}: empire introuvable`);
      delete manifest.sealedPending[rev.parsed.sealed_txid];
      continue;
    }
    const action = {
      type: 'attaque',
      depuis: rev.parsed.secret.depuis,
      cible: rev.parsed.secret.cible,
      flotte: rev.parsed.secret.flotte,
    };
    const beforeLen = (emp.flottes_en_vol || []).length;
    queueAttaque(emp, action, rev.joueur);
    const afterLen = (emp.flottes_en_vol || []).length;
    if (afterLen > beforeLen) {
      // Force arrivée ce tick : décrément Phase 4 ramènera arrivee_utj à 0.
      const flt = emp.flottes_en_vol[afterLen - 1];
      flt.arrivee_utj = UTJ_PAR_TICK;
      flt.duree_aller_utj = UTJ_PAR_TICK;
      flt.scelle = true;
      events.push({
        type: 'reveal-resolu',
        joueur: rev.joueur,
        sealed_txid: rev.parsed.sealed_txid,
        cible: action.cible,
      });
      log(`  ⚔ ${rev.joueur}: reveal scellé → impact immédiat sur ${action.cible.joueur}/${action.cible.planete}`);
    } else {
      log(`  ✗ reveal ${rev.joueur}: queueAttaque a échoué (flotte/trêve/etc.) — sceau consommé sans effet`);
    }
    delete manifest.sealedPending[rev.parsed.sealed_txid];
  }

  // ─── Phase 3 — Validation des nouveaux ordres ──────────────────────────
  log(`▸ Phase 3/6 — Validation des nouveaux ordres`);
  for (const [name, ord] of Object.entries(orders)) {
    if (!ord || !ord.ordres) continue;

    const rawContent = ordersRawText[name] ?? '';
    const sigOk = verifySignature
      ? await checkSignature(name, rawContent, identites, verifySignature)
      : false;
    if (!sigOk) {
      if (strict) {
        log(`  ✗ ${name}: signature INVALIDE — ordres rejetés (mode strict)`);
        continue;
      } else {
        log(`  ⚠ ${name}: signature invalide ou absente — toléré (legacy)`);
      }
    }

    if (ord.tick_cible !== tickSuivant) {
      log(`  · ${name}: ordres pour tick ${ord.tick_cible}, courant = ${tickSuivant} — IGNORÉS`);
      continue;
    }
    for (const action of ord.ordres) applyOrder(name, action);
  }

  // ─── Phase 3.6 — Enregistrement des nouveaux sceaux ────────────────────
  // Les sealedOrders dont tick_depart === tickSuivant sont enregistrés dans
  // manifest.sealedPending. Le reveal correspondant devra être inscrit au
  // tick_impact pour matérialiser l'action.
  //
  // Tri par joueur ASC pour déterminisme (l'ordre d'insertion dans un objet
  // affecte canonicalJSON si on hashait l'état).
  log(`▸ Phase 3.6/6 — Enregistrement des nouveaux sceaux`);
  const sealedNames = Object.keys(sealedOrders).sort();
  for (const name of sealedNames) {
    const entry = sealedOrders[name];
    const errS = validateSealedShape(entry.parsed);
    if (errS) { log(`  ✗ sealed ${name}: ${errS}`); continue; }
    if (entry.parsed.tick_depart !== tickSuivant) {
      log(`  · sealed ${name}: tick_depart ${entry.parsed.tick_depart} ≠ ${tickSuivant} — IGNORÉ`);
      continue;
    }
    if (entry.parsed.joueur !== name) {
      log(`  ✗ sealed ${name}: joueur YAML '${entry.parsed.joueur}' ≠ identité '${name}' — REJETÉ`);
      continue;
    }
    const emp = empires[name];
    const src = (emp?.planetes || []).find(p => p.nom === entry.parsed.planete_origine);
    if (!src) {
      log(`  ✗ sealed ${name}: planete_origine '${entry.parsed.planete_origine}' introuvable — REJETÉ`);
      continue;
    }
    manifest.sealedPending[entry.txid] = {
      joueur: name,
      tick_depart: entry.parsed.tick_depart,
      planete_origine: entry.parsed.planete_origine,
      kind: entry.parsed.kind,
      hash: entry.parsed.hash,
    };
    events.push({
      type: 'sealed-enregistre',
      joueur: name,
      txid: entry.txid,
      tick_depart: entry.parsed.tick_depart,
    });
    log(`  🔒 ${name}: sceau ${entry.txid.slice(0, 12)}… enregistré au tick_depart ${entry.parsed.tick_depart}`);
  }

  // ─── Phase 3.7 — Forfait des sceaux non-révélés ────────────────────────
  // Un sceau expire si tickSuivant - tick_depart > SEALED_MAX_PATIENCE_TICKS,
  // càd que le joueur a eu le temps maximal possible (couvre toute la galaxie
  // au vaisseau le plus lent) sans publier de reveal. V1 : pas de coût.
  const sealedTxids = Object.keys(manifest.sealedPending).sort();
  for (const txid of sealedTxids) {
    const sealed = manifest.sealedPending[txid];
    if (tickSuivant - sealed.tick_depart > SEALED_MAX_PATIENCE_TICKS) {
      log(`  ⌧ ${sealed.joueur}: sceau ${txid.slice(0, 12)}… expiré (patience dépassée, ${tickSuivant - sealed.tick_depart} > ${SEALED_MAX_PATIENCE_TICKS} ticks)`);
      events.push({ type: 'sealed-forfait', joueur: sealed.joueur, txid, tick_depart: sealed.tick_depart });
      delete manifest.sealedPending[txid];
    }
  }

  function applyOrder(playerName, action) {
    const emp = empires[playerName];
    if (!emp) return;
    switch (action.type) {
      case 'chantier':     return queueChantier(emp, action);
      case 'recherche':    return queueRecherche(emp, action);
      case 'transport':    return queueTransport(emp, action, playerName);
      case 'attaque':      return queueAttaque(emp, action, playerName);
      case 'construction': return queueConstruction(emp, action, playerName);
      case 'espionnage':   return queueEspionnage(emp, action, playerName);
      case 'recyclage':    return queueRecyclage(emp, action, playerName);
      case 'diplomatie':   return queueDiplomatie(emp, action, playerName);
      case 'marche-poser': return queueMarchePoser(emp, action, playerName);
      case 'colonisation': return queueColonisation(emp, action, {
        galaxie, rules, manifest, log, playerName, tickSuivant, rng,
        computeDistanceToCoords,
      });
      default:
        log(`  · ${playerName}: type d'ordre non implémenté: ${action.type}`);
    }
  }

  function queueConstruction(emp, action, playerName) {
    const planete = (emp.planetes || []).find(p => p.nom === action.planete);
    if (!planete) return;
    const qty = parseInt(action.quantite, 10);
    if (!qty || qty <= 0) return;
    let def = rules.vaisseaux?.[action.unite];
    let categorie = 'vaisseau';
    if (!def) { def = rules.defenses?.[action.unite]; categorie = 'defense'; }
    if (!def) { log(`  · ${playerName}: unité inconnue: ${action.unite}`); return; }
    if (!checkRequiert(def.requiert, planete, emp, playerName, `construction ${action.unite}`)) return;

    if (categorie === 'defense' && def.max_par_planete) {
      const dejaLa = (planete.defenses || {})[action.unite] || 0;
      const enFile = (planete.file_construction || []).filter(c => c.unite === action.unite).reduce((a, c) => a + c.quantite, 0);
      if (dejaLa + enFile + qty > def.max_par_planete) {
        log(`  · ${playerName}: ${action.unite} max ${def.max_par_planete} par planète`);
        return;
      }
    }
    const cout = {};
    for (const [k, v] of Object.entries(def.cout || {})) cout[k] = v * qty;
    // Ressources empire (singularité, influence) : pool global, pas planétaire.
    const RESS_GLOBALES = new Set(['singularite', 'influence']);
    emp.ressources_globales = emp.ressources_globales || { singularite: 0, influence: 0 };
    for (const [k, v] of Object.entries(cout)) {
      const dispo = RESS_GLOBALES.has(k)
        ? (emp.ressources_globales[k] || 0)
        : (planete.ressources[k]?.stock || 0);
      if (dispo < v) {
        log(`  · ${playerName}: ressources insuffisantes pour ${qty}× ${action.unite} (manque ${k})`);
        return;
      }
    }
    for (const [k, v] of Object.entries(cout)) {
      if (RESS_GLOBALES.has(k)) emp.ressources_globales[k] -= v;
      else planete.ressources[k].stock -= v;
    }

    const niveauChantier = planete.batiments?.chantier_spatial || 0;
    const niveauUsine = planete.batiments?.usine_robotique || 0;
    const bonusUsine = rules.batiments?.usine_robotique?.bonus_vitesse_par_niveau ?? 0.10;
    const bonusChantier = rules.batiments?.chantier_spatial?.bonus_vitesse_par_niveau ?? 0.10;
    // Recherche `robotique` : +5%/niv sur la vitesse de construction (additive).
    const nivRobotique = (emp.recherche || {}).robotique || 0;
    const vitesse = 1 + bonusChantier * niveauChantier + bonusUsine * niveauUsine + 0.05 * nivRobotique;
    const dureeUTJ = Math.max(1, Math.ceil((def.duree_utj || 1) * qty / vitesse));

    planete.file_construction = planete.file_construction || [];
    planete.file_construction.push({ unite: action.unite, categorie, quantite: qty, fin_utj: dureeUTJ });
    log(`  ✓ ${playerName}: construction ${qty}× ${action.unite} sur ${action.planete} (${dureeUTJ} UTJ)`);
  }

  // Ordre `diplomatie {action: 'treve'|'rupture', vers: 'joueur', duree_ticks?}`.
  // Trêve unilatérale : empêche l'émetteur d'attaquer la cible le temps voulu.
  // Rupture : annule la trêve immédiatement et applique un malus moral à
  // l'empire émetteur (production réduite N ticks).
  function queueDiplomatie(emp, action, playerName) {
    const cible = action.vers;
    if (!cible || typeof cible !== 'string') {
      log(`  · ${playerName}: diplomatie sans cible {vers: 'joueur'}`);
      return;
    }
    if (cible === playerName) { log(`  · ${playerName}: diplomatie vers soi-même rejetée`); return; }
    if (!empires[cible]) { log(`  · ${playerName}: diplomatie vers joueur inconnu ${cible}`); return; }

    const conf = rules.diplomatie || {};
    emp.relations = emp.relations || {};
    emp.ressources_globales = emp.ressources_globales || { singularite: 0, influence: 0 };

    if (action.action === 'treve') {
      const niv = (emp.recherche || {}).diplomatie || 0;
      const reqNiv = conf.treve?.requiert_recherche?.diplomatie || 1;
      if (niv < reqNiv) {
        log(`  · ${playerName}: trêve requiert recherche diplomatie ≥ ${reqNiv} (actuel ${niv})`);
        return;
      }
      const coutBase = conf.treve?.cout_influence || 100;
      const reduc = Math.min(0.5, niv * (conf.diplomatie_reduction_par_niveau || 0));
      const cout = Math.ceil(coutBase * (1 - reduc));
      if ((emp.ressources_globales.influence || 0) < cout) {
        log(`  · ${playerName}: influence insuffisante pour trêve (${cout} requis, ${Math.floor(emp.ressources_globales.influence || 0)} dispo)`);
        return;
      }
      const duree = parseInt(action.duree_ticks, 10) || conf.treve?.duree_ticks || 6;
      emp.ressources_globales.influence -= cout;
      emp.relations[cible] = { status: 'treve', expire_tick: tickSuivant + duree };
      events.push({ type: 'treve-declaree', joueur: playerName, vers: cible, expire_tick: tickSuivant + duree, cout });
      log(`  🕊 ${playerName}: trêve avec ${cible} jusqu'au tick ${tickSuivant + duree} (−${cout} influence)`);
      return;
    }

    if (action.action === 'rupture') {
      const rel = emp.relations[cible];
      if (!rel || rel.status === 'neutre') {
        log(`  · ${playerName}: rupture sans trêve active avec ${cible}`);
        return;
      }
      const malusDuree = conf.rupture?.malus_duree_ticks || 6;
      emp.relations[cible] = { status: 'neutre', expire_tick: null };
      emp.malus_moral_jusqu_tick = tickSuivant + malusDuree;
      events.push({ type: 'treve-rompue', joueur: playerName, vers: cible, malus_jusqu: tickSuivant + malusDuree });
      log(`  ⚡ ${playerName}: rupture trêve avec ${cible} — malus moral ${malusDuree} ticks`);
      return;
    }

    log(`  · ${playerName}: action diplomatie inconnue: ${action.action}`);
  }

  // Ordre `marche-poser {depuis: 'planete', vend: {ferrum: 5000}, demande: {lumen: 2500}, expire_dans_ticks?: 12}`.
  // Réserve immédiatement la quantité vendue sur la planète d'origine ;
  // l'ordre rejoint le book de sa paire (clé alphabétique). Les matchs
  // ont lieu en Phase 3.5 (tous les ordres du tick sont posés avant).
  function queueMarchePoser(emp, action, playerName) {
    const RESS_VALIDES = new Set(['ferrum', 'lumen', 'plasmide']);
    const planete = (emp.planetes || []).find(p => p.nom === action.depuis);
    if (!planete) { log(`  · ${playerName}: marché — planète inconnue ${action.depuis}`); return; }
    const vendEntries = Object.entries(action.vend || {});
    const demEntries = Object.entries(action.demande || {});
    if (vendEntries.length !== 1 || demEntries.length !== 1) {
      log(`  · ${playerName}: marché — vend/demande doivent contenir exactement une ressource`);
      return;
    }
    const [vendRes, vendQtyRaw] = vendEntries[0];
    const [demRes, demQtyRaw] = demEntries[0];
    const vendQty = parseInt(vendQtyRaw, 10);
    const demQty = parseInt(demQtyRaw, 10);
    if (!RESS_VALIDES.has(vendRes) || !RESS_VALIDES.has(demRes) || vendRes === demRes) {
      log(`  · ${playerName}: marché — paire de ressources invalide (${vendRes}→${demRes})`);
      return;
    }
    if (!vendQty || vendQty <= 0 || !demQty || demQty <= 0) {
      log(`  · ${playerName}: marché — quantités invalides`);
      return;
    }
    if ((planete.ressources?.[vendRes]?.stock || 0) < vendQty) {
      log(`  · ${playerName}: marché — stock insuffisant (${vendRes} ${vendQty} requis)`);
      return;
    }
    const expireMax = rules.marche?.expire_ticks_max || 48;
    const expireDef = rules.marche?.expire_ticks_default || 12;
    const expDans = Math.min(expireMax, Math.max(1, parseInt(action.expire_dans_ticks, 10) || expireDef));
    // Réservation : on retire de la planète, on remettra au match ou à
    // l'expiration.
    planete.ressources[vendRes].stock -= vendQty;

    const paire = [vendRes, demRes].sort().join('-');
    manifest.marche = manifest.marche || { books: {} };
    manifest.marche.books[paire] = manifest.marche.books[paire] || [];
    const ordreId = `mkt-${tickSuivant}-${rng().toString(36).slice(2, 8)}`;
    manifest.marche.books[paire].push({
      id: ordreId,
      joueur: playerName,
      planete: action.depuis,
      vend: vendRes,
      qty_vend: vendQty,            // initial
      qty_vend_restant: vendQty,    // décrémenté par match
      demande: demRes,
      qty_demande: demQty,          // initial
      qty_demande_restant: demQty,
      tick_pose: tickSuivant,
      expire_tick: tickSuivant + expDans,
    });
    log(`  💱 ${playerName}: marché ${vendQty} ${vendRes} → ${demQty} ${demRes} (paire ${paire}, expire t+${expDans})`);
  }

  function queueEspionnage(emp, action, playerName) {
    const src = (emp.planetes || []).find(p => p.nom === action.depuis);
    if (!src) return;
    const cible = action.cible || {};
    if (!cible.joueur || !cible.planete) { log(`  · ${playerName}: espionnage sans cible {joueur, planete}`); return; }
    const n = parseInt(action.nombre_sondes, 10);
    if (!n || n <= 0) return;
    if ((src.flotte_au_sol?.sonde || 0) < n) {
      log(`  · ${playerName}: pas assez de sondes (${src.flotte_au_sol?.sonde || 0} dispo, ${n} demandées)`);
      return;
    }
    src.flotte_au_sol.sonde -= n;

    const distance = computeDistance(action.depuis, cible.planete, playerName);
    const vitesse = shipSpeed('sonde', emp);
    const dureeUTJ = Math.max(1, Math.ceil(distance / vitesse * 100));

    emp.flottes_en_vol = emp.flottes_en_vol || [];
    emp.flottes_en_vol.push({
      id: `flt-${tickSuivant}-${rng().toString(36).slice(2, 6)}`,
      type_mission: 'espionnage',
      depuis: { joueur: playerName, planete: action.depuis },
      vers: cible,
      arrivee_utj: dureeUTJ,
      duree_aller_utj: dureeUTJ,
      composition: { sonde: n },
      cargaison: {},
    });
    log(`  👁 ${playerName}: espionnage ${action.depuis} → ${cible.joueur}/${cible.planete} (${n} sondes, ${dureeUTJ} UTJ)`);
  }

  function queueAttaque(emp, action, playerName) {
    const src = (emp.planetes || []).find(p => p.nom === action.depuis);
    if (!src) return;
    const cible = action.cible || {};
    if (!cible.joueur || !cible.planete) { log(`  · ${playerName}: attaque sans cible {joueur, planete}`); return; }
    // Trêve unilatérale : si l'attaquant a déclaré une trêve avec la cible,
    // l'ordre est rejeté tant qu'elle est active. Pour attaquer, il faut
    // d'abord poser un ordre `rupture` (qui déclenche le malus moral).
    const rel = emp.relations?.[cible.joueur];
    if (rel && rel.status === 'treve' && (rel.expire_tick || 0) > tickSuivant) {
      log(`  · ${playerName}: attaque rejetée — trêve active avec ${cible.joueur} jusqu'au tick ${rel.expire_tick}`);
      return;
    }
    for (const [ship, n] of Object.entries(action.flotte || {})) {
      if ((src.flotte_au_sol[ship] || 0) < n) { log(`  · ${playerName}: flotte insuffisante (${ship}) pour attaque depuis ${action.depuis}`); return; }
    }
    for (const [ship, n] of Object.entries(action.flotte || {})) src.flotte_au_sol[ship] -= n;

    const distance = computeDistance(action.depuis, cible.planete, playerName);
    const vMin = Math.min(...Object.keys(action.flotte || {}).map(s => shipSpeed(s, emp)));
    const dureeUTJ = Math.max(1, Math.ceil(distance / vMin * 100));

    emp.flottes_en_vol = emp.flottes_en_vol || [];
    emp.flottes_en_vol.push({
      id: `flt-${tickSuivant}-${rng().toString(36).slice(2, 6)}`,
      type_mission: 'attaque',
      depuis: { joueur: playerName, planete: action.depuis },
      vers: cible,
      arrivee_utj: dureeUTJ,
      duree_aller_utj: dureeUTJ,
      composition: action.flotte,
      cargaison: {},
    });
    log(`  ⚔ ${playerName}: attaque ${action.depuis} → ${cible.joueur}/${cible.planete} (${dureeUTJ} UTJ)`);
  }

  function checkRequiert(req, planete, emp, playerName, what) {
    if (!req) return true;
    const missing = [];
    for (const [k, v] of Object.entries(req)) {
      const isBat = !!rules.batiments?.[k];
      const isRech = !!rules.recherches?.[k];
      let level = 0;
      if (isBat) {
        level = planete
          ? (planete.batiments?.[k] || 0)
          : Math.max(0, ...(emp.planetes || []).map(p => p.batiments?.[k] || 0));
      } else if (isRech) {
        level = emp.recherche?.[k] || 0;
      }
      if (level < v) missing.push(`${k} niv ${v} (a niv ${level})`);
    }
    if (missing.length) { log(`  · ${playerName}: ${what} requiert ${missing.join(', ')}`); return false; }
    return true;
  }

  function queueChantier(emp, action) {
    const planete = (emp.planetes || []).find(p => p.nom === action.planete);
    if (!planete) return;
    const niveauActuel = planete.batiments[action.batiment] || 0;
    if (action.niveau_cible !== niveauActuel + 1) return;
    const def = rules.batiments[action.batiment];
    if (!def) return;
    if (!checkRequiert(def.requiert, planete, emp, emp.joueur, `chantier ${action.batiment}`)) return;

    const mult = Math.pow(def.multiplicateur_cout, niveauActuel);
    const cout = {};
    for (const [k, v] of Object.entries(def.cout_base || {})) cout[k] = Math.floor(v * mult);
    for (const [k, v] of Object.entries(cout)) {
      if ((planete.ressources[k]?.stock || 0) < v) { log(`  · ${emp.joueur}: ressources insuffisantes pour ${action.batiment} ${action.niveau_cible}`); return; }
    }
    for (const [k, v] of Object.entries(cout)) planete.ressources[k].stock -= v;

    // Vitesse accélérée par usine_robotique (cohérent avec rules.yaml:83
    // "accélère les chantiers de bâtiments"). Formule symétrique de celle
    // appliquée aux vaisseaux (tick-core.mjs:738).
    const bonusUsineBat = rules.batiments?.usine_robotique?.bonus_vitesse_par_niveau ?? 0;
    const niveauUsineBat = planete.batiments?.usine_robotique || 0;
    // Recherche `robotique` : +5%/niv sur la vitesse de chantier (additive).
    const nivRobotiqueBat = (emp.recherche || {}).robotique || 0;
    const vitesseBat = 1 + bonusUsineBat * niveauUsineBat + 0.05 * nivRobotiqueBat;
    const dureeUTJ = ((def.duree_base_utj || 1) * Math.pow(def.multiplicateur_duree || 1.5, niveauActuel)) / vitesseBat;
    planete.file_chantier = planete.file_chantier || [];
    planete.file_chantier.push({ batiment: action.batiment, niveau_cible: action.niveau_cible, fin_utj: Math.ceil(dureeUTJ) });
    log(`  ✓ ${emp.joueur}: chantier ${action.batiment} → ${action.niveau_cible} (${Math.ceil(dureeUTJ)} UTJ)`);
  }

  function queueRecherche(emp, action) {
    const def = rules.recherches[action.technologie];
    if (!def) return;
    const niveauActuel = (emp.recherche || {})[action.technologie] || 0;
    if (action.niveau_cible !== niveauActuel + 1) return;
    if (!checkRequiert(def.requiert, null, emp, emp.joueur, `recherche ${action.technologie}`)) return;
    const mult = Math.pow(def.mult || 2.0, niveauActuel);
    const cout = {};
    for (const [k, v] of Object.entries(def.cout_base || {})) cout[k] = Math.floor(v * mult);
    let payer = (emp.planetes || []).find(p => Object.entries(cout).every(([k, v]) => (p.ressources[k]?.stock || 0) >= v));
    if (!payer) { log(`  · ${emp.joueur}: aucune planète ne peut payer recherche ${action.technologie}`); return; }
    for (const [k, v] of Object.entries(cout)) payer.ressources[k].stock -= v;
    // Vitesse de recherche = 1 + Σ (0.10 × niv_labo × bonus_planete[laboratoire]).
    // Une anomalie multiplie la contribution de son labo par 1.30.
    let vitesseRecherche = 1.0;
    for (const p of emp.planetes || []) {
      const niv = p.batiments?.laboratoire || 0;
      if (niv > 0) {
        const planetMult = rules.types_planete?.[p.type]?.bonus?.laboratoire || 1.0;
        vitesseRecherche += 0.10 * niv * planetMult;
      }
    }
    const dureeBase = (def.duree_base || 1) * Math.pow(2, niveauActuel);
    const duree = dureeBase / vitesseRecherche;
    emp.file_recherche = emp.file_recherche || [];
    emp.file_recherche.push({ technologie: action.technologie, niveau_cible: action.niveau_cible, fin_utj: Math.ceil(duree) });
    log(`  ✓ ${emp.joueur}: recherche ${action.technologie} → ${action.niveau_cible} (${Math.ceil(duree)} UTJ)`);
  }

  function queueTransport(emp, action, playerName) {
    const src = (emp.planetes || []).find(p => p.nom === action.depuis);
    if (!src) return;
    const cible = action.cible
      || (typeof action.vers === 'object' ? action.vers : null)
      || (typeof action.vers === 'string' ? { joueur: playerName, planete: action.vers } : null);
    if (!cible || !cible.planete) { log(`  · ${playerName}: transport sans cible valide`); return; }
    const cibleJoueur = cible.joueur || playerName;
    const ciblePlanete = cible.planete;

    for (const [ship, n] of Object.entries(action.flotte || {})) {
      if ((src.flotte_au_sol[ship] || 0) < n) { log(`  · ${playerName}: flotte insuffisante (${ship}) pour transport`); return; }
    }
    for (const [res, n] of Object.entries(action.cargaison || {})) {
      if ((src.ressources[res]?.stock || 0) < n) { log(`  · ${playerName}: cargaison ${res} insuffisante`); return; }
    }
    for (const [ship, n] of Object.entries(action.flotte || {})) src.flotte_au_sol[ship] -= n;
    for (const [res, n] of Object.entries(action.cargaison || {})) src.ressources[res].stock -= n;

    const distance = computeDistance(action.depuis, ciblePlanete, playerName);
    const vMin = Math.min(...Object.keys(action.flotte || {}).map(s => shipSpeed(s, emp)));
    const dureeUTJ = Math.max(1, Math.ceil(distance / vMin * 100));

    emp.flottes_en_vol = emp.flottes_en_vol || [];
    emp.flottes_en_vol.push({
      id: `flt-${tickSuivant}-${rng().toString(36).slice(2, 6)}`,
      type_mission: 'transport',
      depuis: { joueur: playerName, planete: action.depuis },
      vers: { joueur: cibleJoueur, planete: ciblePlanete },
      arrivee_utj: dureeUTJ,
      composition: action.flotte,
      cargaison: action.cargaison || {},
    });
    log(`  ✓ ${playerName}: transport ${action.depuis} → ${cibleJoueur}/${ciblePlanete} (${dureeUTJ} UTJ)`);
  }

  function queueRecyclage(emp, action, playerName) {
    const src = (emp.planetes || []).find(p => p.nom === action.depuis);
    if (!src) return;
    const cible = action.cible || {};
    const cibleJoueur = cible.joueur || playerName;
    const ciblePlanete = cible.planete;
    if (!ciblePlanete) { log(`  · ${playerName}: recyclage sans cible valide`); return; }
    if (cibleJoueur !== playerName) { log(`  · ${playerName}: recyclage sur planète d'autrui non autorisé (v1)`); return; }
    const dst = (emp.planetes || []).find(p => p.nom === ciblePlanete);
    const debris = dst?.champ_debris;
    const totalDebris = (debris?.ferrum || 0) + (debris?.lumen || 0);
    if (!totalDebris) { log(`  · ${playerName}: aucun débris à récupérer sur ${ciblePlanete}`); return; }
    const recycleurs = (action.flotte || {}).recycleur || 0;
    if (recycleurs <= 0) { log(`  · ${playerName}: recyclage requiert au moins 1 recycleur`); return; }
    if ((src.flotte_au_sol.recycleur || 0) < recycleurs) { log(`  · ${playerName}: pas assez de recycleurs disponibles sur ${action.depuis}`); return; }
    src.flotte_au_sol.recycleur -= recycleurs;

    const distance = computeDistance(action.depuis, ciblePlanete, playerName);
    const vitesse = shipSpeed('recycleur', emp);
    const dureeUTJ = Math.max(1, Math.ceil(distance / vitesse * 100));

    emp.flottes_en_vol = emp.flottes_en_vol || [];
    emp.flottes_en_vol.push({
      id: `flt-${tickSuivant}-${rng().toString(36).slice(2, 6)}`,
      type_mission: 'recyclage',
      depuis: { joueur: playerName, planete: action.depuis },
      vers: { joueur: cibleJoueur, planete: ciblePlanete },
      arrivee_utj: dureeUTJ,
      duree_aller_utj: dureeUTJ,
      composition: { recycleur: recycleurs },
      cargaison: {},
    });
    log(`  ♻ ${playerName}: recyclage ${action.depuis} → ${ciblePlanete} (${recycleurs} recycleurs, ${dureeUTJ} UTJ)`);
  }

  function computeDistance(from, to, playerName) {
    const emp = empires[playerName];
    const src = emp.planetes.find(p => p.nom === from);
    let dst;
    for (const e of Object.values(empires)) {
      dst = (e.planetes || []).find(p => p.nom === to);
      if (dst) break;
    }
    if (!src || !dst) return 100;
    return computeDistanceFromCoords(src.coordonnees, dst.coordonnees);
  }

  // Distance entre deux paires de coordonnées brutes [g, s, p].
  // Partagée par computeDistance (planète→planète) et computeDistanceToCoords
  // (planète→case inhabitée, utilisé par la colonisation).
  function computeDistanceFromCoords([g1, s1, p1], [g2, s2, p2]) {
    if (g1 !== g2) return 20000 + Math.abs(g1 - g2) * 5000;
    if (s1 !== s2) return 2700 + Math.abs(s1 - s2) * 95;
    return 1000 + Math.abs(p1 - p2) * 5;
  }

  // Distance depuis une planète possédée vers des coordonnées arbitraires
  // (typiquement une case galaxie inhabitée). Renvoie 100 (fallback court)
  // si la planète source est introuvable, comportement aligné sur
  // computeDistance pour ne pas surprendre les call-sites existants.
  function computeDistanceToCoords(fromName, dstCoords, playerName) {
    const emp = empires[playerName];
    const src = emp?.planetes?.find(p => p.nom === fromName);
    if (!src || !Array.isArray(dstCoords) || dstCoords.length !== 3) return 100;
    return computeDistanceFromCoords(src.coordonnees, dstCoords);
  }

  // ─── Phase 3.5 — Matching marché galactique ────────────────────────────
  // Pour chaque paire, on apparie les ordres compatibles : un ordre A→B
  // (vend A, demande B) match un ordre B→A (vend B, demande A) si le ratio
  // proposé par le vendeur est plus avantageux ou égal à celui de
  // l'acheteur. FIFO : tri par tick_pose ASC à prix égal, prix exécuté =
  // ratio de l'ordre le plus ancien (le "taker" prend le prix posté).
  log(`▸ Phase 3.5/6 — Matching marché galactique`);
  const feeBase = rules.marche?.fee_base || 0.05;
  const feeReduc = rules.marche?.fee_reduction_par_terminal || 0.05;
  const empTerminalLevel = (joueur) => {
    const e = empires[joueur];
    if (!e) return 0;
    let max = 0;
    for (const p of e.planetes || []) max = Math.max(max, p.batiments?.terminal_marchand || 0);
    return max;
  };
  const livrer = (joueur, planeteNom, ressource, qty) => {
    const e = empires[joueur];
    if (!e) return;
    const p = (e.planetes || []).find(pl => pl.nom === planeteNom)
           || (e.planetes || [])[0]; // fallback : première planète si la planète d'origine n'existe plus
    if (!p?.ressources?.[ressource]) return;
    p.ressources[ressource].stock = Math.min(
      (p.ressources[ressource].stock || 0) + qty,
      p.ressources[ressource].capacite || Infinity,
    );
  };
  for (const paire of PAIRES_MARCHE) {
    const [resA, resB] = paire.split('-');
    const book = manifest.marche.books[paire] || [];
    // Pour cette paire, on définit "ordres-A" = ordres qui vendent A (et
    // demandent B), ordres-B = ordres qui vendent B (et demandent A).
    // Prix unitaire en B par A pour un ordre-A : qty_demande_B / qty_vend_A.
    // Prix unitaire en B par A pour un ordre-B (côté payer A) :
    //   qty_vend_B / qty_demande_A (combien de B le buyer paie par A reçu).
    // Match si bestSell.prix ≤ bestBuy.prix.
    const sellsA = book.filter(o => o.vend === resA && o.qty_vend_restant > 0);
    const sellsB = book.filter(o => o.vend === resB && o.qty_vend_restant > 0);
    sellsA.sort((x, y) =>
      (x.qty_demande / x.qty_vend) - (y.qty_demande / y.qty_vend) ||
      (x.tick_pose - y.tick_pose) ||
      (x.id < y.id ? -1 : 1)
    );
    sellsB.sort((x, y) =>
      (y.qty_vend / y.qty_demande) - (x.qty_vend / x.qty_demande) ||
      (x.tick_pose - y.tick_pose) ||
      (x.id < y.id ? -1 : 1)
    );

    let i = 0, j = 0;
    while (i < sellsA.length && j < sellsB.length) {
      const sa = sellsA[i], sb = sellsB[j];
      const prixA_demande = sa.qty_demande / sa.qty_vend;       // B per A demandé par le vendeur de A
      const prixA_offert = sb.qty_vend / sb.qty_demande;        // B per A offert par l'acheteur de A
      if (prixA_demande > prixA_offert + 1e-9) break; // best sell > best buy → plus aucun match possible

      // Prix exécuté = ordre le plus ancien (taker prend le prix maker).
      const prixExec = (sa.tick_pose <= sb.tick_pose) ? prixA_demande : prixA_offert;

      // Quantité matchée en A : min(stock A restant côté vendeur, demande A
      // restante côté acheteur).
      const qtyA = Math.min(sa.qty_vend_restant, sb.qty_demande_restant);
      if (qtyA <= 0) { if (sa.qty_vend_restant <= 0) i++; if (sb.qty_demande_restant <= 0) j++; continue; }
      const qtyB = Math.floor(qtyA * prixExec);
      if (qtyB <= 0) { i++; continue; }
      // L'acheteur de A avait réservé qty_vend_B = qty_demande_B selon son
      // propre prix. Il consomme qtyB de sa réserve. S'il avait posté un
      // prix supérieur (plus généreux), le delta lui est remboursé.
      const qtyB_reserve_consommee = Math.min(sb.qty_vend_restant, qtyB);
      const sb_prix_pose = sb.qty_vend / sb.qty_demande;
      const sb_devait_payer_a_son_prix = Math.floor(qtyA * sb_prix_pose);
      const refundB = Math.max(0, sb_devait_payer_a_son_prix - qtyB_reserve_consommee);

      // Fees : prélevées sur la quantité reçue par chaque partie. Réduites
      // par le terminal_marchand max de chaque empire.
      const feeA = Math.max(0, feeBase * (1 - feeReduc * empTerminalLevel(sb.joueur))); // l'acheteur de A paie sa fee
      const feeB = Math.max(0, feeBase * (1 - feeReduc * empTerminalLevel(sa.joueur))); // le vendeur de A paie sa fee
      const livresA = Math.floor(qtyA * (1 - feeA));
      const livresB = Math.floor(qtyB_reserve_consommee * (1 - feeB));

      // Livraison : A va à l'acheteur (sb.joueur, sb.planete), B va au
      // vendeur (sa.joueur, sa.planete). Refund B retour à l'acheteur.
      livrer(sb.joueur, sb.planete, resA, livresA);
      livrer(sa.joueur, sa.planete, resB, livresB);
      if (refundB > 0) livrer(sb.joueur, sb.planete, resB, refundB);

      sa.qty_vend_restant -= qtyA;
      sa.qty_demande_restant = Math.max(0, sa.qty_demande_restant - qtyB_reserve_consommee);
      sb.qty_vend_restant = Math.max(0, sb.qty_vend_restant - qtyB_reserve_consommee);
      sb.qty_demande_restant -= qtyA;

      events.push({
        type: 'marche-match', paire,
        vendeur: sa.joueur, acheteur: sb.joueur,
        qty_a: qtyA, ressource_a: resA, qty_b: qtyB_reserve_consommee, ressource_b: resB,
        prix_exec: prixExec, fees: { a: feeA, b: feeB },
      });

      if (sa.qty_vend_restant <= 0) i++;
      if (sb.qty_vend_restant <= 0 || sb.qty_demande_restant <= 0) j++;
    }
    // Compacter le book : retirer les ordres totalement remplis.
    manifest.marche.books[paire] = book.filter(o => o.qty_vend_restant > 0 && o.qty_demande_restant > 0);
  }

  // ─── Phase 4 — Mouvements de flotte ─────────────────────────────────────
  log(`▸ Phase 4/6 — Mouvements de flotte (avancement)`);
  const arrivees = [];
  for (const [name, emp] of Object.entries(empires)) {
    const restantes = [];
    for (const flt of emp.flottes_en_vol || []) {
      flt.arrivee_utj -= UTJ_PAR_TICK;
      if (flt.arrivee_utj <= 0) arrivees.push({ proprietaire: name, flotte: flt });
      else restantes.push(flt);
    }
    emp.flottes_en_vol = restantes;
  }

  for (const arr of arrivees.filter(a => a.flotte.type_mission === 'transport' || a.flotte.type_mission === 'retour')) {
    const flt = arr.flotte;
    const versPlanete = flt.vers.planete || flt.vers;
    const versJoueur = flt.vers.joueur || arr.proprietaire;
    const dst = (empires[versJoueur]?.planetes || []).find(p => p.nom === versPlanete);
    if (!dst) { log(`  · flotte ${flt.id}: destination ${versJoueur}/${versPlanete} introuvable`); continue; }
    dst.flotte_au_sol = dst.flotte_au_sol || {};
    dst.ressources = dst.ressources || {};
    for (const [res, n] of Object.entries(flt.cargaison || {})) {
      if (!dst.ressources[res]) continue;
      dst.ressources[res].stock = (dst.ressources[res].stock || 0) + n;
    }
    for (const [ship, n] of Object.entries(flt.composition || {})) {
      dst.flotte_au_sol[ship] = (dst.flotte_au_sol[ship] || 0) + n;
    }
    events.push({
      type: flt.type_mission === 'retour' ? 'flotte-retour' : 'transport-livre',
      joueur: arr.proprietaire,
      de: flt.depuis.planete,
      vers: versPlanete,
      cargaison: flt.cargaison,
    });
  }

  const CARGO_RECYCLEUR = rules.vaisseaux.recycleur?.cargo || 20000;
  for (const arr of arrivees.filter(a => a.flotte.type_mission === 'recyclage')) {
    const flt = arr.flotte;
    const dst = (empires[flt.vers.joueur]?.planetes || []).find(p => p.nom === flt.vers.planete);
    if (!dst) { log(`  · flotte ${flt.id}: planète cible ${flt.vers.planete} introuvable`); continue; }
    const debris = dst.champ_debris || { ferrum: 0, lumen: 0 };
    const cargoTotal = (flt.composition.recycleur || 0) * CARGO_RECYCLEUR;
    const totalDebris = (debris.ferrum || 0) + (debris.lumen || 0);
    let pris = { ferrum: 0, lumen: 0 };
    if (totalDebris > 0 && cargoTotal > 0) {
      if (totalDebris <= cargoTotal) {
        pris.ferrum = debris.ferrum || 0;
        pris.lumen  = debris.lumen  || 0;
      } else {
        const ratio = cargoTotal / totalDebris;
        pris.ferrum = Math.floor((debris.ferrum || 0) * ratio);
        pris.lumen  = Math.floor((debris.lumen  || 0) * ratio);
      }
      debris.ferrum -= pris.ferrum;
      debris.lumen  -= pris.lumen;
      dst.champ_debris = debris;
    }
    const empProp = empires[arr.proprietaire];
    empProp.flottes_en_vol = empProp.flottes_en_vol || [];
    empProp.flottes_en_vol.push({
      id: `flt-${tickSuivant}-${rng().toString(36).slice(2, 6)}`,
      type_mission: 'retour',
      depuis: flt.vers,
      vers: flt.depuis,
      arrivee_utj: flt.duree_aller_utj || flt.arrivee_utj || 1,
      composition: flt.composition,
      cargaison: pris,
    });
    events.push({ type: 'recyclage-livre', joueur: arr.proprietaire, planete: flt.vers.planete, cargaison: pris, debris_restants: { ...debris } });
    log(`  ♻ ${arr.proprietaire}: recyclage sur ${flt.vers.planete} → ferrum=${pris.ferrum} lumen=${pris.lumen}`);
  }

  // Colonisations : tie-break déterministe (joueur ASC, id ASC). Le premier
  // de la liste qui résout sur une case libre la verrouille ; les suivants
  // arrivant sur la même cible ce tick verront proprietaire != null et
  // échoueront en retour automatique.
  const arrCol = arrivees
    .filter(a => a.flotte.type_mission === 'colonisation')
    .sort((x, y) =>
      (x.proprietaire < y.proprietaire ? -1 : x.proprietaire > y.proprietaire ? 1 : 0) ||
      (x.flotte.id < y.flotte.id ? -1 : x.flotte.id > y.flotte.id ? 1 : 0)
    );
  for (const arr of arrCol) {
    resolveColonisationArrivee(arr, {
      galaxie, manifest, empires, log, events, reports, rng, tickSuivant,
    });
  }

  // ─── Phase 5 — Combats & espionnage ─────────────────────────────────────
  log(`▸ Phase 5/6 — Combats & espionnage`);
  const arrAttaques = arrivees.filter(a => a.flotte.type_mission === 'attaque');
  const arrEspionnages = arrivees.filter(a => a.flotte.type_mission === 'espionnage');
  if (arrAttaques.length === 0 && arrEspionnages.length === 0) {
    log(`  (aucune action militaire ne se résout ce tick)`);
  }
  for (const arr of arrEspionnages) resolveEspionnage(arr.proprietaire, arr.flotte);
  for (const arr of arrAttaques) resolveAttack(arr.proprietaire, arr.flotte);

  function resolveEspionnage(attackerName, fleet) {
    const cible = fleet.vers;
    const defEmp = empires[cible.joueur];
    if (!defEmp) return;
    const targetPlanet = (defEmp.planetes || []).find(p => p.nom === cible.planete);
    if (!targetPlanet) return;

    const sondesLancees = fleet.composition.sonde || 0;
    const techDef = (defEmp.recherche || {}).espionnage_profond || 0;
    // Recherche `cryptographie` (défenseur) : -10%/niv visibilité aux sondes
    // ennemies. Implémentée comme un boost effectif du tech de contre-espionnage
    // dans le calcul du diff (chaque niveau ajoute 4 unités de seuil, soit la
    // même contribution qu'un niveau d'espionnage_profond). Ne tue pas de sondes
    // supplémentaires (pas de double contre-espionnage), mais durcit les paliers.
    const techCrypto = (defEmp.recherche || {}).cryptographie || 0;
    const probaKill = rules.espionnage?.proba_destruction_par_niveau ?? 0.20;
    let detruites = 0;
    for (let i = 0; i < techDef; i++) if (rng() < probaKill) detruites++;
    detruites = Math.min(detruites, sondesLancees);
    const sondesSurvivantes = sondesLancees - detruites;

    const diff = sondesSurvivantes - (techDef + techCrypto) * 4;
    const paliers = rules.espionnage?.paliers || [1, 5, 25, 125, 625];
    let niveau = 0;
    for (const seuil of paliers) { if (diff >= seuil) niveau++; else break; }

    reports.intel.push({
      player: attackerName,
      filename: `joueurs/${attackerName}/intel/tick-${String(tickSuivant).padStart(4, '0')}-${cible.joueur}-${cible.planete}.md`,
      content: renderIntelReport({ att: attackerName, cible, planete: targetPlanet, defEmp, niveau, sondesLancees, detruites, tick: tickSuivant }),
    });

    if (detruites > 0) {
      events.push({ type: 'espionnage-detecte', cible_joueur: cible.joueur, cible_planete: cible.planete, attaquant: attackerName, sondes_detruites: detruites });
      reports.alerts.push({
        player: cible.joueur,
        filename: `joueurs/${cible.joueur}/intel/tick-${String(tickSuivant).padStart(4, '0')}-alerte.md`,
        content: renderAlerteEspionnage({ defenderName: cible.joueur, planeteCible: cible.planete, att: attackerName, detruites, tick: tickSuivant }),
      });
    }

    if (sondesSurvivantes > 0) {
      const attEmp = empires[attackerName];
      const dureeRetour = fleet.duree_aller_utj || fleet.arrivee_utj || 4;
      attEmp.flottes_en_vol = attEmp.flottes_en_vol || [];
      attEmp.flottes_en_vol.push({
        id: `flt-${tickSuivant}-spy-${rng().toString(36).slice(2, 4)}`,
        type_mission: 'retour',
        depuis: { joueur: cible.joueur, planete: cible.planete },
        vers: { joueur: attackerName, planete: fleet.depuis.planete },
        arrivee_utj: dureeRetour,
        composition: { sonde: sondesSurvivantes },
        cargaison: {},
      });
    }
    log(`  👁 ${attackerName} → ${cible.joueur}/${cible.planete} : niv ${niveau}/5 (${sondesSurvivantes}/${sondesLancees} sondes)`);
  }

  function resolveAttack(attackerName, fleet) {
    const cible = fleet.vers;
    const defenderName = cible.joueur;
    const attEmp = empires[attackerName];
    const defEmp = empires[defenderName];
    if (!defEmp) { log(`  · attaque ${fleet.id}: défenseur ${defenderName} introuvable`); return; }
    const targetPlanet = (defEmp.planetes || []).find(p => p.nom === cible.planete);
    if (!targetPlanet) { log(`  · attaque ${fleet.id}: planète ${cible.planete} introuvable chez ${defenderName}`); return; }

    const attacker = { ships: { ...fleet.composition }, tech: { ...(attEmp.recherche || {}) } };
    const defenderShips = { ...(targetPlanet.flotte_au_sol || {}), ...(targetPlanet.defenses || {}) };
    const defender = { ships: defenderShips, tech: { ...(defEmp.recherche || {}) } };

    const result = resolveCombat({ attacker, defender, rules, rng, defenseTypes: rules.defenses });

    const oldDef = targetPlanet.defenses || {};
    targetPlanet.flotte_au_sol = {};
    targetPlanet.defenses = {};
    for (const [type, n] of Object.entries(result.defenseur_restant)) {
      if (oldDef[type] !== undefined) targetPlanet.defenses[type] = n;
      else targetPlanet.flotte_au_sol[type] = n;
    }

    const debrisAtt = computeDebris(attacker.ships, result.attaquant_restant, rules);
    const debrisDef = computeDebris(defender.ships, result.defenseur_restant, rules);
    const debris = { ferrum: debrisAtt.ferrum + debrisDef.ferrum, lumen: debrisAtt.lumen + debrisDef.lumen };
    targetPlanet.champ_debris = targetPlanet.champ_debris || { ferrum: 0, lumen: 0 };
    targetPlanet.champ_debris.ferrum += debris.ferrum;
    targetPlanet.champ_debris.lumen += debris.lumen;

    let pillage = { ferrum: 0, lumen: 0, plasmide: 0 };
    if (result.issue === 'victoire-attaquant') {
      const totalCargo = Object.entries(result.attaquant_restant).reduce((a, [t, n]) => a + n * (rules.vaisseaux[t]?.cargo || 0), 0);
      pillage = computePillage(targetPlanet.ressources, totalCargo, rules);
      for (const [r, n] of Object.entries(pillage)) {
        if (targetPlanet.ressources[r]) targetPlanet.ressources[r].stock -= n;
      }
    }

    const survivantsCount = Object.values(result.attaquant_restant).reduce((a, b) => a + b, 0);
    if (survivantsCount > 0 && attEmp) {
      const dureeRetour = fleet.duree_aller_utj || fleet.arrivee_utj || 8;
      attEmp.flottes_en_vol = attEmp.flottes_en_vol || [];
      attEmp.flottes_en_vol.push({
        id: `flt-${tickSuivant}-ret-${rng().toString(36).slice(2, 4)}`,
        type_mission: 'retour',
        depuis: { joueur: defenderName, planete: cible.planete },
        vers: { joueur: attackerName, planete: fleet.depuis.planete },
        arrivee_utj: dureeRetour,
        composition: result.attaquant_restant,
        cargaison: pillage,
      });
    }

    const totalPertesAtt = Object.entries(attacker.ships).reduce((a, [t, n]) => a + (n - (result.attaquant_restant[t] || 0)), 0);
    const totalPertesDef = Object.entries(defender.ships).reduce((a, [t, n]) => a + (n - (result.defenseur_restant[t] || 0)), 0);
    events.push({
      type: 'bataille', attaquant: attackerName, defenseur: defenderName, lieu: cible.planete,
      issue: result.issue, rondes: result.rondes.length,
      pertes_attaquant: totalPertesAtt, pertes_defenseur: totalPertesDef, pillage, debris,
    });

    reports.battles.push({
      filename: `world/events/tick-${String(tickSuivant).padStart(4, '0')}-bataille-${cible.planete}.md`,
      content: renderBattleReport({ att: attackerName, def: defenderName, cible, result, debris, pillage, tick: tickSuivant }),
    });

    log(`  ⚔ ${attackerName} → ${defenderName}/${cible.planete} : ${result.issue}`);
    log(`     ${result.rondes.length} ronde(s) · pertes A=${totalPertesAtt} D=${totalPertesDef} · débris ferrum=${debris.ferrum} lumen=${debris.lumen}`);
    if (result.issue === 'victoire-attaquant') {
      log(`     pillage : ferrum=${pillage.ferrum} lumen=${pillage.lumen} plasmide=${pillage.plasmide}`);
    }
  }

  // ─── Phase 6 — Scores ───────────────────────────────────────────────────
  log(`▸ Phase 6/6 — Recalcul des scores`);
  for (const emp of Object.values(empires)) {
    let score = 0;
    for (const planete of emp.planetes || []) {
      score += Object.values(planete.batiments || {}).reduce((a, b) => a + b * 100, 0);
      score += Object.entries(planete.flotte_au_sol || {}).reduce((a, [ship, n]) => {
        const def = rules.vaisseaux[ship];
        if (!def) return a;
        const total = (def.cout?.ferrum || 0) + (def.cout?.lumen || 0) + (def.cout?.plasmide || 0);
        return a + n * total / 1000;
      }, 0);
    }
    emp.score_total = Math.floor(score);
  }

  // ─── Galaxie : tick avancé (mutation in-place, cohérente avec empires) ─
  galaxie.tick = tickSuivant;

  // ─── Manifest avec hash chain ───────────────────────────────────────────
  const previousTickHash = manifest.tick_hash || 'genesis';
  const newManifest = { ...manifest };
  newManifest.tick = tickSuivant;
  newManifest.previous_tick_hash = previousTickHash;
  newManifest.hash_etat = 'sha256:' + sha256Hex(canonicalJSON(empires) + canonicalJSON(galaxie)).slice(0, 32);
  delete newManifest.tick_hash;
  newManifest.tick_hash = 'sha256:' + sha256Hex(canonicalJSON(newManifest));

  // ─── Génère eventsLog + empireFiles (markdown) ──────────────────────────
  let eventsLog = null;
  if (events.length > 0) {
    let logContent = `# Tick ${tickSuivant} — ${events.length} événement(s)\n\n`;
    for (const e of events) logContent += `- **${e.type}** · ${JSON.stringify(e)}\n`;
    eventsLog = {
      filename: `world/events/tick-${String(tickSuivant).padStart(4, '0')}.md`,
      content: logContent,
    };
  }

  const empireFiles = [];
  for (const [name, emp] of Object.entries(empires)) {
    emp.tick = tickSuivant;
    empireFiles.push({
      player: name,
      yaml: '# Généré par engine/tick-core.mjs — ne pas éditer.\n' + ystringify(emp),
      md: renderEmpireMd(emp),
    });
  }

  return {
    newManifest,
    newEmpires: empires,
    newGalaxie: galaxie,
    events,
    reports,
    eventsLog,
    empireFiles,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Vérification de signature Ed25519 legacy
// (héritage Aetheris pré-bitcoin ; aujourd'hui la sécurité passe par la
//  pubkey Schnorr de l'inscripteur, cf ADR-0003)
// ════════════════════════════════════════════════════════════════════════

async function checkSignature(name, rawContent, identites, verifySignature) {
  try {
    const identite = identites[name];
    if (!identite) return false;
    const pubStr = identite.cle_publique;
    if (!pubStr || typeof pubStr !== 'string' || !pubStr.startsWith('ed25519:')) return false;
    const pubB64 = pubStr.slice('ed25519:'.length).trim();
    const sigMatch = rawContent.match(/^signature:\s*ed25519:(.+)$/m);
    if (!sigMatch) return false;
    const sigB64 = sigMatch[1].trim();
    if (sigB64 === 'UNSIGNED' || sigB64.startsWith('STUB') || sigB64.startsWith('MEU')) return false;
    return await verifySignature(rawContent, pubB64, sigB64);
  } catch {
    return false;
  }
}

