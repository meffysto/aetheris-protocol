// client/achievements.mjs — Badges/quêtes locaux
//
// PROBLÈME : un joueur qui débarque ne sait pas quoi faire. Le tutoriel
// montre la première mine, mais ensuite ? Pas de "progression visible"
// par-dessus l'économie OGame.
//
// SOLUTION : un système d'achievements LOCAUX (localStorage), évalués à
// chaque render sur le state on-chain. Pas inscrits ⇒ pas de coût ⇒
// libre d'ajouter. Le joueur voit débloquer des badges visuels qui
// font "ding" et augmentent un compteur (vanity).
//
// Liste des achievements ci-dessous. Chacun a une `check(state, emp, p)`
// pure (state-only, pas d'I/O).

const KEY = 'citadel.achievements.v1';

// Catalogue des achievements
export const ACHIEVEMENTS = [
  {
    id: 'first_join',
    title: 'Premier souffle',
    desc: 'Tu existes sur la chaîne. Bienvenue dans la galaxie.',
    icon: '✦',
    check: (s, emp) => !!emp,
  },
  {
    id: 'first_mine',
    title: 'Première extraction',
    desc: 'Améliore une mine de ferrum au niveau 2.',
    icon: '⛏',
    check: (s, emp, p) => (p?.batiments?.mine_ferrum || 0) >= 2,
  },
  {
    id: 'mine_5',
    title: 'Foreur confirmé',
    desc: 'Une mine de ferrum atteint le niveau 5.',
    icon: '◆',
    check: (s, emp, p) => (p?.batiments?.mine_ferrum || 0) >= 5,
  },
  {
    id: 'mine_10',
    title: 'Magnat du fer',
    desc: 'Une mine de ferrum atteint le niveau 10.',
    icon: '★',
    check: (s, emp, p) => (p?.batiments?.mine_ferrum || 0) >= 10,
  },
  {
    id: 'first_research',
    title: 'Premier breakthrough',
    desc: 'Termine ta première recherche.',
    icon: '✧',
    check: (s, emp) => Object.values(emp?.recherche || {}).some(v => v > 0),
  },
  {
    id: 'first_fleet',
    title: 'Forces stellaires',
    desc: 'Construit ton premier vaisseau.',
    icon: '➹',
    check: (s, emp, p) => Object.values(p?.flotte_au_sol || {}).some(v => v > 0),
  },
  {
    id: 'first_lab',
    title: 'Labos opérationnels',
    desc: 'Construit un laboratoire.',
    icon: '⚗',
    check: (s, emp, p) => (p?.batiments?.laboratoire || 0) >= 1,
  },
  {
    id: 'first_shipyard',
    title: 'Premier dock',
    desc: 'Construit un chantier spatial.',
    icon: '⚒',
    check: (s, emp, p) => (p?.batiments?.chantier_spatial || 0) >= 1,
  },
  {
    id: 'colonist',
    title: 'Colon',
    desc: 'Possède une seconde planète.',
    icon: '✶',
    check: (s, emp) => (emp?.planetes?.length || 0) >= 2,
  },
  {
    id: 'imperator',
    title: 'Imperator',
    desc: 'Possède 5 planètes.',
    icon: '✪',
    check: (s, emp) => (emp?.planetes?.length || 0) >= 5,
  },
  {
    id: 'tactician',
    title: 'Tacticien',
    desc: 'Lance une mission scellée (commit-reveal).',
    icon: '⚙',
    check: (s, emp) => {
      const sp = s?.manifest?.sealedPending || {};
      const me = s?.current;
      return Object.values(sp).some(x => x?.joueur === me);
    },
  },
  {
    id: 'spy',
    title: 'Œil galactique',
    desc: 'Recherche espionnage profond.',
    icon: '◉',
    check: (s, emp) => (emp?.recherche?.espionnage_profond || 0) >= 1,
  },
  {
    id: 'energetic',
    title: 'Réseau autonome',
    desc: 'Production énergie ≥ consommation sur ta planète principale.',
    icon: '⚡',
    check: (s, emp, p) => {
      const e = p?.energie;
      return e && e.production >= e.consommation && e.production > 0;
    },
  },
  {
    id: 'wealthy',
    title: 'Caisses pleines',
    desc: 'Stock ≥ 1M en ferrum sur une planète.',
    icon: '◊',
    check: (s, emp, p) => (p?.ressources?.ferrum || 0) >= 1_000_000,
  },
  {
    id: 'top10',
    title: 'Top 10 galactique',
    desc: 'Apparais dans le top 10 du classement (score).',
    icon: '✦',
    check: (s, emp) => {
      const me = s?.current;
      if (!me) return false;
      const scored = Object.entries(s.players || {})
        .map(([n, e]) => ({ n, score: scoreOf(e) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      return scored.some(x => x.n === me);
    },
  },
];

function scoreOf(emp) {
  if (!emp) return 0;
  let s = 0;
  for (const p of (emp.planetes || [])) {
    for (const v of Object.values(p.batiments || {})) s += (v | 0) * 100;
    for (const v of Object.values(p.flotte_au_sol || {})) s += (v | 0) * 10;
  }
  for (const v of Object.values(emp.recherche || {})) s += (v | 0) * 200;
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { unlocked: {} };
    return JSON.parse(raw);
  } catch { return { unlocked: {} }; }
}
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} }

let store = load();
const listeners = new Set();
function emit() { for (const fn of listeners) try { fn(store); } catch {} }
export function onAchievementsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Évalue les achievements contre le state. Retourne la liste des
// achievements DÉBLOQUÉS dans cette passe (pour pop-up notification).
export function evaluateAchievements(state) {
  if (!state?.current) return [];
  const emp = state.players[state.current];
  const p = emp?.planetes?.[0];
  const newly = [];
  for (const a of ACHIEVEMENTS) {
    if (store.unlocked[a.id]) continue;
    try {
      if (a.check(state, emp, p)) {
        store.unlocked[a.id] = { tick: state.manifest?.tick ?? 0, at: Date.now() };
        newly.push(a);
      }
    } catch {}
  }
  if (newly.length) { save(store); emit(); }
  return newly;
}

export function listAchievements() {
  return ACHIEVEMENTS.map(a => ({
    ...a,
    unlocked: !!store.unlocked[a.id],
    unlockedAt: store.unlocked[a.id]?.at,
    unlockedTick: store.unlocked[a.id]?.tick,
  }));
}

export function unlockedCount() {
  return Object.keys(store.unlocked).length;
}

export function resetAchievements() {
  store = { unlocked: {} }; save(store); emit();
}
