#!/usr/bin/env node
// AETHERIS // PROTOCOL — Résolveur de tick
// Déterministe, sans dépendance externe (Node 20+).
//
// Usage:
//   node engine/tick.mjs --dry-run    # simule, n'écrit rien
//   node engine/tick.mjs --apply      # applique et commit
//
// Cette version MVP couvre :
//   ✓ Production de ressources
//   ✓ Avancement des chantiers et recherches
//   ✓ Mouvements de flotte (transports + colonisation)
//   ✓ Combats (résolution 6-rondes simplifiée)
//   ✓ Espionnage (rapports gradués)
//   ✓ Pillage + champs de débris
//
// Non couvert (post-MVP) :
//   ◯ Marché P2P
//   ◯ Missiles inter-planétaires
//   ◯ Diplomatie automatisée
//   ◯ Vérification cryptographique des signatures (stub présent)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveCombat, computeDebris, computePillage } from './combat.mjs';

const ROOT = path.resolve(process.argv[2] === '--root' ? process.argv[3] : '.');
const DRY = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');

if (!DRY && !APPLY) {
  console.error('Usage: tick.mjs [--root <path>] (--dry-run | --apply)');
  process.exit(2);
}

// ════════════════════════════════════════════════════════════════════════
// 1.  YAML mini (sous-ensemble suffisant pour notre schéma)
// ════════════════════════════════════════════════════════════════════════
// Plutôt que d'embarquer js-yaml, on parse un sous-ensemble strict.
// Notre format est volontairement simple : objets, listes, scalaires, indentation 2 esp.

function yparse(text) {
  // Filtre les lignes qui sont entièrement un commentaire, et strip les
  // commentaires de fin de ligne (` #...` précédé d'un espace).
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
      const m = line.slice(ind).match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const [, k, rest] = m;
      i++;
      if (rest === '') {
        // Nested object or list
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
        // Object item: re-add as if first key was on its own line
        const m = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
        const item = {};
        if (m[2] === '') {
          item[m[1]] = readBlock(ind + 4);
        } else {
          item[m[1]] = parseScalar(m[2]);
        }
        // Read remaining keys at same indent
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

function ystringify(obj, indent = 0) {
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
// 2.  RNG déterministe (xoshiro128**)
// ════════════════════════════════════════════════════════════════════════

function rngFromSeed(seedStr) {
  const h = crypto.createHash('sha256').update(seedStr).digest();
  let s0 = h.readUInt32LE(0), s1 = h.readUInt32LE(4),
      s2 = h.readUInt32LE(8), s3 = h.readUInt32LE(12);
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
// 3.  I/O fichiers
// ════════════════════════════════════════════════════════════════════════

function rd(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function wr(p, content) {
  if (DRY) { console.log(`  [DRY] would write ${p} (${content.length} bytes)`); return; }
  const full = path.join(ROOT, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function ls(p) {
  const full = path.join(ROOT, p);
  return fs.existsSync(full) ? fs.readdirSync(full) : [];
}
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }

// ════════════════════════════════════════════════════════════════════════
// 4.  Chargement de l'état
// ════════════════════════════════════════════════════════════════════════

console.log('━━━ AETHERIS // tick resolver ━━━');
console.log(`root = ${ROOT}`);
console.log(`mode = ${DRY ? 'DRY-RUN' : 'APPLY'}`);

const manifest = yparse(rd('world/manifest.yaml'));
const rules = yparse(rd('engine/rules.yaml'));
const galaxie = yparse(rd('world/galaxie.yaml'));

console.log(`tick courant = ${manifest.tick}`);
console.log(`seed = ${manifest.seed}`);

const players = ls('joueurs').filter(n => exists(`joueurs/${n}/empire.yaml`)).sort();
console.log(`joueurs = ${players.length} (${players.join(', ')})`);

const empires = {};
for (const p of players) empires[p] = yparse(rd(`joueurs/${p}/empire.yaml`));

const ORDER_SOURCE = process.env.AETH_ORDER_SOURCE ?? 'filesystem';
const orders = {};
const ordersRawText = {}; // YAML brut pour vérification signature (mode bitcoin)

if (ORDER_SOURCE === 'bitcoin') {
  // Mode Bitcoin : charge les ordres depuis .cache/orders-<tick>.json
  // Le cache est peuplé par sync.mjs après scan de la chaîne.
  const cacheFile = path.join(ROOT, `.cache/orders-${manifest.tick + 1}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    for (const entry of cached) {
      const parsed = yparse(entry.yaml);
      if (parsed && parsed.joueur) {
        orders[parsed.joueur] = parsed;
        ordersRawText[parsed.joueur] = entry.yaml;
      }
    }
    console.log(`  source: bitcoin cache (${cached.length} ordres)`);
  } catch (e) {
    console.warn(`  ! cache bitcoin introuvable (${cacheFile}): ${e.message}`);
  }
} else {
  for (const p of players) {
    if (exists(`joueurs/${p}/ordres.yaml`)) {
      try { orders[p] = yparse(rd(`joueurs/${p}/ordres.yaml`)); }
      catch (e) { console.warn(`  ! ordres.yaml invalide pour ${p}: ${e.message}`); }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// 5.  Application des effets — UN TICK = 6 UTJ
// ════════════════════════════════════════════════════════════════════════

const UTJ_PAR_TICK = rules.duree_utj_par_tick || 6;
const tickSuivant = manifest.tick + 1;
const rng = rngFromSeed(`${manifest.seed}:${tickSuivant}`);
const events = [];

console.log(`\n▸ Phase 1/6 — Production de ressources (×${UTJ_PAR_TICK} UTJ)`);
for (const [name, emp] of Object.entries(empires)) {
  for (const planete of emp.planetes || []) {
    for (const [res, info] of Object.entries(planete.ressources || {})) {
      const prod = (info.production_par_utj || 0) * UTJ_PAR_TICK;
      info.stock = Math.min((info.stock || 0) + prod, info.capacite || Infinity);
    }
  }
}

console.log(`▸ Phase 2/6 — Avancement chantiers, recherches & constructions`);
for (const [name, emp] of Object.entries(empires)) {
  for (const planete of emp.planetes || []) {
    // 2a. File de bâtiments
    const file = planete.file_chantier || [];
    if (file.length > 0) {
      file[0].fin_utj = (file[0].fin_utj || 0) - UTJ_PAR_TICK;
      if (file[0].fin_utj <= 0) {
        const done = file.shift();
        planete.batiments[done.batiment] = done.niveau_cible;
        // Recalcul de la production si c'est une mine
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
          const prod = Math.floor(base * niv * Math.pow(1.1, niv) * bonus);
          if (planete.ressources?.[res]) {
            planete.ressources[res].production_par_utj = baseline + prod;
          }
        }
        events.push({
          type: 'chantier-acheve',
          joueur: name,
          planete: planete.nom,
          batiment: done.batiment,
          niveau: done.niveau_cible,
        });
      }
    }

    // 2b. File de construction (vaisseaux + défenses)
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
        events.push({
          type: 'construction-achevee',
          joueur: name,
          planete: planete.nom,
          unite: done.unite,
          quantite: done.quantite,
          categorie: done.categorie,
        });
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
      events.push({
        type: 'recherche-achevee',
        joueur: name,
        technologie: done.technologie,
        niveau: done.niveau_cible,
      });
    }
  }
}

console.log(`▸ Phase 3/6 — Validation des nouveaux ordres`);
const STRICT = process.argv.includes('--strict');
for (const [name, ord] of Object.entries(orders)) {
  if (!ord || !ord.ordres) continue;

  // Vérification de signature Ed25519
  const rawContent = ORDER_SOURCE === 'bitcoin'
    ? (ordersRawText[name] ?? '')
    : rd(`joueurs/${name}/ordres.yaml`);
  const sigOk = verifierSignature(name, rawContent);
  if (!sigOk) {
    if (STRICT) {
      console.warn(`  ✗ ${name}: signature INVALIDE — ordres rejetés (mode strict)`);
      continue;
    } else {
      console.warn(`  ⚠ ${name}: signature invalide ou absente — toléré (legacy). Lance: node engine/sign.mjs joueurs/${name}/ordres.yaml`);
    }
  }

  if (ord.tick_cible !== tickSuivant) {
    console.log(`  · ${name}: ordres pour tick ${ord.tick_cible}, courant = ${tickSuivant} — IGNORÉS`);
    continue;
  }
  for (const action of ord.ordres) {
    applyOrder(name, action);
  }
}

function verifierSignature(playerName, fileContent) {
  try {
    const idPath = `joueurs/${playerName}/identite.yaml`;
    if (!exists(idPath)) return false;
    const identite = yparse(rd(idPath));
    const pubStr = identite.cle_publique;
    if (!pubStr || typeof pubStr !== 'string' || !pubStr.startsWith('ed25519:')) return false;
    const spkiB64 = pubStr.slice('ed25519:'.length).trim();
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(spkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const sigMatch = fileContent.match(/^signature:\s*ed25519:(.+)$/m);
    if (!sigMatch) return false;
    const sigB64 = sigMatch[1].trim();
    if (sigB64 === 'UNSIGNED' || sigB64.startsWith('STUB') || sigB64.startsWith('MEU')) return false;
    const sig = Buffer.from(sigB64, 'base64');
    const canonical = fileContent.split('\n').filter(l => !/^signature:\s*/.test(l)).join('\n').trimEnd() + '\n';
    return crypto.verify(null, Buffer.from(canonical, 'utf8'), pubKey, sig);
  } catch (e) {
    return false;
  }
}

function applyOrder(playerName, action) {
  const emp = empires[playerName];
  if (!emp) return;
  switch (action.type) {
    case 'chantier': return queueChantier(emp, action);
    case 'recherche': return queueRecherche(emp, action);
    case 'transport': return queueTransport(emp, action, playerName);
    case 'attaque': return queueAttaque(emp, action, playerName);
    case 'construction': return queueConstruction(emp, action, playerName);
    case 'espionnage': return queueEspionnage(emp, action, playerName);
    case 'recyclage': return queueRecyclage(emp, action, playerName);
    default:
      console.log(`  · ${playerName}: type d'ordre non implémenté: ${action.type}`);
  }
}

function queueConstruction(emp, action, playerName) {
  const planete = (emp.planetes || []).find(p => p.nom === action.planete);
  if (!planete) return;
  const qty = parseInt(action.quantite, 10);
  if (!qty || qty <= 0) return;

  // Cherche dans vaisseaux puis défenses
  let def = rules.vaisseaux?.[action.unite];
  let categorie = 'vaisseau';
  if (!def) {
    def = rules.defenses?.[action.unite];
    categorie = 'defense';
  }
  if (!def) {
    console.log(`  · ${playerName}: unité inconnue: ${action.unite}`);
    return;
  }

  if (!checkRequiert(def.requiert, planete, emp, playerName, `construction ${action.unite}`)) return;

  // Bouclier planétaire : max 1 par planète
  if (categorie === 'defense' && def.max_par_planete) {
    const dejaLa = (planete.defenses || {})[action.unite] || 0;
    const enFile = (planete.file_construction || [])
      .filter(c => c.unite === action.unite)
      .reduce((a, c) => a + c.quantite, 0);
    if (dejaLa + enFile + qty > def.max_par_planete) {
      console.log(`  · ${playerName}: ${action.unite} max ${def.max_par_planete} par planète`);
      return;
    }
  }

  // Coût total
  const cout = {};
  for (const [k, v] of Object.entries(def.cout || {})) cout[k] = v * qty;

  // Vérifier ressources
  for (const [k, v] of Object.entries(cout)) {
    if ((planete.ressources[k]?.stock || 0) < v) {
      console.log(`  · ${playerName}: ressources insuffisantes pour ${qty}× ${action.unite} (manque ${k})`);
      return;
    }
  }
  for (const [k, v] of Object.entries(cout)) planete.ressources[k].stock -= v;

  // Durée : duree_utj × qty / vitesse_construction
  const niveauChantier = planete.batiments?.chantier_spatial || 0;
  const niveauUsine = planete.batiments?.usine_robotique || 0;
  const vitesse = 1 + 0.10 * niveauChantier + 0.10 * niveauUsine;
  const dureeUTJ = Math.max(1, Math.ceil((def.duree_utj || 1) * qty / vitesse));

  planete.file_construction = planete.file_construction || [];
  planete.file_construction.push({
    unite: action.unite,
    categorie,
    quantite: qty,
    fin_utj: dureeUTJ,
  });
  console.log(`  ✓ ${playerName}: construction ${qty}× ${action.unite} sur ${action.planete} (${dureeUTJ} UTJ)`);
}

function queueEspionnage(emp, action, playerName) {
  const src = (emp.planetes || []).find(p => p.nom === action.depuis);
  if (!src) return;
  const cible = action.cible || {};
  if (!cible.joueur || !cible.planete) {
    console.log(`  · ${playerName}: espionnage sans cible {joueur, planete}`);
    return;
  }
  const n = parseInt(action.nombre_sondes, 10);
  if (!n || n <= 0) return;
  if ((src.flotte_au_sol?.sonde || 0) < n) {
    console.log(`  · ${playerName}: pas assez de sondes (${src.flotte_au_sol?.sonde || 0} dispo, ${n} demandées)`);
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
  console.log(`  👁 ${playerName}: espionnage ${action.depuis} → ${cible.joueur}/${cible.planete} (${n} sondes, ${dureeUTJ} UTJ)`);
}

function queueAttaque(emp, action, playerName) {
  const src = (emp.planetes || []).find(p => p.nom === action.depuis);
  if (!src) return;
  const cible = action.cible || {};
  if (!cible.joueur || !cible.planete) {
    console.log(`  · ${playerName}: attaque sans cible {joueur, planete}`);
    return;
  }
  for (const [ship, n] of Object.entries(action.flotte || {})) {
    if ((src.flotte_au_sol[ship] || 0) < n) {
      console.log(`  · ${playerName}: flotte insuffisante (${ship}) pour attaque depuis ${action.depuis}`);
      return;
    }
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
  console.log(`  ⚔ ${playerName}: attaque ${action.depuis} → ${cible.joueur}/${cible.planete} (${dureeUTJ} UTJ)`);
}

// Verifie qu'un bloc `requiert: { k: niveau, ... }` est satisfait.
// - Si `k` est un bâtiment : check sur la planete concernee (pour chantier/
//   construction) ou max empire-wide (pour recherche, ou si planete=null).
// - Si `k` est une recherche : check empire-wide (`emp.recherche`).
// - Si `k` n'existe ni en batiment ni en recherche : niveau considere = 0
//   (fail explicite — protege contre les fautes de frappe dans rules.yaml).
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
  if (missing.length) {
    console.log(`  · ${playerName}: ${what} requiert ${missing.join(', ')}`);
    return false;
  }
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

  // Coût × multiplicateur^(niveau-1)
  const mult = Math.pow(def.multiplicateur_cout, niveauActuel);
  const cout = {};
  for (const [k, v] of Object.entries(def.cout_base || {})) cout[k] = Math.floor(v * mult);

  // Vérifier ressources
  for (const [k, v] of Object.entries(cout)) {
    if ((planete.ressources[k]?.stock || 0) < v) {
      console.log(`  · ${emp.joueur}: ressources insuffisantes pour ${action.batiment} ${action.niveau_cible}`);
      return;
    }
  }
  for (const [k, v] of Object.entries(cout)) planete.ressources[k].stock -= v;

  const dureeUTJ = (def.duree_base_utj || 1) * Math.pow(def.multiplicateur_duree || 1.5, niveauActuel);
  planete.file_chantier = planete.file_chantier || [];
  planete.file_chantier.push({
    batiment: action.batiment,
    niveau_cible: action.niveau_cible,
    fin_utj: Math.ceil(dureeUTJ),
  });
  console.log(`  ✓ ${emp.joueur}: chantier ${action.batiment} → ${action.niveau_cible} (${Math.ceil(dureeUTJ)} UTJ)`);
}

function queueRecherche(emp, action) {
  const def = rules.recherches[action.technologie];
  if (!def) return;
  const niveauActuel = (emp.recherche || {})[action.technologie] || 0;
  if (action.niveau_cible !== niveauActuel + 1) return;
  // Recherche est empire-wide → planete=null, le helper fait max sur tous les batiments.
  if (!checkRequiert(def.requiert, null, emp, emp.joueur, `recherche ${action.technologie}`)) return;
  const mult = Math.pow(def.mult || 2.0, niveauActuel);
  const cout = {};
  for (const [k, v] of Object.entries(def.cout_base || {})) cout[k] = Math.floor(v * mult);
  // Pour la recherche on prend sur la première planète qui peut payer
  let payer = (emp.planetes || []).find(p =>
    Object.entries(cout).every(([k, v]) => (p.ressources[k]?.stock || 0) >= v));
  if (!payer) {
    console.log(`  · ${emp.joueur}: aucune planète ne peut payer recherche ${action.technologie}`);
    return;
  }
  for (const [k, v] of Object.entries(cout)) payer.ressources[k].stock -= v;
  const duree = (def.duree_base || 1) * Math.pow(2, niveauActuel);
  emp.file_recherche = emp.file_recherche || [];
  emp.file_recherche.push({
    technologie: action.technologie,
    niveau_cible: action.niveau_cible,
    fin_utj: Math.ceil(duree),
  });
  console.log(`  ✓ ${emp.joueur}: recherche ${action.technologie} → ${action.niveau_cible} (${Math.ceil(duree)} UTJ)`);
}

function queueTransport(emp, action, playerName) {
  const src = (emp.planetes || []).find(p => p.nom === action.depuis);
  if (!src) return;
  // Cible normalisée — accepte action.cible (forme console) ou action.vers
  // (forme legacy pour compat).
  const cible = action.cible
    || (typeof action.vers === 'object' ? action.vers : null)
    || (typeof action.vers === 'string' ? { joueur: playerName, planete: action.vers } : null);
  if (!cible || !cible.planete) {
    console.log(`  · ${playerName}: transport sans cible valide`);
    return;
  }
  const cibleJoueur = cible.joueur || playerName;
  const ciblePlanete = cible.planete;

  // Retirer flotte + cargaison du sol
  for (const [ship, n] of Object.entries(action.flotte || {})) {
    if ((src.flotte_au_sol[ship] || 0) < n) {
      console.log(`  · ${playerName}: flotte insuffisante (${ship}) pour transport`);
      return;
    }
  }
  for (const [res, n] of Object.entries(action.cargaison || {})) {
    if ((src.ressources[res]?.stock || 0) < n) {
      console.log(`  · ${playerName}: cargaison ${res} insuffisante`);
      return;
    }
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
  console.log(`  ✓ ${playerName}: transport ${action.depuis} → ${cibleJoueur}/${ciblePlanete} (${dureeUTJ} UTJ)`);
}

// Recyclage : envoie des recycleurs sur une planète possédée par le joueur
// pour récupérer son champ_debris. Sur arrivée, on calcule la cargaison
// embarquée (capped par capacité totale des recycleurs), on réduit
// champ_debris, et la flotte revient sur la source.
function queueRecyclage(emp, action, playerName) {
  const src = (emp.planetes || []).find(p => p.nom === action.depuis);
  if (!src) return;
  const cible = action.cible || {};
  const cibleJoueur = cible.joueur || playerName;
  const ciblePlanete = cible.planete;
  if (!ciblePlanete) {
    console.log(`  · ${playerName}: recyclage sans cible valide`);
    return;
  }
  // V1 : recyclage uniquement sur tes propres planètes (le champ_debris
  // n'est pas exposé publiquement).
  if (cibleJoueur !== playerName) {
    console.log(`  · ${playerName}: recyclage sur planète d'autrui non autorisé (v1)`);
    return;
  }
  const dst = (emp.planetes || []).find(p => p.nom === ciblePlanete);
  const debris = dst?.champ_debris;
  const totalDebris = (debris?.ferrum || 0) + (debris?.lumen || 0);
  if (!totalDebris) {
    console.log(`  · ${playerName}: aucun débris à récupérer sur ${ciblePlanete}`);
    return;
  }
  const recycleurs = (action.flotte || {}).recycleur || 0;
  if (recycleurs <= 0) {
    console.log(`  · ${playerName}: recyclage requiert au moins 1 recycleur`);
    return;
  }
  if ((src.flotte_au_sol.recycleur || 0) < recycleurs) {
    console.log(`  · ${playerName}: pas assez de recycleurs disponibles sur ${action.depuis}`);
    return;
  }
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
  console.log(`  ♻ ${playerName}: recyclage ${action.depuis} → ${ciblePlanete} (${recycleurs} recycleurs, ${dureeUTJ} UTJ)`);
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

console.log(`▸ Phase 4/6 — Mouvements de flotte (avancement)`);
const arrivees = [];
for (const [name, emp] of Object.entries(empires)) {
  const restantes = [];
  for (const flt of emp.flottes_en_vol || []) {
    flt.arrivee_utj -= UTJ_PAR_TICK;
    if (flt.arrivee_utj <= 0) {
      arrivees.push({ proprietaire: name, flotte: flt });
    } else {
      restantes.push(flt);
    }
  }
  emp.flottes_en_vol = restantes;
}

// 4a. Transports (livraison) et retours
for (const arr of arrivees.filter(a => a.flotte.type_mission === 'transport' || a.flotte.type_mission === 'retour')) {
  const flt = arr.flotte;
  const versPlanete = flt.vers.planete || flt.vers;
  const versJoueur = flt.vers.joueur || arr.proprietaire;
  const dst = (empires[versJoueur]?.planetes || []).find(p => p.nom === versPlanete);
  if (!dst) {
    console.log(`  · flotte ${flt.id}: destination ${versJoueur}/${versPlanete} introuvable`);
    continue;
  }
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

// 4b. Recyclage : flotte arrive sur sa propre planète, ramasse les
// débris (capped par cargo des recycleurs), repart en `retour`.
const CARGO_RECYCLEUR = rules.vaisseaux.recycleur?.cargo || 20000;
for (const arr of arrivees.filter(a => a.flotte.type_mission === 'recyclage')) {
  const flt = arr.flotte;
  const dst = (empires[flt.vers.joueur]?.planetes || []).find(p => p.nom === flt.vers.planete);
  if (!dst) {
    console.log(`  · flotte ${flt.id}: planète cible ${flt.vers.planete} introuvable`);
    continue;
  }
  const debris = dst.champ_debris || { ferrum: 0, lumen: 0 };
  const cargoTotal = (flt.composition.recycleur || 0) * CARGO_RECYCLEUR;
  // Répartit la capacité au prorata des deux types de débris.
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
  // Retour vers la source avec la cargaison récupérée.
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
  events.push({
    type: 'recyclage-livre',
    joueur: arr.proprietaire,
    planete: flt.vers.planete,
    cargaison: pris,
    debris_restants: { ...debris },
  });
  console.log(`  ♻ ${arr.proprietaire}: recyclage sur ${flt.vers.planete} → ferrum=${pris.ferrum} lumen=${pris.lumen} (retour ${flt.duree_aller_utj || 1} UTJ)`);
}

console.log(`▸ Phase 5/6 — Combats & espionnage`);
const arrAttaques = arrivees.filter(a => a.flotte.type_mission === 'attaque');
const arrEspionnages = arrivees.filter(a => a.flotte.type_mission === 'espionnage');
if (arrAttaques.length === 0 && arrEspionnages.length === 0) {
  console.log(`  (aucune action militaire ne se résout ce tick)`);
}
for (const arr of arrEspionnages) {
  resolveEspionnage(arr.proprietaire, arr.flotte);
}
for (const arr of arrAttaques) {
  resolveAttack(arr.proprietaire, arr.flotte);
}

function resolveEspionnage(attackerName, fleet) {
  const cible = fleet.vers;
  const defEmp = empires[cible.joueur];
  if (!defEmp) return;
  const targetPlanet = (defEmp.planetes || []).find(p => p.nom === cible.planete);
  if (!targetPlanet) return;

  const sondesLancees = fleet.composition.sonde || 0;
  const techDef = (defEmp.recherche || {}).espionnage_profond || 0;

  // Contre-espionnage : chaque niveau détruit 1 sonde avec proba 0.20
  const probaKill = rules.espionnage?.proba_destruction_par_niveau ?? 0.20;
  let detruites = 0;
  for (let i = 0; i < techDef; i++) {
    if (rng() < probaKill) detruites++;
  }
  detruites = Math.min(detruites, sondesLancees);
  const sondesSurvivantes = sondesLancees - detruites;

  // Niveau d'intel
  const diff = sondesSurvivantes - techDef * 4;
  const paliers = rules.espionnage?.paliers || [1, 5, 25, 125, 625];
  let niveau = 0;
  for (const seuil of paliers) {
    if (diff >= seuil) niveau++;
    else break;
  }

  // Écrire le rapport pour l'attaquant
  writeIntelReport(attackerName, cible, targetPlanet, defEmp, niveau, sondesLancees, detruites);

  // Alerte au défenseur si sondes détectées (toute destruction = détecté)
  if (detruites > 0) {
    events.push({
      type: 'espionnage-detecte',
      cible_joueur: cible.joueur,
      cible_planete: cible.planete,
      attaquant: attackerName,
      sondes_detruites: detruites,
    });
    writeAlerteEspionnage(cible.joueur, cible.planete, attackerName, detruites);
  }

  // Renvoyer les sondes survivantes
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

  console.log(`  👁 ${attackerName} → ${cible.joueur}/${cible.planete} : niv ${niveau}/5 (${sondesSurvivantes}/${sondesLancees} sondes)`);
}

function writeIntelReport(att, cible, planete, defEmp, niveau, sondesLancees, detruites) {
  const fname = `joueurs/${att}/intel/tick-${String(tickSuivant).padStart(4, '0')}-${cible.joueur}-${cible.planete}.md`;
  const lines = [];
  lines.push('---');
  lines.push(`type: rapport-espionnage`);
  lines.push(`tick: ${tickSuivant}`);
  lines.push(`cible: { joueur: ${cible.joueur}, planete: ${cible.planete} }`);
  lines.push(`niveau_intel: ${niveau}`);
  lines.push(`sondes_lancees: ${sondesLancees}`);
  lines.push(`sondes_detruites: ${detruites}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Rapport d'espionnage — ${cible.joueur}/${cible.planete}`);
  lines.push('');
  lines.push(`Tick ${tickSuivant} · Niveau ${niveau}/5`);
  lines.push(`${sondesLancees} sondes lancées, ${detruites} interceptées.`);
  lines.push('');

  if (niveau === 0) {
    lines.push(`> ⚠ Toutes les sondes ont été détectées et détruites avant transmission utile.`);
    lines.push(`> Le défenseur **a été alerté** de la tentative d'intrusion.`);
  }

  if (niveau >= 1) {
    lines.push(`## Ressources`);
    lines.push('');
    for (const [r, info] of Object.entries(planete.ressources || {})) {
      lines.push(`- ${r} : **${(info.stock || 0).toLocaleString('fr-FR')}** (capacité ${(info.capacite || 0).toLocaleString('fr-FR')}, prod +${info.production_par_utj || 0}/UTJ)`);
    }
    lines.push('');
  }
  if (niveau >= 2) {
    lines.push(`## Flotte au sol`);
    lines.push('');
    const fl = planete.flotte_au_sol || {};
    if (Object.keys(fl).length === 0) lines.push('*aucune*');
    else for (const [t, n] of Object.entries(fl)) lines.push(`- ${t} : ${n.toLocaleString('fr-FR')}`);
    lines.push('');
  }
  if (niveau >= 3) {
    lines.push(`## Défenses`);
    lines.push('');
    const d = planete.defenses || {};
    if (Object.keys(d).length === 0) lines.push('*aucune*');
    else for (const [t, n] of Object.entries(d)) lines.push(`- ${t} : ${n.toLocaleString('fr-FR')}`);
    lines.push('');
  }
  if (niveau >= 4) {
    lines.push(`## Bâtiments`);
    lines.push('');
    for (const [b, niv] of Object.entries(planete.batiments || {})) {
      lines.push(`- ${b} : niveau ${niv}`);
    }
    lines.push('');
  }
  if (niveau >= 5) {
    lines.push(`## Recherches`);
    lines.push('');
    for (const [t, niv] of Object.entries(defEmp.recherche || {})) {
      lines.push(`- ${t} : niveau ${niv}`);
    }
    lines.push('');
  }
  wr(fname, lines.join('\n') + '\n');
}

function writeAlerteEspionnage(defenderName, planeteCible, att, detruites) {
  const fname = `joueurs/${defenderName}/intel/tick-${String(tickSuivant).padStart(4, '0')}-alerte.md`;
  const lines = [];
  lines.push('---');
  lines.push(`type: alerte-espionnage`);
  lines.push(`tick: ${tickSuivant}`);
  lines.push(`planete: ${planeteCible}`);
  lines.push(`attaquant: ${att}`);
  lines.push(`sondes_interceptees: ${detruites}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ⚠ Tentative d'espionnage interceptée`);
  lines.push('');
  lines.push(`Tick ${tickSuivant} · Planète **${planeteCible}**`);
  lines.push(`${detruites} sonde(s) appartenant à **${att}** ont été détectées et détruites par le contre-espionnage.`);
  wr(fname, lines.join('\n') + '\n');
}

function resolveAttack(attackerName, fleet) {
  const cible = fleet.vers;
  const defenderName = cible.joueur;
  const attEmp = empires[attackerName];
  const defEmp = empires[defenderName];
  if (!defEmp) {
    console.log(`  · attaque ${fleet.id}: défenseur ${defenderName} introuvable`);
    return;
  }
  const targetPlanet = (defEmp.planetes || []).find(p => p.nom === cible.planete);
  if (!targetPlanet) {
    console.log(`  · attaque ${fleet.id}: planète ${cible.planete} introuvable chez ${defenderName}`);
    return;
  }

  const attacker = {
    ships: { ...fleet.composition },
    tech: { ...(attEmp.recherche || {}) },
  };
  // Côté défenseur : flotte au sol + défenses (combinées dans une seule map de "ships")
  const defenderShips = {
    ...(targetPlanet.flotte_au_sol || {}),
    ...(targetPlanet.defenses || {}),
  };
  const defender = {
    ships: defenderShips,
    tech: { ...(defEmp.recherche || {}) },
  };

  const result = resolveCombat({ attacker, defender, rules, rng, defenseTypes: rules.defenses });

  // Appliquer pertes côté défenseur — séparer flotte vs défenses
  const oldFlotte = targetPlanet.flotte_au_sol || {};
  const oldDef = targetPlanet.defenses || {};
  targetPlanet.flotte_au_sol = {};
  targetPlanet.defenses = {};
  for (const [type, n] of Object.entries(result.defenseur_restant)) {
    if (oldDef[type] !== undefined) targetPlanet.defenses[type] = n;
    else targetPlanet.flotte_au_sol[type] = n;
  }

  // Champ de débris (somme des pertes des deux camps)
  const debrisAtt = computeDebris(attacker.ships, result.attaquant_restant, rules);
  const debrisDef = computeDebris(defender.ships, result.defenseur_restant, rules);
  const debris = {
    ferrum: debrisAtt.ferrum + debrisDef.ferrum,
    lumen: debrisAtt.lumen + debrisDef.lumen,
  };
  targetPlanet.champ_debris = targetPlanet.champ_debris || { ferrum: 0, lumen: 0 };
  targetPlanet.champ_debris.ferrum += debris.ferrum;
  targetPlanet.champ_debris.lumen += debris.lumen;

  // Pillage si victoire attaquant
  let pillage = { ferrum: 0, lumen: 0, plasmide: 0 };
  if (result.issue === 'victoire-attaquant') {
    const totalCargo = Object.entries(result.attaquant_restant).reduce((a, [t, n]) => {
      return a + n * (rules.vaisseaux[t]?.cargo || 0);
    }, 0);
    pillage = computePillage(targetPlanet.ressources, totalCargo, rules);
    for (const [r, n] of Object.entries(pillage)) {
      if (targetPlanet.ressources[r]) targetPlanet.ressources[r].stock -= n;
    }
  }

  // Renvoyer la flotte survivante de l'attaquant
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

  // Event public
  const totalPertesAtt = Object.entries(attacker.ships).reduce((a, [t, n]) =>
    a + (n - (result.attaquant_restant[t] || 0)), 0);
  const totalPertesDef = Object.entries(defender.ships).reduce((a, [t, n]) =>
    a + (n - (result.defenseur_restant[t] || 0)), 0);
  events.push({
    type: 'bataille',
    attaquant: attackerName,
    defenseur: defenderName,
    lieu: cible.planete,
    issue: result.issue,
    rondes: result.rondes.length,
    pertes_attaquant: totalPertesAtt,
    pertes_defenseur: totalPertesDef,
    pillage,
    debris,
  });

  writeBattleReport(attackerName, defenderName, cible, result, debris, pillage);

  console.log(`  ⚔ ${attackerName} → ${defenderName}/${cible.planete} : ${result.issue}`);
  console.log(`     ${result.rondes.length} ronde(s) · pertes A=${totalPertesAtt} D=${totalPertesDef} · débris ferrum=${debris.ferrum} lumen=${debris.lumen}`);
  if (result.issue === 'victoire-attaquant') {
    console.log(`     pillage : ferrum=${pillage.ferrum} lumen=${pillage.lumen} plasmide=${pillage.plasmide}`);
  }
}

function writeBattleReport(att, def, cible, result, debris, pillage) {
  const fname = `world/events/tick-${String(tickSuivant).padStart(4, '0')}-bataille-${cible.planete}.md`;
  const lines = [];
  lines.push('---');
  lines.push(`type: bataille`);
  lines.push(`tick: ${tickSuivant}`);
  lines.push(`attaquant: ${att}`);
  lines.push(`defenseur: ${def}`);
  lines.push(`lieu: { joueur: ${def}, planete: ${cible.planete} }`);
  lines.push(`issue: ${result.issue}`);
  lines.push(`rondes: ${result.rondes.length}`);
  lines.push(`debris: { ferrum: ${debris.ferrum}, lumen: ${debris.lumen} }`);
  lines.push(`pillage: { ferrum: ${pillage.ferrum}, lumen: ${pillage.lumen}, plasmide: ${pillage.plasmide} }`);
  lines.push('---');
  lines.push('');
  lines.push(`# Bataille de ${cible.planete} — tick ${tickSuivant}`);
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
  wr(fname, lines.join('\n') + '\n');
}

console.log(`▸ Phase 6/6 — Recalcul des scores`);
for (const [name, emp] of Object.entries(empires)) {
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

// ════════════════════════════════════════════════════════════════════════
// 6.  Écriture
// ════════════════════════════════════════════════════════════════════════

console.log(`\n▸ Écriture des fichiers`);

// Sérialisation canonique : clés triées récursivement → hash déterministe
// indépendamment de l'ordre d'insertion des objets JS.
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

// Hash chain : on récupère le tick_hash du tick précédent avant de muter
// le manifest. Pour le tout premier tick, on ancre sur "genesis".
const previousTickHash = manifest.tick_hash || 'genesis';

manifest.tick = tickSuivant;
manifest.previous_tick_hash = previousTickHash;
manifest.hash_etat = 'sha256:' + crypto.createHash('sha256')
  .update(canonicalJSON(empires) + canonicalJSON(galaxie))
  .digest('hex').slice(0, 32);

// tick_hash scelle ce tick : il dépend de previous_tick_hash, donc toute
// modification rétroactive d'un tick passé invalide la chaîne suivante.
delete manifest.tick_hash;
manifest.tick_hash = 'sha256:' + crypto.createHash('sha256')
  .update(canonicalJSON(manifest))
  .digest('hex');
wr('world/manifest.yaml', '# Généré par engine/tick.mjs — ne pas éditer.\n' + ystringify(manifest));

for (const [name, emp] of Object.entries(empires)) {
  emp.tick = tickSuivant;
  wr(`joueurs/${name}/empire.yaml`, '# Généré par engine/tick.mjs — ne pas éditer.\n' + ystringify(emp));
  wr(`joueurs/${name}/empire.md`, renderEmpireMd(emp));
}

if (events.length > 0) {
  let log = `# Tick ${tickSuivant} — ${events.length} événement(s)\n\n`;
  for (const e of events) log += `- **${e.type}** · ${JSON.stringify(e)}\n`;
  wr(`world/events/tick-${String(tickSuivant).padStart(4, '0')}.md`, log);
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

console.log(`\n✓ Tick ${tickSuivant} ${DRY ? 'simulé' : 'écrit'}.`);
console.log(`  ${events.length} événement(s).`);
console.log(`  ${Object.keys(empires).length} empire(s) mis à jour.`);
