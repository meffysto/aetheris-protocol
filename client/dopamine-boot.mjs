// client/dopamine-boot.mjs — Branchement non-cassant des modules de dopamine.
//
// Ce module est le point d'entrée unique du "Living Galaxy mode". Il importe
// dynamiquement (lazy) sfx, idle-clicker, achievements, feed, fx — qui
// existaient déjà dans client/ mais n'étaient PAS branchés dans app.js.
//
// Activation : localStorage.setItem('citadel.dopamine', '1') puis reload.
// Désactivation : flag à '0' (ou absent) → ce module ne charge RIEN, l'UI
// est strictement identique à la version main.
//
// ZÉRO impact sur le déterminisme on-chain :
//   - aucune mutation de state
//   - aucune inscription Bitcoin
//   - écoute via CustomEvent 'citadel:state-rebuilt' dispatché par app.js
//   - tout est cosmétique + localStorage

const FLAG = 'citadel.dopamine';

let booted = false;
let api = null;

export function dopamineEnabled() {
  return localStorage.getItem(FLAG) === '1';
}

export function setDopamineEnabled(on) {
  localStorage.setItem(FLAG, on ? '1' : '0');
}

export async function bootDopamine({ force = false } = {}) {
  if (booted && !force) return api;
  if (!dopamineEnabled() && !force) return { enabled: false };

  const [sfxMod, bridge, ach, feed, fx] = await Promise.all([
    import('./sfx.mjs'),
    import('./idle-clicker.mjs'),
    import('./achievements.mjs'),
    import('./feed.mjs'),
    import('./fx.mjs'),
  ]);

  sfxMod.setSfxEnabled(true);
  window.__sfx = sfxMod.sfx;

  // Hook post-rebuild : feed + achievements + replay events
  let prevTick = null;
  let prevEventCount = 0;
  window.addEventListener('citadel:state-rebuilt', (e) => {
    const { state, events } = e.detail || {};
    if (!state) return;

    try { feed.ingestState(state); } catch (err) { console.warn('[dopamine] feed', err); }

    try {
      const newly = ach.evaluateAchievements(state);
      for (const a of newly) {
        fx.toastAchievement(a);
        sfxMod.sfx.achievement();
      }
    } catch (err) { console.warn('[dopamine] achievements', err); }

    // Post-tick replay : si le tick a avancé, on rejoue les events
    const tick = state.manifest?.tick;
    if (prevTick !== null && tick > prevTick) {
      const newEvents = Array.isArray(events) ? events.slice(prevEventCount) : [];
      fx.replayTickEvents(newEvents, sfxMod.sfx);
    }
    prevTick = tick;
    prevEventCount = Array.isArray(events) ? events.length : 0;
  });

  // Injection de panneaux : bridge dans #vOverview, feed dans #rail.
  // On retente à chaque rebuild parce que app.js peut re-rendre la vue.
  let injected = false;
  const inject = () => {
    if (injected) return;
    const ok1 = fx.injectBridgePanel(bridge);
    const ok2 = fx.injectFeedPanel(feed);
    if (ok1 && ok2) injected = true;
  };
  window.addEventListener('citadel:state-rebuilt', inject);
  // Best-effort tentative au boot
  setTimeout(inject, 500);
  setTimeout(inject, 1500);

  // Tick countdown audio : pulse audible sur les dernières secondes du cycle
  fx.startTickPulseAudio(sfxMod.sfx);

  booted = true;
  api = { enabled: true, sfx: sfxMod.sfx, bridge, ach, feed, fx };
  console.log('[dopamine] boot OK — Living Galaxy mode actif');
  return api;
}

// Auto-boot si le flag est on (chargé via <script type="module"> dans le HTML).
if (typeof window !== 'undefined' && dopamineEnabled()) {
  bootDopamine().catch(e => console.warn('[dopamine] boot failed', e));
}
