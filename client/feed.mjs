// client/feed.mjs — Fil d'actualité galactique en temps réel
//
// PROBLÈME : le jeu actuel est sourd-muet. Tu ne vois RIEN de ce que les
// autres joueurs font. C'est dramatique pour un MMO : pas de FOMO, pas
// de social proof, pas de "vibe" galactique.
//
// SOLUTION : un fil d'actualité scrolling qui montre les événements
// publics dérivés du state on-chain :
//   - nouveaux joueurs ayant join
//   - colonisations (nouvelles planètes occupées)
//   - flottes en vol (sans révéler la cible si sealed)
//   - batailles passées
//   - sceaux apparus (juste l'origine + tick → suspense)
//
// Source : entièrement dérivé de `state` (qui est déjà calculé par le
// replay déterministe). Pas de scan supplémentaire, pas d'I/O, juste de
// l'observation.
//
// PERSISTENCE : un anneau circulaire en mémoire (50 items) avec
// dédup par eventId. Si l'utilisateur F5, on perd le fil — c'est OK,
// il sera reconstruit au prochain rebuild.

const RING_SIZE = 80;
const ring = [];

function pushEvt(ev) {
  // Dédup par id (basé sur tick + type + sujet)
  if (ring.some(e => e.id === ev.id)) return;
  ring.unshift(ev);
  if (ring.length > RING_SIZE) ring.length = RING_SIZE;
  for (const fn of listeners) try { fn(ring); } catch {}
}

const listeners = new Set();
export function onFeedChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function getFeed() { return ring.slice(); }

const seen = new Set();

// Inspecte le `state` à chaque tick et émet de nouveaux events.
export function ingestState(state) {
  if (!state?.manifest) return;
  const tick = state.manifest.tick;
  const players = state.players || {};
  const galaxie = state.galaxie || {};

  // 1) Joueurs apparus (présents dans state.players mais jamais "vus")
  for (const name of Object.keys(players)) {
    const seenKey = `join:${name}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    // Le premier render après load voit TOUS les joueurs : on ne pousse
    // que si on a déjà fait au moins un ingest (boot ≠ event).
    if (seen.has('__bootstrap__')) {
      pushEvt({
        id: `${tick}-${seenKey}`,
        tick, kind: 'join', who: name,
        text: `<b>${esc(name)}</b> rejoint la galaxie.`,
      });
    }
  }
  seen.add('__bootstrap__');

  // 2) Sceaux (sealedPending) — on dévoile uniquement l'origine + tick
  const sealed = state.manifest?.sealedPending || {};
  for (const [hash, sp] of Object.entries(sealed)) {
    const k = `seal:${hash}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pushEvt({
      id: `${tick}-${k.slice(0, 24)}`,
      tick: sp.tick_depart || tick, kind: 'sealed', who: sp.joueur,
      text: `<b>${esc(sp.joueur || '?')}</b> scelle une opération depuis <em>${esc(sp.planete_origine || '?')}</em>.`,
    });
  }

  // 3) Flottes en vol publiques (transport, recyclage, colonisation,
  //    espionnage non-sealed). Les missions hostiles non-sealed
  //    apparaissent aussi (rare en pratique, mais informatif).
  for (const [name, emp] of Object.entries(players)) {
    for (const f of (emp.flottes_en_vol || [])) {
      const k = `fleet:${name}:${f.depuis?.planete}:${f.vers?.planete}:${f.tick_arrivee}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const t = (f.type_mission || '').toLowerCase();
      const label = ({
        transport: 'envoie un convoi',
        colonisation: 'lance une expédition coloniale',
        recyclage: 'envoie un recycleur',
        retour: 'rappelle une flotte',
        espionnage: 'envoie une sonde',
        attaque: 'envoie une flotte d\'attaque',
        siege: 'pose un siège',
        pillage: 'lance un raid',
        bombardement: 'ordonne un bombardement',
      })[t] || `lance une mission (${t})`;
      pushEvt({
        id: `${tick}-${k.slice(0, 32)}`,
        tick, kind: 'fleet', who: name,
        text: `<b>${esc(name)}</b> ${label} <em>${esc(f.depuis?.planete || '?')}</em> → <em>${esc(f.vers?.planete || '?')}</em>.`,
      });
    }
  }

  // 4) Nouvelles planètes colonisées (apparues dans galaxie avec un
  //    propriétaire qu'on n'a jamais vu pour ce nom)
  for (const [coord, sys] of Object.entries(galaxie.systemes || {})) {
    for (const [i, pos] of Object.entries(sys.positions || {})) {
      if (pos?.type === 'planete' && pos.proprietaire && pos.nom) {
        const k = `colo:${pos.nom}:${pos.proprietaire}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (seen.has('__bootstrap__galaxie__')) {
          pushEvt({
            id: `${tick}-${k.slice(0, 32)}`,
            tick, kind: 'colo', who: pos.proprietaire,
            text: `<b>${esc(pos.proprietaire)}</b> revendique <em>${esc(pos.nom)}</em> en <code>${esc(coord + ':' + i)}</code>.`,
          });
        }
      }
    }
  }
  seen.add('__bootstrap__galaxie__');
}

// ─── Rendu ────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
}

const kindIcon = {
  join:   '➤',
  sealed: '⚙',
  fleet:  '➹',
  colo:   '✦',
  battle: '⚔',
};

export function renderFeed(limit = 12) {
  const items = ring.slice(0, limit);
  if (items.length === 0) {
    return `<div class="feed-empty">silence radio — aucun événement détecté</div>`;
  }
  return `<ul class="feed-list">${
    items.map(e => `
      <li class="feed-item feed-${e.kind}">
        <span class="feed-icon" aria-hidden="true">${kindIcon[e.kind] || '·'}</span>
        <span class="feed-tick">T${e.tick}</span>
        <span class="feed-text">${e.text}</span>
      </li>`).join('')
  }</ul>`;
}
