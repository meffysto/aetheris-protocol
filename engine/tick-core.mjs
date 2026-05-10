// CITADEL // PROTOCOL — Résolveur de tick (logique iso, pas de fs).
// Importable Node ou navigateur.
//
// Exports :
//   - yparse, ystringify, canonicalJSON, rngFromSeed   (helpers iso)
//   - runTick({...}) → { newManifest, newEmpires, events, reports, eventsLog }
//
// Le caller (CLI Node ou console browser) charge l'état, appelle runTick,
// puis persiste le résultat (fs ou IndexedDB).

import { sha256 } from '@noble/hashes/sha256';

// ════════════════════════════════════════════════════════════════════════
// 1.  YAML mini (sous-ensemble suffisant pour notre schéma)
// ════════════════════════════════════════════════════════════════════════

export function yparse(text) {
  const lines = text.split('\n')
    .filter(l => !/^\s*#/.test(l))
    .map(l => l.replace(/\s+#.*$/, ''));
  let i = 0;
  function readBlock(indent) {
    const out = {};
    let firstKey = true;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const ind = line.match(/^ */)[0].length;
      if (ind < indent) return out;
      if (ind > indent && firstKey) return readBlock(ind);
      const m = line.slice(ind).match(/^(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const k = m[1] ?? m[2] ?? m[3];
      const rest = m[4];
      i++;
      if (rest === '') {
        if (i < lines.length && /^\s*-\s/.test(lines[i])) out[k] = readList(ind + 2);
        else out[k] = readBlock(ind + 2);
      } else if (rest.startsWith('[') || rest.startsWith('{')) {
        out[k] = readInline(rest);
      } else {
        out[k] = parseScalar(rest);
      }
      firstKey = false;
    }
    return out;
  }
  function readList(indent) {
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const ind = line.match(/^ */)[0].length;
      if (ind < indent) return out;
      if (!line.slice(ind).startsWith('- ')) return out;
      const rest = line.slice(ind + 2);
      i++;
      if (rest.includes(':')) {
        const m = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
        const item = {};
        if (m[2] === '') item[m[1]] = readBlock(ind + 4);
        else item[m[1]] = parseScalar(m[2]);
        Object.assign(item, readBlock(ind + 2));
        out.push(item);
      } else {
        out.push(parseScalar(rest));
      }
    }
    return out;
  }
  function splitTopLevel(s, sep) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === sep && depth === 0) {
        out.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    const last = s.slice(start).trim();
    if (last) out.push(last);
    return out;
  }
  function readInline(s) {
    s = s.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      return splitTopLevel(inner, ',').map(t => parseScalar(t));
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return {};
      const out = {};
      for (const part of splitTopLevel(inner, ',')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const k = part.slice(0, colon).trim().replace(/^["']|["']$/g, '');
        const v = part.slice(colon + 1).trim();
        out[k] = parseScalar(v);
      }
      return out;
    }
    return s;
  }
  function parseScalar(s) {
    s = s.trim();
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~' || s === '') return null;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
    if (/^["'].*["']$/.test(s)) return s.slice(1, -1);
    if (s.startsWith('[') || s.startsWith('{')) return readInline(s);
    return s;
  }
  return readBlock(0);
}

export function ystringify(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return /[:#\[\]{}]|^\s|\s$/.test(obj) ? JSON.stringify(obj) : obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      if (typeof item === 'object' && item !== null) {
        const lines = Object.entries(item).map(([k, v], i) => {
          const prefix = i === 0 ? `${pad}- ` : `${pad}  `;
          if (typeof v === 'object' && v !== null) {
            if (Array.isArray(v) && v.length === 0) return `${prefix}${k}: []`;
            if (!Array.isArray(v) && Object.keys(v).length === 0) return `${prefix}${k}: {}`;
            return `${prefix}${k}:\n${ystringify(v, indent + 4)}`;
          }
          return `${prefix}${k}: ${ystringify(v)}`;
        });
        return lines.join('\n');
      }
      return `${pad}- ${ystringify(item)}`;
    }).join('\n');
  }
  return Object.entries(obj).map(([k, v]) => {
    if (typeof v === 'object' && v !== null) {
      if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []`;
      if (!Array.isArray(v) && Object.keys(v).length === 0) return `${pad}${k}: {}`;
      const inner = ystringify(v, indent + 2);
      return `${pad}${k}:\n${inner}`;
    }
    return `${pad}${k}: ${ystringify(v)}`;
  }).join('\n');
}

// ════════════════════════════════════════════════════════════════════════
// 2.  RNG déterministe (xoshiro128**) — seed via SHA256 (iso)
// ════════════════════════════════════════════════════════════════════════

export function rngFromSeed(seedStr) {
  const h = sha256(new TextEncoder().encode(seedStr));
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  let s0 = dv.getUint32(0, true), s1 = dv.getUint32(4, true),
      s2 = dv.getUint32(8, true), s3 = dv.getUint32(12, true);
  function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
  return function rng() {
    const result = (rotl(Math.imul(s1, 5), 7) * 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t; s3 = rotl(s3, 11);
    return result / 0x100000000;
  };
}

// ════════════════════════════════════════════════════════════════════════
// 3.  JSON canonique pour hash (clés triées récursivement)
// ════════════════════════════════════════════════════════════════════════

export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

function sha256Hex(text) {
  const bytes = sha256(new TextEncoder().encode(text));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ════════════════════════════════════════════════════════════════════════
// Mapping bloc Bitcoin ↔ tick
// ════════════════════════════════════════════════════════════════════════

/**
 * Calcule le tick courant à partir de la hauteur de bloc Bitcoin.
 *
 * @param {number} currentHeight   Hauteur actuelle (tip)
 * @param {number} genesisBlock    Bloc Bitcoin où le serveur démarre
 * @param {number} [blocsParTick=1]
 * @param {number} [tickGenesis=0] Tick associé à genesisBlock
 * @returns {number} Tick courant (clampé ≥ tickGenesis)
 */
export function tickFromBlockHeight(currentHeight, genesisBlock, blocsParTick = 1, tickGenesis = 0) {
  if (currentHeight < genesisBlock) return tickGenesis;
  return tickGenesis + Math.floor((currentHeight - genesisBlock) / blocsParTick);
}

/**
 * Hauteur de bloc Bitcoin où le tick `targetTick` se résout.
 */
export function blockHeightForTick(targetTick, genesisBlock, blocsParTick = 1, tickGenesis = 0) {
  return genesisBlock + (targetTick - tickGenesis) * blocsParTick;
}

// ════════════════════════════════════════════════════════════════════════
// 4.  runTick — pure function
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
  combat, verifySignature = null, opts = {},
}) {
  const { resolveCombat, computeDebris, computePillage } = combat;
  const { strict = false, log = () => {} } = opts;

  const UTJ_PAR_TICK = rules.duree_utj_par_tick || 6;
  const tickSuivant = manifest.tick + 1;
  const rng = rngFromSeed(`${manifest.seed}:${tickSuivant}`);
  const events = [];
  const reports = { intel: [], alerts: [], battles: [] };

  // ─── Phase 0 — Expiration des effets temporels (relations, moral) ──────
  // Avant la production, on nettoie : trêves échues passent à 'neutre',
  // malus moraux passés sont oubliés. Cela garantit que le tick courant
  // applique des effets cohérents.
  for (const emp of Object.values(empires)) {
    emp.relations = emp.relations || {};
    for (const [autre, rel] of Object.entries(emp.relations)) {
      if (rel.status !== 'neutre' && rel.expire_tick != null && rel.expire_tick <= tickSuivant) {
        emp.relations[autre] = { status: 'neutre', expire_tick: null };
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
      for (const info of Object.values(planete.ressources || {})) {
        const prod = (info.production_par_utj || 0) * UTJ_PAR_TICK * factMoral;
        info.stock = Math.min((info.stock || 0) + prod, info.capacite || Infinity);
      }
    }
    // Influence : produite par centre_diplomatique (0.5 × niv / UTJ).
    emp.ressources_globales = emp.ressources_globales || { singularite: 0, influence: 0 };
    let influenceParUtj = 0;
    for (const p of emp.planetes || []) {
      const nivCD = p.batiments?.centre_diplomatique || 0;
      if (nivCD > 0) influenceParUtj += 0.5 * nivCD;
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
            const baseline = { ferrum: 30, lumen: 20, plasmide: 0 }[res] || 0;
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
            const prod = Math.floor(base * niv * Math.pow(1.1, niv) * bonus * thermal);
            if (planete.ressources?.[res]) {
              planete.ressources[res].production_par_utj = baseline + prod;
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
    const vitesse = 1 + 0.10 * niveauChantier + 0.10 * niveauUsine;
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
    const vitesse = rules.vaisseaux.sonde?.vitesse || 100000;
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
    const vMin = Math.min(...Object.keys(action.flotte || {}).map(s => rules.vaisseaux[s]?.vitesse || 1000));
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

    const dureeUTJ = (def.duree_base_utj || 1) * Math.pow(def.multiplicateur_duree || 1.5, niveauActuel);
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
    const vMin = Math.min(...Object.keys(action.flotte || {}).map(s => rules.vaisseaux[s]?.vitesse || 1000));
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
    const vitesse = rules.vaisseaux.recycleur?.vitesse || 2000;
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
    const [g1, s1, p1] = src.coordonnees;
    const [g2, s2, p2] = dst.coordonnees;
    if (g1 !== g2) return 20000 + Math.abs(g1 - g2) * 5000;
    if (s1 !== s2) return 2700 + Math.abs(s1 - s2) * 95;
    return 1000 + Math.abs(p1 - p2) * 5;
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
    const probaKill = rules.espionnage?.proba_destruction_par_niveau ?? 0.20;
    let detruites = 0;
    for (let i = 0; i < techDef; i++) if (rng() < probaKill) detruites++;
    detruites = Math.min(detruites, sondesLancees);
    const sondesSurvivantes = sondesLancees - detruites;

    const diff = sondesSurvivantes - techDef * 4;
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
    events,
    reports,
    eventsLog,
    empireFiles,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Helpers de rendu (purs)
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

function renderIntelReport({ att, cible, planete, defEmp, niveau, sondesLancees, detruites, tick }) {
  const lines = [];
  lines.push('---');
  lines.push(`type: rapport-espionnage`);
  lines.push(`tick: ${tick}`);
  lines.push(`cible: { joueur: ${cible.joueur}, planete: ${cible.planete} }`);
  lines.push(`niveau_intel: ${niveau}`);
  lines.push(`sondes_lancees: ${sondesLancees}`);
  lines.push(`sondes_detruites: ${detruites}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Rapport d'espionnage — ${cible.joueur}/${cible.planete}`);
  lines.push('');
  lines.push(`Tick ${tick} · Niveau ${niveau}/5`);
  lines.push(`${sondesLancees} sondes lancées, ${detruites} interceptées.`);
  lines.push('');
  if (niveau === 0) {
    lines.push(`> ⚠ Toutes les sondes ont été détectées et détruites avant transmission utile.`);
    lines.push(`> Le défenseur **a été alerté** de la tentative d'intrusion.`);
  }
  if (niveau >= 1) {
    lines.push(`## Ressources`); lines.push('');
    for (const [r, info] of Object.entries(planete.ressources || {})) {
      lines.push(`- ${r} : **${(info.stock || 0).toLocaleString('fr-FR')}** (capacité ${(info.capacite || 0).toLocaleString('fr-FR')}, prod +${info.production_par_utj || 0}/UTJ)`);
    }
    lines.push('');
  }
  if (niveau >= 2) {
    lines.push(`## Flotte au sol`); lines.push('');
    const fl = planete.flotte_au_sol || {};
    if (Object.keys(fl).length === 0) lines.push('*aucune*');
    else for (const [t, n] of Object.entries(fl)) lines.push(`- ${t} : ${n.toLocaleString('fr-FR')}`);
    lines.push('');
  }
  if (niveau >= 3) {
    lines.push(`## Défenses`); lines.push('');
    const d = planete.defenses || {};
    if (Object.keys(d).length === 0) lines.push('*aucune*');
    else for (const [t, n] of Object.entries(d)) lines.push(`- ${t} : ${n.toLocaleString('fr-FR')}`);
    lines.push('');
  }
  if (niveau >= 4) {
    lines.push(`## Bâtiments`); lines.push('');
    for (const [b, niv] of Object.entries(planete.batiments || {})) lines.push(`- ${b} : niveau ${niv}`);
    lines.push('');
  }
  if (niveau >= 5) {
    lines.push(`## Recherches`); lines.push('');
    for (const [t, niv] of Object.entries(defEmp.recherche || {})) lines.push(`- ${t} : niveau ${niv}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function renderAlerteEspionnage({ defenderName, planeteCible, att, detruites, tick }) {
  const lines = [];
  lines.push('---');
  lines.push(`type: alerte-espionnage`);
  lines.push(`tick: ${tick}`);
  lines.push(`planete: ${planeteCible}`);
  lines.push(`attaquant: ${att}`);
  lines.push(`sondes_interceptees: ${detruites}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ⚠ Tentative d'espionnage interceptée`);
  lines.push('');
  lines.push(`Tick ${tick} · Planète **${planeteCible}**`);
  lines.push(`${detruites} sonde(s) appartenant à **${att}** ont été détectées et détruites par le contre-espionnage.`);
  return lines.join('\n') + '\n';
}

function renderBattleReport({ att, def, cible, result, debris, pillage, tick }) {
  const lines = [];
  lines.push('---');
  lines.push(`type: bataille`);
  lines.push(`tick: ${tick}`);
  lines.push(`attaquant: ${att}`);
  lines.push(`defenseur: ${def}`);
  lines.push(`lieu: { joueur: ${def}, planete: ${cible.planete} }`);
  lines.push(`issue: ${result.issue}`);
  lines.push(`rondes: ${result.rondes.length}`);
  lines.push(`debris: { ferrum: ${debris.ferrum}, lumen: ${debris.lumen} }`);
  lines.push(`pillage: { ferrum: ${pillage.ferrum}, lumen: ${pillage.lumen}, plasmide: ${pillage.plasmide} }`);
  lines.push('---');
  lines.push('');
  lines.push(`# Bataille de ${cible.planete} — tick ${tick}`);
  lines.push('');
  lines.push(`**${att.toUpperCase()}** attaque **${def.toUpperCase()}** sur ${cible.planete}.`);
  lines.push('');
  lines.push(`## Forces engagées`);
  lines.push('');
  lines.push(`### Attaquant (${att})`);
  for (const [t, n] of Object.entries(result.attaquant_initial)) {
    lines.push(`- ${t} : ${n}  →  restant : ${result.attaquant_restant[t] || 0}`);
  }
  lines.push('');
  lines.push(`### Défenseur (${def})`);
  for (const [t, n] of Object.entries(result.defenseur_initial)) {
    lines.push(`- ${t} : ${n}  →  restant : ${result.defenseur_restant[t] || 0}`);
  }
  lines.push('');
  lines.push(`## Déroulé`);
  lines.push('');
  for (const r of result.rondes) {
    lines.push(`**Ronde ${r.ronde}** — tir A=${r.tir_attaquant} / D=${r.tir_defenseur}`);
    const pa = Object.entries(r.pertes_attaquant).map(([t, n]) => `${t} -${n}`).join(', ') || '—';
    const pd = Object.entries(r.pertes_defenseur).map(([t, n]) => `${t} -${n}`).join(', ') || '—';
    lines.push(`- pertes attaquant : ${pa}`);
    lines.push(`- pertes défenseur : ${pd}`);
    lines.push('');
  }
  lines.push(`## Résultat`);
  lines.push('');
  lines.push(`Issue : **${result.issue}**`);
  lines.push(`Champ de débris : ${debris.ferrum} ferrum / ${debris.lumen} lumen`);
  if (result.issue === 'victoire-attaquant') {
    lines.push(`Butin : ${pillage.ferrum} ferrum / ${pillage.lumen} lumen / ${pillage.plasmide} plasmide`);
  }
  return lines.join('\n') + '\n';
}

function renderEmpireMd(emp) {
  let md = `# Empire de ${emp.joueur}\n\n`;
  md += `> Tick ${emp.tick} · Score ${emp.score_total} · Alliance ${emp.alliance || '—'}\n\n`;
  md += `## Planètes (${(emp.planetes || []).length})\n\n`;
  for (const p of emp.planetes || []) {
    md += `### ${p.nom} — ${p.coordonnees.join(':')} · *${p.type}*\n\n`;
    md += `| Ressource | Stock | Production/UTJ | Capacité |\n|---|---|---|---|\n`;
    for (const [k, v] of Object.entries(p.ressources)) {
      md += `| ${k} | ${v.stock?.toLocaleString('fr-FR')} | +${v.production_par_utj} | ${v.capacite?.toLocaleString('fr-FR')} |\n`;
    }
    md += `\n**Bâtiments** : `;
    md += Object.entries(p.batiments).map(([k, v]) => `${k} ${v}`).join(', ') + '\n\n';
    if ((p.file_chantier || []).length > 0) {
      md += `**File** : ${p.file_chantier.map(c => `${c.batiment}→${c.niveau_cible} (${c.fin_utj} UTJ)`).join(', ')}\n\n`;
    }
  }
  if ((emp.recherche || {}) && Object.keys(emp.recherche).length > 0) {
    md += `## Recherche\n\n`;
    for (const [k, v] of Object.entries(emp.recherche)) md += `- ${k} : niv ${v}\n`;
  }
  return md;
}
