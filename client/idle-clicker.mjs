// client/idle-clicker.mjs — Mini-jeu "Pont de commandement"
//
// PROBLÈME : les ticks Citadel sont à 15 min. Entre deux ticks, le joueur
// n'a strictement RIEN à faire (ses ordres sont inscrits, l'engine n'a
// pas encore avancé). C'est mortel pour la rétention.
//
// SOLUTION : un mini-jeu de clicker LOCAL, totalement déconnecté du
// déterminisme on-chain. Il fait gagner :
//   - de l'XP "commandant" (purement cosmétique : titres, rangs)
//   - des "rations tactiques" (consommable LOCAL → boost UI à durée fixe)
//
// PRINCIPE : tu cliques sur la planète au centre du HUD. Chaque tap
// déclenche un "scan" (sfx + animation) et incrémente le compteur.
// Tous les 10 taps = +1 ration, tous les 100 = +1 rang.
//
// PERSISTENCE : localStorage uniquement. ZÉRO impact sur l'engine, ZÉRO
// inscription, ZÉRO question de déterminisme. C'est pur fluff cosmétique
// — le seul "vrai" gameplay reste les ordres on-chain.

const KEY = 'citadel.bridge.v1';

const RANK_THRESHOLDS = [
  { taps: 0,      rang: 'cadet',         emoji: '◦' },
  { taps: 100,    rang: 'aspirant',      emoji: '○' },
  { taps: 500,    rang: 'enseigne',      emoji: '◐' },
  { taps: 2000,   rang: 'lieutenant',    emoji: '●' },
  { taps: 6000,   rang: 'capitaine',     emoji: '◆' },
  { taps: 15000,  rang: 'commandeur',    emoji: '★' },
  { taps: 40000,  rang: 'amiral',        emoji: '✦' },
  { taps: 100000, rang: 'grand-amiral',  emoji: '✧' },
];

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { taps: 0, rations: 0, combo: 0, lastTap: 0 };
    const v = JSON.parse(raw);
    return {
      taps: v.taps | 0,
      rations: v.rations | 0,
      combo: v.combo | 0,
      lastTap: v.lastTap | 0,
    };
  } catch { return { taps: 0, rations: 0, combo: 0, lastTap: 0 }; }
}

function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

let state = load();
const listeners = new Set();
function emit() { for (const fn of listeners) try { fn(state); } catch {} }

export function getBridgeState() { return { ...state, ...rankFor(state.taps) }; }

export function onBridgeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function rankFor(taps) {
  let cur = RANK_THRESHOLDS[0];
  let next = null;
  for (let i = 0; i < RANK_THRESHOLDS.length; i++) {
    if (RANK_THRESHOLDS[i].taps <= taps) cur = RANK_THRESHOLDS[i];
    else { next = RANK_THRESHOLDS[i]; break; }
  }
  const prev = cur.taps;
  const span = next ? next.taps - prev : 1;
  const pct = next ? Math.min(1, (taps - prev) / span) : 1;
  return { rang: cur.rang, rangEmoji: cur.emoji, rangPct: pct, rangNext: next };
}

export function tap() {
  const now = Date.now();
  const dt = now - (state.lastTap || 0);
  // Combo : tap dans les 800ms ⇒ +1 streak
  if (dt < 800) state.combo = Math.min(99, state.combo + 1);
  else state.combo = 1;
  const gain = 1 + Math.floor(state.combo / 10);
  state.taps += gain;
  state.lastTap = now;
  // Tous les 10 taps : +1 ration
  if (Math.floor((state.taps - gain) / 10) !== Math.floor(state.taps / 10)) {
    state.rations += 1;
  }
  save(state);
  emit();
  return { gain, combo: state.combo, ...rankFor(state.taps) };
}

export function consumeRation() {
  if (state.rations <= 0) return false;
  state.rations -= 1;
  save(state);
  emit();
  return true;
}

export function resetBridge() {
  state = { taps: 0, rations: 0, combo: 0, lastTap: 0 };
  save(state);
  emit();
}

// Décrément du combo si inactif > 800ms (côté UI à appeler depuis un raf)
export function decayCombo() {
  if (state.combo > 0 && Date.now() - state.lastTap > 1200) {
    state.combo = 0;
    emit();
  }
}

// ─── Rendu HTML du panel (injecté dans la vue Overview) ──────────
export function renderBridgePanel() {
  const s = getBridgeState();
  const pct = Math.round(s.rangPct * 100);
  const nextLbl = s.rangNext
    ? `${s.rangNext.taps - s.taps} pour ${s.rangNext.rang}`
    : 'rang maximal atteint';
  const comboCls = s.combo >= 10 ? 'bridge-combo on' : 'bridge-combo';
  return `
<section class="bridge-panel">
  <header class="bridge-head">
    <div class="bridge-title">
      <span class="bridge-icon" aria-hidden="true">${s.rangEmoji}</span>
      <span class="bridge-rang">${s.rang}</span>
    </div>
    <div class="bridge-stats">
      <span><b>${s.taps.toLocaleString('fr-FR')}</b> scans</span>
      <span><b>${s.rations}</b> rations</span>
    </div>
  </header>
  <div class="bridge-arena">
    <button class="bridge-orb" id="bridgeOrb" type="button" aria-label="scanner la planète">
      <span class="bridge-orb-core"></span>
      <span class="bridge-orb-pulse"></span>
    </button>
    <div class="${comboCls}" id="bridgeCombo">×${Math.max(1, s.combo)}</div>
    <div class="bridge-fx" id="bridgeFx"></div>
  </div>
  <div class="bridge-progress" title="${nextLbl}">
    <div class="bridge-bar" style="width:${pct}%"></div>
  </div>
  <p class="bridge-foot">
    <b>Pont de commandement.</b> Scanne ton système pour gagner rang et rations (cosmétique).
    Reste actif entre les ticks — l'engine canonique <em>n'en sait rien</em>.
  </p>
</section>`;
}

// Bind interactions (à appeler à chaque render qui a re-injecté le panel)
export function bindBridge(sfx) {
  const orb = document.getElementById('bridgeOrb');
  const fx = document.getElementById('bridgeFx');
  if (!orb || !fx) return;
  if (orb.dataset.bound === '1') return;
  orb.dataset.bound = '1';

  orb.addEventListener('pointerdown', (e) => {
    const r = tap();
    sfx?.tap?.();
    // Spawn une particule depuis le centre vers la position du clic
    const rect = orb.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const span = document.createElement('span');
    span.className = 'bridge-spark';
    span.textContent = `+${r.gain}`;
    span.style.left = x + 'px';
    span.style.top = y + 'px';
    fx.appendChild(span);
    setTimeout(() => span.remove(), 800);

    // Update panel sans full re-render
    const titleEl = orb.closest('.bridge-panel');
    if (titleEl) {
      const taps = titleEl.querySelector('.bridge-stats b');
      const rations = titleEl.querySelectorAll('.bridge-stats b')[1];
      const combo = titleEl.querySelector('#bridgeCombo');
      const bar = titleEl.querySelector('.bridge-bar');
      const rangEl = titleEl.querySelector('.bridge-rang');
      const iconEl = titleEl.querySelector('.bridge-icon');
      if (taps) taps.textContent = r.taps?.toLocaleString?.('fr-FR') ?? getBridgeState().taps.toLocaleString('fr-FR');
      const st = getBridgeState();
      if (taps) taps.textContent = st.taps.toLocaleString('fr-FR');
      if (rations) rations.textContent = st.rations;
      if (combo) {
        combo.textContent = '×' + Math.max(1, st.combo);
        combo.classList.toggle('on', st.combo >= 10);
      }
      if (bar) bar.style.width = Math.round(st.rangPct * 100) + '%';
      if (rangEl) rangEl.textContent = st.rang;
      if (iconEl) iconEl.textContent = st.rangEmoji;
    }

    // Rang franchi : sfx achievement
    if (r.rangNext && r.taps >= (r.rangNext.taps || Infinity)) {
      sfx?.achievement?.();
    }
  }, { passive: true });

  // Décrément du combo (RAF doux)
  if (!window.__bridgeDecayRAF) {
    const loop = () => { decayCombo(); window.__bridgeDecayRAF = requestAnimationFrame(loop); };
    window.__bridgeDecayRAF = requestAnimationFrame(loop);
  }
}
