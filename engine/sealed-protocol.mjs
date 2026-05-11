// Protocole commit-reveal (option B : reveal à l'impact).
//
// Sealed (op_type 0x03, inscrit au tick T_depart) — champs publics :
//   type: sealed
//   version: 1
//   joueur: <name>
//   tick_depart: <int>          // tick auquel le sceau est enregistré
//   planete_origine: <name>     // d'où partira la flotte (visible)
//   kind: militaire             // catégorie large (militaire | renseignement)
//   hash: <hex64>               // sha256(canonicalJSON(reveal.secret))
//
// Le tick d'impact n'est PAS déclaré au sealing : il dérive automatiquement
// de la distance(origine, cible) et de la vitesse min de la flotte révélée.
// Le défenseur n'apprend NI distance, NI vitesse, NI cible avant le reveal.
//
// Reveal (op_type 0x04, inscrit au tick T_impact) :
//   type: reveal
//   version: 1
//   joueur: <name>
//   tick_impact: <int>
//   sealed_txid: <hex>          // référence vers le commit
//   secret:
//     type: attaque             // (v1 : attaque uniquement)
//     depuis: <planete>
//     cible: { joueur, planete }
//     flotte: { ... }
//     vitesse: <int>
//     nonce: <hex16>
//
// Le moteur vérifie au reveal :
//   1. sha256(canonicalJSON(reveal.secret)) === sealed.hash
//   2. secret.depuis === sealed.planete_origine
//   3. reveal.tick_impact === sealed.tick_depart + ceil(distance(origine, cible) / vMin(flotte) * 100 / UTJ_PAR_TICK)
//      (physique du vol : le joueur ne peut pas révéler à un tick arbitraire)
//
// Si tout matche → combat se résout au tick_impact.
// Si non-reveal après MAX_PATIENCE ticks → sceau expire en forfait (v1 : sans coût).

import { sha256 } from '@noble/hashes/sha256';
import { canonicalJSON } from './tick-core.mjs';

const ALLOWED_KINDS = new Set(['militaire']);
const ALLOWED_SECRET_TYPES = new Set(['attaque']); // v1 : attaque uniquement

// Patience max d'un sceau non révélé. Si tickSuivant - sealed.tick_depart
// dépasse cette valeur, le sceau expire en forfait. À 30 blocs/tick (mutinynet)
// = 15 min/tick, 1000 ticks = ~10 jours de patience. Couvre largement les
// attaques inter-galaxies les plus lentes (dreadnought 2500 sur 60000 distance
// ≈ 240000 UTJ = 40000 ticks à 6 UTJ/tick → en pratique on capera côté gameplay).
export const SEALED_MAX_PATIENCE_TICKS = 1000;

/**
 * Hash canonique d'un secret de reveal. Utilisé à la fois côté client
 * (pour construire le sealed) et côté moteur (pour vérifier le reveal).
 *
 * @param {object} secret  Le bloc `secret:` du reveal.
 * @returns {string} hex64 sha256.
 */
export function computeSealHash(secret) {
  const json = canonicalJSON(secret);
  const bytes = sha256(new TextEncoder().encode(json));
  let h = '';
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0');
  return h;
}

/**
 * Valide la forme d'un sealed parsé. Retourne null si OK, sinon string d'erreur.
 */
export function validateSealedShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'sealed: not an object';
  if (parsed.type !== 'sealed') return `sealed: type=${parsed.type}, attendu 'sealed'`;
  if (parsed.version !== 1) return `sealed: version=${parsed.version}, attendu 1`;
  if (typeof parsed.joueur !== 'string' || !parsed.joueur) return 'sealed: joueur manquant';
  if (!Number.isInteger(parsed.tick_depart)) return 'sealed: tick_depart manquant';
  if (typeof parsed.planete_origine !== 'string' || !parsed.planete_origine) return 'sealed: planete_origine manquante';
  if (!ALLOWED_KINDS.has(parsed.kind)) return `sealed: kind '${parsed.kind}' non supporté`;
  if (typeof parsed.hash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.hash)) return 'sealed: hash invalide (attendu hex64)';
  return null;
}

/**
 * Valide la forme d'un reveal parsé. Retourne null si OK, sinon string d'erreur.
 */
export function validateRevealShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'reveal: not an object';
  if (parsed.type !== 'reveal') return `reveal: type=${parsed.type}, attendu 'reveal'`;
  if (parsed.version !== 1) return `reveal: version=${parsed.version}, attendu 1`;
  if (typeof parsed.joueur !== 'string' || !parsed.joueur) return 'reveal: joueur manquant';
  if (!Number.isInteger(parsed.tick_impact)) return 'reveal: tick_impact manquant';
  if (typeof parsed.sealed_txid !== 'string' || !parsed.sealed_txid) return 'reveal: sealed_txid manquant';
  const s = parsed.secret;
  if (!s || typeof s !== 'object') return 'reveal: secret manquant';
  if (!ALLOWED_SECRET_TYPES.has(s.type)) return `reveal: secret.type '${s.type}' non supporté (v1: attaque)`;
  if (typeof s.depuis !== 'string' || !s.depuis) return 'reveal: secret.depuis manquant';
  if (!s.cible || typeof s.cible.joueur !== 'string' || typeof s.cible.planete !== 'string') return 'reveal: secret.cible invalide';
  if (!s.flotte || typeof s.flotte !== 'object') return 'reveal: secret.flotte manquant';
  if (typeof s.nonce !== 'string' || !s.nonce) return 'reveal: secret.nonce manquant';
  return null;
}
