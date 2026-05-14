// CITADEL // PROTOCOL — Chargeur de règles avec epochs (soft-fork).
//
// rules.yaml v2 supporte un système d'epochs à la Bitcoin :
//   - chaque epoch a un `activation_tick` (croissant strict)
//   - epoch[0] fournit un ruleset complet sous `rules:`
//   - les epochs suivants fournissent des `patches:` à clé dottée
//     (ex: "batiments.mine_ferrum.multiplicateur_duree": 1.4)
//
// À un tick T donné, `effectiveRulesAtTick(doc, T)` retourne le ruleset
// effectif en appliquant tous les patches des epochs ≤ T dans l'ordre.
//
// Backward-compat : si le document parsé n'a pas de clé `epochs`, il est
// traité comme un ruleset v1 (toujours actif, activation_tick = 0).
// Cela garde tous les anciens tests et fixtures fonctionnels.
//
// Le replay reste déterministe : tant que le YAML on-chain ne change pas,
// le ruleset retourné pour un tick T donné est identique d'un boot à l'autre.
// Voir docs/adr/0011-rules-epochs-soft-fork.md.

import { yparse } from './yaml-mini.mjs';

/**
 * Parse un texte YAML rules + normalise vers la forme epochs[].
 * Renvoie { version, epochs: [{ activation_tick, name, rules?, patches? }] }.
 * Valide l'ordre croissant strict des activation_tick et la présence d'un
 * epoch racine (rules) à activation_tick = 0.
 *
 * @param {string} yamlText
 * @returns {{ version: number, epochs: Array }}
 */
export function parseRulesDoc(yamlText) {
  const parsed = yparse(yamlText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('rules-loader: YAML vide ou invalide');
  }
  // V1 fallback : pas de clé epochs → ruleset legacy unique à tick 0.
  if (!Array.isArray(parsed.epochs)) {
    return {
      version: 1,
      epochs: [{ activation_tick: 0, name: 'legacy', rules: parsed }],
    };
  }
  const epochs = parsed.epochs;
  if (epochs.length === 0) throw new Error('rules-loader: epochs[] vide');
  // Premier epoch doit fournir un ruleset complet, pas des patches.
  if (!epochs[0].rules || typeof epochs[0].rules !== 'object') {
    throw new Error('rules-loader: epochs[0] doit définir `rules:` (ruleset racine)');
  }
  if (epochs[0].activation_tick !== 0) {
    throw new Error(`rules-loader: epochs[0].activation_tick doit être 0 (got ${epochs[0].activation_tick})`);
  }
  // Ordre strict croissant ; les suivants ont des patches (rules optionnel).
  for (let i = 1; i < epochs.length; i++) {
    const prev = epochs[i - 1].activation_tick;
    const cur = epochs[i].activation_tick;
    if (!Number.isInteger(cur)) {
      throw new Error(`rules-loader: epochs[${i}].activation_tick doit être un entier (got ${cur})`);
    }
    if (cur <= prev) {
      throw new Error(`rules-loader: epochs[${i}].activation_tick=${cur} ≤ précédent (${prev}) — l'ordre doit être strictement croissant`);
    }
    if (!epochs[i].patches && !epochs[i].rules) {
      throw new Error(`rules-loader: epochs[${i}] doit définir au moins \`patches:\` ou \`rules:\``);
    }
  }
  return { version: parsed.version ?? 2, epochs };
}

/**
 * Renvoie le ruleset effectif au tick T.
 * Algorithme : part du dernier epoch[i].rules ≤ T (généralement epoch[0]),
 * puis applique en séquence tous les patches des epochs > i et ≤ T.
 *
 * Si on rencontre un epoch ≤ T qui redéfinit `rules:` complet, il remplace
 * le ruleset courant (utile pour les hard-forks intentionnels) — mais le cas
 * normal est patches-only.
 *
 * @param {object|string} docOrYaml  doc parsé ou texte YAML brut
 * @param {number} tick
 * @returns {object} ruleset effectif (deep-cloné, mutation safe)
 */
export function effectiveRulesAtTick(docOrYaml, tick) {
  const doc = typeof docOrYaml === 'string' ? parseRulesDoc(docOrYaml) : docOrYaml;
  if (!Number.isFinite(tick) || tick < 0) {
    throw new Error(`rules-loader: tick invalide (${tick})`);
  }
  let rules = null;
  for (const epoch of doc.epochs) {
    if (epoch.activation_tick > tick) break;
    if (epoch.rules) {
      rules = deepClone(epoch.rules);
    }
    if (epoch.patches) {
      if (!rules) {
        throw new Error(`rules-loader: epoch "${epoch.name}" applique des patches sans ruleset racine préalable`);
      }
      applyPatches(rules, epoch.patches);
    }
  }
  if (!rules) {
    throw new Error(`rules-loader: aucun epoch actif au tick ${tick}`);
  }
  return rules;
}

/**
 * Applique un dictionnaire de patches { "a.b.c": value } sur target en place.
 * Les chemins sont des clés dottées ; chaque segment est un nom de propriété
 * (les segments ne peuvent pas contenir de point — c'est une limite explicite).
 * Si un segment intermédiaire n'existe pas, lève une erreur : un patch ne crée
 * pas de structure, il ne fait que retoucher des valeurs existantes.
 */
function applyPatches(target, patches) {
  for (const [path, value] of Object.entries(patches)) {
    const segs = path.split('.');
    let cur = target;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (cur[s] === undefined || cur[s] === null || typeof cur[s] !== 'object') {
        throw new Error(`rules-loader: patch "${path}" — segment "${segs.slice(0, i + 1).join('.')}" n'existe pas dans le ruleset`);
      }
      cur = cur[s];
    }
    // Clone la valeur patchée : si c'est un objet, on évite que des appels
    // ultérieurs à effectiveRulesAtTick (ou des mutations du ruleset retourné)
    // se reflètent dans `doc.epochs[i].patches`. Pour les scalaires, deepClone
    // est un no-op gratuit.
    cur[segs[segs.length - 1]] = deepClone(value);
  }
}

function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deepClone(v);
  return out;
}
