// client/sfx.mjs — Web Audio synth pour SFX rétro
//
// Pas de fichiers audio. Tout est généré par AudioContext (oscillators +
// gain envelopes). Léger, instantané, et stylé "années 70 sci-fi" pour
// coller à l'esthétique Fraunces/JetBrains Mono de la console.
//
// Opt-in : `localStorage.setItem('citadel.sfx', '1')` pour activer.
// Toggle UI dans la cog wheel.

const ENABLED_KEY = 'citadel.sfx';

let ctx = null;
let master = null;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.18;
  master.connect(ctx.destination);
  return ctx;
}

export function sfxEnabled() {
  return localStorage.getItem(ENABLED_KEY) === '1';
}

export function setSfxEnabled(on) {
  localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  if (on) ensureCtx();
}

// Beep simple paramétrable.
function beep({ freq = 440, dur = 0.08, type = 'sine', vol = 1, sweep = 0 }) {
  if (!sfxEnabled()) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});

  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  if (sweep) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(40, freq + sweep), c.currentTime + dur
    );
  }
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(vol, c.currentTime + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  osc.connect(g).connect(master);
  osc.start();
  osc.stop(c.currentTime + dur + 0.02);
}

// Bruit blanc filtré (pour explosions, scans).
function noise({ dur = 0.2, vol = 0.6, lpHz = 1200, sweepHz = 0 }) {
  if (!sfxEnabled()) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});

  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
  const src = c.createBufferSource(); src.buffer = buf;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lpHz;
  if (sweepHz) lp.frequency.exponentialRampToValueAtTime(Math.max(60, lpHz + sweepHz), c.currentTime + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(vol, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  src.connect(lp).connect(g).connect(master);
  src.start();
  src.stop(c.currentTime + dur + 0.02);
}

// ─── Bibliothèque de sons sémantiques ─────────────────────────────
export const sfx = {
  tap()         { beep({ freq: 880, dur: 0.04, type: 'triangle', vol: 0.25 }); },
  hover()       { beep({ freq: 520, dur: 0.025, type: 'sine', vol: 0.10 }); },
  click()       { beep({ freq: 660, dur: 0.05, type: 'square', vol: 0.18 }); },
  confirm()     { beep({ freq: 740, dur: 0.10, type: 'triangle', vol: 0.30, sweep: +120 }); },
  cancel()      { beep({ freq: 320, dur: 0.10, type: 'sawtooth', vol: 0.18, sweep: -80 }); },
  tickPulse()   { beep({ freq: 220, dur: 0.18, type: 'sine', vol: 0.18, sweep: +60 }); },
  buildDone()   { beep({ freq: 440, dur: 0.06, type: 'square', vol: 0.22 });
                  setTimeout(() => beep({ freq: 660, dur: 0.06, type: 'square', vol: 0.22 }), 70);
                  setTimeout(() => beep({ freq: 880, dur: 0.12, type: 'triangle', vol: 0.30 }), 140); },
  fleetLaunch() { noise({ dur: 0.35, vol: 0.32, lpHz: 1800, sweepHz: -1200 }); },
  alert()       { beep({ freq: 1100, dur: 0.10, type: 'sawtooth', vol: 0.30 });
                  setTimeout(() => beep({ freq: 700, dur: 0.10, type: 'sawtooth', vol: 0.30 }), 130); },
  scan()        { noise({ dur: 0.22, vol: 0.18, lpHz: 600, sweepHz: +900 });
                  beep({ freq: 1500, dur: 0.18, type: 'sine', vol: 0.10, sweep: -700 }); },
  achievement() { beep({ freq: 523, dur: 0.10, type: 'triangle', vol: 0.28 });
                  setTimeout(() => beep({ freq: 659, dur: 0.10, type: 'triangle', vol: 0.28 }), 100);
                  setTimeout(() => beep({ freq: 784, dur: 0.10, type: 'triangle', vol: 0.28 }), 200);
                  setTimeout(() => beep({ freq: 1046, dur: 0.20, type: 'triangle', vol: 0.32 }), 300); },
  boom()        { noise({ dur: 0.5, vol: 0.45, lpHz: 2400, sweepHz: -2000 });
                  beep({ freq: 110, dur: 0.45, type: 'sawtooth', vol: 0.30, sweep: -60 }); },
};

// Premier-clic global pour débloquer l'AudioContext (politique navigateur).
let unlocked = false;
function unlockOnce() {
  if (unlocked) return; unlocked = true;
  const c = ensureCtx(); if (c && c.state === 'suspended') c.resume().catch(() => {});
}
window.addEventListener('pointerdown', unlockOnce, { once: true, passive: true });
window.addEventListener('keydown', unlockOnce, { once: true });
