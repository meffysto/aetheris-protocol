// client/fx.mjs — Feedbacks visuels & audio (vague 1 dopamine-revamp)
//
// Briques : floating numbers, screen shake, particle burst, achievement toast,
// post-tick event replay, injection des panneaux bridge/feed dans l'UI.
//
// Tout est pur DOM/CSS. Aucune dépendance externe. Compatible mobile.

// ─── Floating numbers ─────────────────────────────────────────────
export function floatNumber({ x, y, text, color = '#dad45e' }) {
  const span = document.createElement('span');
  span.className = 'fx-float';
  span.textContent = text;
  span.style.cssText = `left:${x}px;top:${y}px;color:${color}`;
  document.body.appendChild(span);
  setTimeout(() => span.remove(), 1200);
}

// ─── Screen shake ─────────────────────────────────────────────────
export function shake(el, intensity = 6) {
  if (!el) return;
  el.classList.add('fx-shake');
  el.style.setProperty('--shake-i', `${intensity}px`);
  setTimeout(() => {
    el.classList.remove('fx-shake');
    el.style.removeProperty('--shake-i');
  }, 400);
}

// ─── Particle burst ───────────────────────────────────────────────
export function burst({ x, y, count = 12, color = '#dad45e', spread = 60 }) {
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.3;
    const dist = spread * (0.6 + Math.random() * 0.8);
    p.className = 'fx-particle';
    p.style.cssText =
      `left:${x}px;top:${y}px;background:${color};color:${color};` +
      `--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist}px`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 800);
  }
}

// ─── Achievement toast (slide-in droite) ──────────────────────────
let achvToastStack = 0;
export function toastAchievement(a) {
  const t = document.createElement('div');
  t.className = 'achv-toast';
  t.style.top = `${80 + achvToastStack * 88}px`;
  achvToastStack++;
  t.innerHTML =
    `<span class="achv-icon">${escapeHtml(a.icon || '✦')}</span>` +
    `<div class="achv-body">` +
    `<b>${escapeHtml(a.title || 'Achievement')}</b>` +
    `<small>${escapeHtml(a.desc || '')}</small>` +
    `</div>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => {
    t.classList.remove('on');
    setTimeout(() => {
      t.remove();
      achvToastStack = Math.max(0, achvToastStack - 1);
    }, 400);
  }, 4500);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// ─── Post-tick replay : rejoue les events sensoriels ──────────────
// events = sous-ensemble de state.events (tableau de { kind, ... })
const SENSORY_KINDS = new Set([
  'bataille-resolue',
  'chantier-fini',
  'recherche-finie',
  'espionnage-detecte',
  'colonisation-reussie',
  'vaisseau-fini',
  'defense-finie',
  'recyclage-livre',
  'marche-match',
]);

export async function replayTickEvents(events, sfx) {
  if (!Array.isArray(events) || !events.length) return;
  const queue = events.filter(e => SENSORY_KINDS.has(e?.kind));
  if (!queue.length) return;
  for (const e of queue.slice(0, 8)) { // cap à 8 événements pour éviter spam
    await playOne(e, sfx);
    await sleep(380);
  }
}

async function playOne(e, sfx) {
  const main = document.getElementById('main');
  try {
    switch (e.kind) {
      case 'bataille-resolue':
        sfx?.boom?.();
        shake(main, 9);
        burstAt(centerOf(main), { count: 18, color: '#d04648', spread: 90 });
        break;
      case 'chantier-fini':
        sfx?.buildDone?.();
        pulseRail('qBat');
        break;
      case 'vaisseau-fini':
      case 'defense-finie':
        sfx?.buildDone?.();
        pulseRail('qAtl');
        break;
      case 'recherche-finie':
        sfx?.achievement?.();
        pulseRail('qRec');
        burstAt(centerOf(document.getElementById('rail')), { count: 10, color: '#6dc2ca' });
        break;
      case 'espionnage-detecte':
        sfx?.alert?.();
        shake(document.getElementById('bellBtn'), 4);
        break;
      case 'colonisation-reussie':
        sfx?.confirm?.();
        burstAt(centerOf(document.getElementById('planetHead')), { count: 24, color: '#dad45e', spread: 120 });
        break;
      case 'recyclage-livre':
        sfx?.confirm?.();
        break;
      case 'marche-match':
        sfx?.click?.();
        break;
    }
  } catch (err) { /* mute */ }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pulseRail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('fx-pulse-once');
  setTimeout(() => el.classList.remove('fx-pulse-once'), 700);
}

function centerOf(el) {
  if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function burstAt({ x, y }, opts) { burst({ x, y, ...opts }); }

// ─── Tick pulse audio : -10s avant tick, bip discret ──────────────
// Lit le countdown affiché dans #countdown ("prochain · 2m12s") ou #tickValue.
// Stratégie simple : poll toutes les 500ms, déclenche sur le mot "1s" / "0s".
let pulseTimer = null;
const playedThisTick = new Set();

export function startTickPulseAudio(sfx) {
  if (pulseTimer) return;
  pulseTimer = setInterval(() => {
    const cdEl = document.getElementById('countdown');
    const tickEl = document.getElementById('tickValue');
    if (!cdEl || !tickEl) return;
    const tick = (tickEl.textContent || '').trim();
    const cd = cdEl.textContent || '';
    // Format attendu : "prochain · 0m12s" ou similaire. On extrait les secondes.
    const m = cd.match(/(\d+)\s*m\s*(\d+)\s*s/) || cd.match(/(\d+)\s*s/);
    let totalSec = null;
    if (m) {
      totalSec = m[2] !== undefined ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10))
                                    : parseInt(m[1], 10);
    }
    if (totalSec === null || isNaN(totalSec)) return;
    // Bip à 10, 5, 4, 3, 2, 1
    const fireAt = [10, 5, 4, 3, 2, 1];
    for (const t of fireAt) {
      const key = `${tick}:${t}`;
      if (totalSec === t && !playedThisTick.has(key)) {
        playedThisTick.add(key);
        sfx?.tickPulse?.();
        // Reset l'ancien tick une fois écoulé
        if (playedThisTick.size > 30) {
          // Garbage simple : on garde les 12 derniers
          const arr = Array.from(playedThisTick);
          playedThisTick.clear();
          for (const k of arr.slice(-12)) playedThisTick.add(k);
        }
      }
    }
  }, 500);
}

// ─── Injection des panneaux bridge / feed ─────────────────────────
export function injectBridgePanel(bridge) {
  const overview = document.getElementById('vOverview');
  if (!overview) return false;
  if (overview.querySelector('.bridge-panel')) return true; // déjà injecté
  const wrap = document.createElement('div');
  wrap.innerHTML = bridge.renderBridgePanel();
  const node = wrap.firstElementChild;
  if (!node) return false;
  overview.appendChild(node);
  bridge.bindBridge(window.__sfx);
  return true;
}

export function injectFeedPanel(feed) {
  const rail = document.getElementById('rail');
  if (!rail) return false;
  if (rail.querySelector('#feedHost')) return true;
  const group = document.createElement('div');
  group.className = 'group dopamine-feed-group';
  group.innerHTML =
    `<h3>Galactique live</h3>` +
    `<div id="feedHost" class="feed-host">${feed.renderFeed(10)}</div>`;
  rail.appendChild(group);
  feed.onFeedChange(() => {
    const host = document.getElementById('feedHost');
    if (host) host.innerHTML = feed.renderFeed(10);
  });
  return true;
}
