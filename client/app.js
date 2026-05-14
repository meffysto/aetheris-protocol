/* ───────────────────────────── YAML mini parser ─────────────────────────── */
function yparse(text) {
  const lines = text.split('\n').filter(l => !/^\s*#/.test(l)).map(l => l.replace(/\s+#.*$/, ''));
  let i = 0;
  function readBlock(indent) {
    const out = {}; let firstKey = true;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const ind = line.match(/^ */)[0].length;
      if (ind < indent) return out;
      if (ind > indent && firstKey) return readBlock(ind);
      const m = line.slice(ind).match(/^"?([\w:.\-]+)"?\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const [, k, rest] = m; i++;
      if (rest === '') {
        if (i < lines.length && /^\s*-\s/.test(lines[i])) out[k] = readList(ind + 2);
        else out[k] = readBlock(ind + 2);
      } else if (rest.startsWith('[') || rest.startsWith('{')) {
        out[k] = readInline(rest);
      } else { out[k] = parseScalar(rest); }
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
      const rest = line.slice(ind + 2); i++;
      if (rest.includes(':') && !rest.startsWith('{')) {
        const m = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
        const item = {};
        if (m && m[2] === '') item[m[1]] = readBlock(ind + 4);
        else if (m) item[m[1]] = parseScalar(m[2]);
        Object.assign(item, readBlock(ind + 2));
        out.push(item);
      } else if (rest.startsWith('{')) { out.push(readInline(rest)); }
      else { out.push(parseScalar(rest)); }
    }
    return out;
  }
  function splitTopLevel(s, sep) {
    const out = []; let depth = 0, start = 0;
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === sep && depth === 0) { out.push(s.slice(start, j).trim()); start = j + 1; }
    }
    const last = s.slice(start).trim();
    if (last) out.push(last);
    return out;
  }
  function readInline(s) {
    s = s.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim(); if (!inner) return [];
      return splitTopLevel(inner, ',').map(t => parseScalar(t));
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1).trim(); if (!inner) return {};
      const out = {};
      for (const part of splitTopLevel(inner, ',')) {
        const colon = part.indexOf(':'); if (colon < 0) continue;
        const k = part.slice(0, colon).trim().replace(/^["']|["']$/g, '');
        out[k] = parseScalar(part.slice(colon + 1).trim());
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

/* ───────────────────────────── State ────────────────────────────────────── */
const state = {
  manifest: null,
  galaxie: null,
  rules: null,
  players: {},
  current: null, // résolu dans render() par la pubkey Schnorr du wallet
  view: localStorage.getItem('aetheris.view') || 'overview',
  source: 'bitcoin',
  pending: new Set(),
  bitcoin: null,                      // { tip, blocGenesis, tickCourant, ... } setté par load()
  // Pré-charge un wallet stocké en clair (legacy) ; les wallets chiffrés sont
  // chargés à la volée via getBitcoinWallet (qui demande le password).
  wallet: (function(){
    try {
      const v = JSON.parse(localStorage.getItem('aetheris.btc.wallet') || 'null');
      return v && !v.encrypted && v.privateKeyWIF ? v : null;
    } catch { return null; }
  })(),
  walletPassword: null,               // password en mémoire (volatile, ré-demandé chaque session)
  identites: {},
  reports: { intelByPlayer: {}, alertsByPlayer: {}, battles: [] },
};

// Repo et branche canoniques — hardcodes. Ils ne sont plus exposes dans l'UI
// pour eviter qu'un joueur pointe par erreur vers son propre fork.
const UPSTREAM_REPO = 'meffysto/aetheris-protocol';
const UPSTREAM_BRANCH = 'main';
// OAuth Device Flow — meme app/proxy que join.html. Le token recu va dans
// localStorage 'aetheris.gh.pat' (peu importe son origine, c'est un Bearer
// token GitHub). Plus aucune creation manuelle de PAT exigee du joueur.
const OAUTH_CLIENT_ID = 'Ov23li7ZHGzhrDKFTeXl';
const OAUTH_PROXY = 'https://aetheris-oauth-proxy.meffysto.workers.dev';
const cfg = {
  get repo()   { return UPSTREAM_REPO; },
  set repo(_)  { /* hardcode, no-op */ },
  get branch() { return UPSTREAM_BRANCH; },
  set branch(_){ /* hardcode, no-op */ },
  get pat()    { return localStorage.getItem('aetheris.gh.pat')    || ''; },
  set pat(v)   { v ? localStorage.setItem('aetheris.gh.pat', v)    : localStorage.removeItem('aetheris.gh.pat'); },
  get key()    { return localStorage.getItem('aetheris.gh.key')    || ''; },
  set key(v)   { v ? localStorage.setItem('aetheris.gh.key', v)    : localStorage.removeItem('aetheris.gh.key'); },
  // Mode Bitcoin-native : seul le wallet taproot suffit. La pubkey Schnorr
  // qui signe la TX est l'identité du joueur (vérifiée par le boot au scan).
  get ready()  { return !!(state?.wallet?.privateKeyWIF); },
};

/* ───────────────────────────── Iconography ──────────────────────────────── */
const icons = {
  ferrum: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 21l5-5M7 17l-3-3M9 15l5-5M14 10l4 4M14 10l-3-3 4-4 9 9-4 4-3-3"/></svg>`,
  lumen:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>`,
  plasmide:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 3h6M10 3v5l-4 11a3 3 0 003 4h6a3 3 0 003-4l-4-11V3"/><path d="M7 14h10"/></svg>`,
  energie: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>`,

  mine_ferrum: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 21l8-8M11 13l3-3-2-2 5-5 4 4-5 5-2-2-3 3M5 21h6"/></svg>`,
  extracteur_lumen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="9" r="3"/><path d="M12 2v2M5 4l1 1M19 4l-1 1M3 9h2M19 9h2M5 14l1-1M19 14l-1-1M6 17l-2 4M18 17l2 4M9 17l-1 4M15 17l1 4M12 17v4"/></svg>`,
  synthetiseur_plasmide: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 3h6M10 3v5l-4 11a3 3 0 003 4h6a3 3 0 003-4l-4-11V3"/><circle cx="12" cy="16" r="1.2"/></svg>`,
  centrale_solaire: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="6" width="18" height="10" rx="1"/><path d="M3 11h18M9 6v10M15 6v10M8 20h8M12 16v4"/></svg>`,
  depot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4M3 17l9 4 9-4"/></svg>`,
  usine_robotique: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>`,
  chantier_spatial: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2c4 4 6 8 6 12v4l-3-2h-6l-3 2v-4c0-4 2-8 6-12z"/><circle cx="12" cy="11" r="2"/><path d="M9 20l-2 2M15 20l2 2"/></svg>`,
  laboratoire: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></svg>`,

  default_b: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="8" width="16" height="13"/><path d="M4 8l8-5 8 5"/></svg>`,
  default_f: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2l4 7-4 3-4-3 4-7z"/></svg>`,
  default_d: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2L4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4z"/></svg>`,
};

// Mapping nom FR (rules.yaml) → fichier PNG dans assets/codex/.
const codexAssets = {
  // bâtiments
  mine_ferrum: 'building/building_ferrum_mine',
  extracteur_lumen: 'building/building_lumen_extractor',
  synthetiseur_plasmide: 'building/building_plasmide_synthesizer',
  centrale_solaire: 'building/building_solar_plant',
  reacteur_fusion: 'building/building_fusion_reactor',
  usine_robotique: 'building/building_robotic_factory',
  chantier_spatial: 'building/building_spaceyard',
  laboratoire: 'building/building_laboratory',
  depot: 'building/building_depot',
  silo_missiles: 'building/building_silo_missiles',
  terminal_marchand: 'building/building_terminal_marchand',
  centre_diplomatique: 'building/building_centre_diplomatique',
  // vaisseaux
  sonde: 'ship/ship_probe',
  chasseur_leger: 'ship/ship_light_fighter',
  chasseur_lourd: 'ship/ship_heavy_fighter',
  croiseur: 'ship/ship_cruiser',
  fregate: 'ship/ship_frigate',
  cuirasse: 'ship/ship_battlecruiser',
  destroyer: 'ship/ship_destroyer',
  dreadnought: 'ship/ship_dreadnought',
  cargo_lourd: 'ship/ship_heavy_cargo',
  recycleur: 'ship/ship_recycler',
  vaisseau_colon: 'ship/ship_colony',
  // défenses
  lance_missiles: 'defense/defense_missile_launcher',
  canon_laser_leger: 'defense/defense_light_laser',
  canon_laser_lourd: 'defense/defense_heavy_laser',
  canon_gauss: 'defense/defense_gauss_cannon',
  canon_ionique: 'defense/defense_ion_cannon',
  canon_plasma: 'defense/defense_plasma_cannon',
  petit_bouclier_planetaire: 'defense/defense_small_planetary_shield',
  grand_bouclier_planetaire: 'defense/defense_large_planetary_shield',
};

function codexImg(name, alt) {
  const path = codexAssets[name];
  if (!path) return null;
  const safeName = String(name).replace(/[^a-z_]/gi, '');
  return `<img class="codex-img" src="assets/codex/${path}.png" alt="${escapeHtml(alt || safeName)}" loading="lazy" onerror="this.parentElement.classList.add('codex-fallback');this.remove()">`;
}

const labels = {
  mine_ferrum: 'Mine de Ferrum',
  extracteur_lumen: 'Extracteur Lumen',
  synthetiseur_plasmide: 'Synthétiseur Plasmide',
  centrale_solaire: 'Centrale Solaire',
  reacteur_fusion: 'Réacteur à Fusion',
  depot: 'Dépôt Stratégique',
  usine_robotique: 'Usine Robotique',
  chantier_spatial: 'Chantier Spatial',
  laboratoire: 'Laboratoire',
  silo_missiles: 'Silo de Missiles',
  terminal_marchand: 'Terminal Marchand',
  centre_diplomatique: 'Centre Diplomatique',
  // vaisseaux
  sonde: 'Sonde',
  chasseur_leger: 'Chasseur Léger',
  chasseur_lourd: 'Chasseur Lourd',
  croiseur: 'Croiseur',
  fregate: 'Frégate',
  cuirasse: 'Cuirassé',
  destroyer: 'Destroyer',
  dreadnought: 'Dreadnought',
  cargo_lourd: 'Cargo Lourd',
  recycleur: 'Recycleur',
  vaisseau_colon: 'Vaisseau Colon',
  // défenses
  lance_missiles: 'Lance-missiles',
  canon_laser_leger: 'Canon Laser Léger',
  canon_laser_lourd: 'Canon Laser Lourd',
  canon_gauss: 'Canon Gauss',
  canon_ionique: 'Canon Ionique',
  canon_plasma: 'Canon Plasma',
  petit_bouclier_planetaire: 'Petit Bouclier Planétaire',
  grand_bouclier_planetaire: 'Grand Bouclier Planétaire',
  // recherches
  robotique: 'Robotique',
  automation_miniere: 'Automation Minière',
  fusion_controlee: 'Fusion Contrôlée',
  drives_impulsion: 'Drives à Impulsion',
  drive_hyperspatial: 'Drive Hyperspatial',
  armement: 'Armement',
  bouclier_graviton: 'Bouclier Graviton',
  espionnage_profond: 'Espionnage Profond',
  cryptographie: 'Cryptographie',
  diplomatie: 'Diplomatie',
  doctrine_imperiale: 'Doctrine Impériale',
  distorsion_subluminique: 'Distorsion Subluminique',
};

const taglines = {
  mine_ferrum: 'extrait du Ferrum',
  extracteur_lumen: 'récolte du Lumen',
  synthetiseur_plasmide: 'synthétise du Plasmide',
  centrale_solaire: 'produit de l\'énergie',
  depot: 'augmente le stockage',
  usine_robotique: 'accélère les chantiers',
  chantier_spatial: 'construit la flotte',
  laboratoire: 'accélère la recherche',
  silo_missiles: 'stocke les missiles',
  terminal_marchand: 'commerce inter-empires',
  centre_diplomatique: 'projette l\'influence',
  // vaisseaux
  sonde: 'éclaireur',
  chasseur_leger: 'intercepteur',
  chasseur_lourd: 'intercepteur lourd',
  croiseur: 'ligne de bataille',
  fregate: 'frappe rapide',
  cuirasse: 'navire capital',
  destroyer: 'navire capital lourd',
  dreadnought: 'super-capital',
  cargo_lourd: 'transport',
  recycleur: 'récupérateur de débris',
  vaisseau_colon: 'colonisation',
  // défenses
  lance_missiles: 'pièce légère',
  canon_laser_leger: 'pièce légère',
  canon_laser_lourd: 'pièce moyenne',
  canon_gauss: 'pièce lourde',
  canon_ionique: 'anti-bouclier',
  canon_plasma: 'pièce capitale',
  petit_bouclier_planetaire: 'bouclier (1 max)',
  grand_bouclier_planetaire: 'bouclier (1 max)',
};

/* ───────────────────────────── Planet glyph ─────────────────────────────── */
function planetSVG(classe) {
  const palettes = {
    tellurique:  ['#3a5a3e', '#7fa570', '#a8c89a', '#2a3e2c'],
    cristalline: ['#2a5a5a', '#6fe6e1', '#a8f5f2', '#1a3a3a'],
    glacee:      ['#3a6a8a', '#88c8e0', '#d0e8f5', '#1e3a4a'],
    volcanique:  ['#5a2a1a', '#e8633a', '#f0a070', '#3a1a10'],
    gazeuse:     ['#4a3a6a', '#9a86d4', '#c8b0d8', '#2a1e3a'],
  };
  const p = palettes[classe] || palettes.tellurique;
  return `<svg viewBox="0 0 64 64">
    <defs>
      <radialGradient id="pg-${classe}" cx="35%" cy="30%">
        <stop offset="0%" stop-color="${p[2]}"/>
        <stop offset="40%" stop-color="${p[1]}"/>
        <stop offset="80%" stop-color="${p[0]}"/>
        <stop offset="100%" stop-color="${p[3]}"/>
      </radialGradient>
    </defs>
    <circle cx="32" cy="32" r="26" fill="url(#pg-${classe})"/>
    <circle cx="32" cy="32" r="26" fill="none" stroke="${p[3]}" stroke-width="0.6" opacity="0.6"/>
    <ellipse cx="22" cy="24" rx="6" ry="3" fill="${p[0]}" opacity="0.5"/>
    <ellipse cx="40" cy="38" rx="8" ry="4" fill="${p[3]}" opacity="0.5"/>
    <circle cx="44" cy="22" r="2.5" fill="${p[2]}" opacity="0.6"/>
    <circle cx="32" cy="32" r="26" fill="none" stroke="${p[2]}" stroke-width="0.4" opacity="0.3"/>
  </svg>`;
}

/* ───────────────────────────── Fetch ────────────────────────────────────── */
async function fetchText(p) {
  if (state.source === 'github' && cfg.repo) {
    const url = `https://api.github.com/repos/${cfg.repo}/contents/${encodeURIComponent(p).replace(/%2F/g, '/')}?ref=${encodeURIComponent(cfg.branch || 'main')}&t=${Date.now()}`;
    const headers = { Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' };
    if (cfg.pat) headers.Authorization = `Bearer ${cfg.pat}`;
    const r = await fetch(url, { cache: 'no-store', headers });
    if (!r.ok) throw new Error(p);
    return r.text();
  }
  const r = await fetch(p, { cache: 'no-store' });
  if (!r.ok) throw new Error(p);
  return r.text();
}

async function waitForBitcoinModule() {
  if (window.aetherisBitcoin?.ready) return;
  await new Promise(resolve => window.addEventListener('aetheris-bitcoin-ready', resolve, { once: true }));
}

let _bootStatusHideTimer = null;
function showStatus(msg, persist = false) {
  const el = document.getElementById('boot-status');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  console.log('[boot]', msg);
  if (_bootStatusHideTimer) clearTimeout(_bootStatusHideTimer);
  if (!persist) {
    _bootStatusHideTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }
}

// Boot 100% Bitcoin : scan la chain, replay les ticks, reconstruit l'état.
// Les fichiers statiques (genesis, rules, galaxie) sont lus depuis le repo
// (paths relatifs si la console est servie depuis le repo, sinon raw.github).
async function load() {
  try {
    await waitForBitcoinModule();
    const ab = window.aetherisBitcoin;

    showStatus('▸ chargement genesis / rules / galaxie…');
    const [genesisYaml, rulesYaml, galaxieYaml] = await Promise.all([
      fetchText('genesis/genesis.yaml'),
      fetchText('engine/rules.yaml'),
      fetchText('world/galaxie.yaml'),
    ]);

    showStatus('▸ boot bitcoin…');
    const result = await ab.bootBitcoin({
      api: 'https://mutinynet.com/api',
      genesisYaml, rulesYaml, galaxieYaml,
      log: (m) => showStatus(m, true),
      onProgress: ({ phase, current, total }) => {
        if (total <= 1) return; // skip trivial 0/0 ou 1/1
        const label = phase === 'scan' ? '⛓ scan' : '⏱ replay';
        showStatus(`${label} ${current}/${total}`, true);
      },
      verifySignature: async (yamlContent, pubB64, sigB64) => {
        try {
          const pubBytes = Uint8Array.from(atob(pubB64), c => c.charCodeAt(0));
          const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
          const key = await crypto.subtle.importKey('spki', pubBytes, { name: 'Ed25519' }, false, ['verify']);
          const canonical = yamlContent.split('\n').filter(l => !/^signature:\s*/.test(l)).join('\n').trimEnd() + '\n';
          return await crypto.subtle.verify('Ed25519', key, sigBytes, new TextEncoder().encode(canonical));
        } catch { return false; }
      },
    });

    state.manifest = result.manifest;
    state.rules = result.rules;
    state.galaxie = result.galaxie;
    state.players = result.empires;
    state.identites = result.identites;
    state.reports = result.reports || { intelByPlayer: {}, alertsByPlayer: {}, battles: [] };
    const previousTip = state.bitcoin?.tip;
    state.bitcoin = {
      tip: result.tip,
      blocGenesis: result.blocGenesis,
      blocsParTick: result.blocsParTick,
      tickCourant: result.tickCourant,
      joins: result.joins,
      ordersByTick: result.ordersByTick,
      lastBlockSeenAt: previousTip !== result.tip ? Date.now() : (state.bitcoin?.lastBlockSeenAt || Date.now()),
    };

    // Projette les ordres on-chain du prochain tick dans player._ordres pour
    // que l'UI affiche les chantiers/recherches/constructions pending même
    // après un refresh complet (où localOrdersCache est vide).
    // ordersByTick contient TOUS les ordres scannés indexés par tick_cible ;
    // on prend ceux du tick suivant (= seuls non encore exécutés).
    const tickNow = state.manifest?.tick ?? 0;
    const tickNext = tickNow + 1;
    const ordresProchaintick = state.bitcoin.ordersByTick?.[tickNext] || {};
    for (const [name, entry] of Object.entries(ordresProchaintick)) {
      if (!state.players[name]) continue;
      state.players[name]._ordres = {
        tick_cible: tickNext,
        ordres: entry.parsed?.ordres || [],
        nonce: entry.parsed?.nonce,
      };
      // Le scan voit notre inscription on-chain → mempool drainé, on peut
      // ré-inscrire. (Match par nonce si dispo, sinon par tick_cible.)
      const inflight = inflightInscriptions[name];
      if (inflight && (
        (inflight.nonce && entry.parsed?.nonce === inflight.nonce) ||
        (!inflight.nonce && inflight.tickCible === tickNext)
      )) {
        delete inflightInscriptions[name];
      }
    }
    // Garde-fou : un inflight de plus de 5 min est forcément périmé (tick
    // avancé, mempool drop, etc.) — on libère pour éviter un blocage permanent.
    const now = Date.now();
    for (const [name, info] of Object.entries(inflightInscriptions)) {
      if (now - info.ts > 5 * 60 * 1000) delete inflightInscriptions[name];
      else if (info.tickCible <= tickNow) delete inflightInscriptions[name];
    }

    // Re-injecte les ordres en attente de confirmation on-chain non encore
    // scannés (push fraîchement émis pas encore dans un bloc). Le local cache
    // gagne sur on-chain : si l'user a poussé du nouveau, on l'affiche tout
    // de suite. Sinon le on-chain (ci-dessus) prend le relais après scan.
    for (const [name, cached] of Object.entries(localOrdersCache)) {
      if (cached.tick_cible > tickNow && state.players[name]) {
        state.players[name]._ordres = cached;
      } else {
        delete localOrdersCache[name];
      }
    }

    // Le joueur courant est résolu dans render() par la pubkey du wallet.
    // On ne touche pas state.current ici — render() le verrouille.
    const playerNames = Object.keys(state.players);

    showStatus(`✓ tick ${state.manifest.tick} · ${playerNames.length} empire(s) · bloc ${state.bitcoin.tip}`);
    document.getElementById('err').classList.remove('on');
    applySrcUI();
    render();
    try { detectNotifs(); } catch (e) { console.warn('notif detect failed', e); }
    // Auto-revealer : publie les reveals des sceaux dont le tick_impact est
    // atteint. Async, ne bloque pas l'UI. Erreurs catchées en interne.
    runAutoRevealer().catch(e => console.warn('autoRevealer error:', e));
  } catch (e) {
    const err = document.getElementById('err');
    err.innerHTML = `⚠ liaison rompue · ${escapeHtml(e.message || 'erreur')}<button class="close" aria-label="Fermer" onclick="this.parentElement.classList.remove('on')">×</button>`;
    err.classList.add('on');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ───────────────────────────── Format helpers ───────────────────────────── */
const fmt = n => (n ?? 0).toLocaleString('fr-FR');
const fmtCompact = n => {
  n = n ?? 0;
  if (n >= 1e9) return (n/1e9).toFixed(1).replace(/\.0$/, '') + 'G';
  if (n >= 1e6) return (n/1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
};

// 1 UTJ ≈ duree_tick_min / 6 (6 UTJ par tick par convention engine)
function utjMin() { return ((state.manifest?.duree_tick_min) || 15) / 6; }

// Le moteur progresse par ticks (6 UTJ par tick). Une duree affichee en UTJ
// se traduit en N ticks = ceil(UTJ / 6). Toujours +1 tick de queue.
function utjToTicks(utj) { return Math.max(1, Math.ceil((utj || 0) / 6)); }
function ticksLabel(n) { return n === 1 ? '1 tick' : `${n} ticks`; }
// Pour un chantier en file (deja queue), retourne le tick d'arrivee et minutes restantes.
function chantierETA(remainUtj) {
  const ticksAv = utjToTicks(remainUtj);
  const tickArrivee = (state.manifest?.tick ?? 0) + ticksAv;
  const info = nextTickInfo();
  const minsToNext = info.secs / 60;
  const mins = Math.round(minsToNext + (ticksAv - 1) * info.mins);
  return { tickArrivee, mins };
}

// Mode Bitcoin : un tick = blocs_par_tick blocs Mutinynet (≈30s cible/bloc).
// Le compte à rebours estime le temps avant la prochaine FRONTIÈRE de tick
// (pas le prochain bloc), basé sur la position du tip dans le cycle courant.
const BLOCK_INTERVAL_SEC = 30;
function nextTickInfo() {
  const m = state.manifest;
  const b = state.bitcoin;
  const N = b?.blocsParTick || 1;
  const seenAt = b?.lastBlockSeenAt || Date.now();
  const elapsed = (Date.now() - seenAt) / 1000;
  // Blocs restants avant le prochain tick (1..N).
  let blocsRestants = N;
  if (b && Number.isFinite(b.tip) && Number.isFinite(b.blocGenesis)) {
    const dansLeCycle = ((b.tip - b.blocGenesis) % N + N) % N;
    blocsRestants = N - dansLeCycle;  // ∈ [1, N]
  }
  const totalSec = blocsRestants * BLOCK_INTERVAL_SEC;
  const secs = Math.max(0, Math.round(totalSec - elapsed));
  const pct = Math.min(100, Math.max(0, (1 - secs / totalSec) * 100));
  return {
    tick: m?.tick ?? 0,
    secs,
    pct,
    mins: totalSec / 60,                     // durée nominale du tick courant
    overdue: elapsed > totalSec,
    blocsRestants,
  };
}

function fmtCountdown(s) {
  const m = Math.floor(s / 60), sec = s % 60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

/* ───────────────────────────── Render ───────────────────────────────────── */
// Mémoire du dernier tick affiché — pour fire l'animation tick-landing
// uniquement quand le moteur avance, pas à chaque re-render.
let __lastSeenTick = -1;
let __lastResourceSnapshot = null;  // { [planete|res]: stock } pour diff cellules
function __snapshotResources(emp) {
  const snap = {};
  for (const p of (emp?.planetes || [])) {
    for (const [res, info] of Object.entries(p.ressources || {})) {
      snap[`${p.nom}|${res}`] = info?.stock || 0;
    }
  }
  return snap;
}
function __fireTickPulse() {
  document.body.classList.add('tick-pulsed');
  const foot = document.querySelector('.foot');
  if (foot) foot.classList.add('tick-flash');
  setTimeout(() => {
    document.body.classList.remove('tick-pulsed');
    if (foot) foot.classList.remove('tick-flash');
  }, 1700);
  // Flash les compteurs Fe/Lu/Pl du strip ressources qui ont changé.
  if (__lastResourceSnapshot) {
    requestAnimationFrame(() => {
      document.querySelectorAll('[data-stock-cell]').forEach(el => {
        const key = el.getAttribute('data-stock-cell');
        const newVal = parseFloat(el.getAttribute('data-stock-value') || '0');
        const oldVal = __lastResourceSnapshot[key];
        if (oldVal != null && newVal !== oldVal) {
          el.classList.remove('cell-changed');
          // force reflow pour relancer l'anim
          void el.offsetWidth;
          el.classList.add('cell-changed');
          setTimeout(() => el.classList.remove('cell-changed'), 1500);
        }
      });
    });
  }
}

function render() {
  const m = state.manifest;
  const currentTick = m?.tick ?? -1;

  // Détection avancement tick : on déclenche AVANT le render (pour saisir
  // l'ancien snapshot ressources) et on flash APRÈS (pour voir les
  // nouvelles valeurs en surbrillance).
  const tickAdvanced = (__lastSeenTick >= 0 && currentTick > __lastSeenTick);

  // Tick avancé : vide les paniers (les ordres y restant visaient le tick
  // qui vient de passer, donc plus pertinents). Les ordres déjà inscrits
  // restent dans emp._ordres tant que le moteur ne les a pas consommés.
  if (tickAdvanced) {
    const newTickCible = currentTick + 1;
    for (const name of Object.keys(localQueue)) {
      const q = localQueue[name];
      if (q.length > 0 && q[0].tickCible <= currentTick) {
        delete localQueue[name];
      } else if (q.length > 0 && q[0].tickCible !== newTickCible) {
        // Réaligne le tickCible (resté à 0 entre boot et premier load)
        for (const item of q) item.tickCible = newTickCible;
      }
    }
  }

  // header
  document.getElementById('tickValue').textContent = m ? String(m.tick).padStart(3, '0') : '—';
  document.getElementById('proto').textContent = m ? `v${m.protocol_version}` : '—';
  document.getElementById('srv').textContent = m ? m.serveur : '—';
  document.getElementById('seed').textContent = m ? String(m.seed).slice(0, 10) + '…' : '—';
  document.getElementById('hash').textContent = m && m.hash_etat ? String(m.hash_etat).slice(7, 19) : '—';
  // Identité verrouillée sur la pubkey Schnorr du wallet : seul ton propre
  // empire est accessible. Sans wallet, la console est en lecture seule (rien).
  const walletPk = state.wallet?.pubKeyHex;
  const authorizedPlayer = walletPk ? playerByPubkey(walletPk) : null;
  if (authorizedPlayer) state.current = authorizedPlayer;
  else state.current = null;

  document.getElementById('whoLabel').innerHTML = state.current
    ? `${state.current}<small>commandant</small>`
    : `—`;

  // Dropdown masqué : le joueur est déterminé exclusivement par le wallet.
  const sel = document.getElementById('playerSelect');
  sel.innerHTML = '';
  sel.style.display = 'none';
  sel.onchange = null;

  const emp = state.players[state.current];
  const p = emp && (emp.planetes || [])[0];

  renderResourceStrip(p);
  renderPlanetHead(p, emp);
  renderOverview(p, emp);
  renderBatiments(p);
  renderRecherche(emp);
  renderFlotte(p);
  renderDefense(p);
  renderGalaxie();
  renderJournal(p, emp);
  renderRapports();
  renderMarche(p, emp);
  renderClassement();
  renderRail(p, emp);
  renderNavCounts(p, emp);
  applyView();

  document.getElementById('lastRefresh').textContent =
    new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (p) maybeAdvanceOnboarding(p, emp);

  // Anim post-render : si le tick a avancé, balayage doré + flash des
  // ressources qui ont changé. La snapshot ressources se met à jour
  // après pour servir de référence au prochain tick.
  if (tickAdvanced) __fireTickPulse();
  __lastSeenTick = currentTick;
  __lastResourceSnapshot = __snapshotResources(emp);
}

function renderNavCounts(p, emp) {
  const numActive = (obj) => obj ? Object.values(obj).filter(v => v && v > 0).length : 0;
  document.getElementById('ctBat').textContent = p ? numActive(p.batiments) : '—';
  document.getElementById('ctRec').textContent = emp ? numActive(emp.recherche) : '—';
  document.getElementById('ctFlt').textContent = p ? numActive(p.flotte_au_sol) : '—';
  document.getElementById('ctDef').textContent = p ? numActive(p.defenses) : '—';
  const ctRap = document.getElementById('ctRap');
  if (ctRap) {
    const me = state.current;
    const n = me ? collectRapports(me).length : 0;
    ctRap.textContent = n || '—';
  }
}

function renderResourceStrip(p) {
  const def = [
    { k: 'ferrum',   l: 'Ferrum'   },
    { k: 'lumen',    l: 'Lumen'    },
    { k: 'plasmide', l: 'Plasmide' },
  ];
  let html = '';
  for (const r of def) {
    const info = p?.ressources?.[r.k] || { stock: 0, production_par_utj: 0, capacite: 0 };
    const pct = info.capacite ? (info.stock / info.capacite) * 100 : 0;
    const warn = pct >= 90;
    const prod = info.production_par_utj || 0;
    const tip = resourceTooltip(r.k, info);
    const stockKey = `${p?.nom || ''}|${r.k}`;
    html += `<div class="res" data-r="${r.k}" data-tip="${escapeHtml(tip)}">
      <div class="ico">${icons[r.k]}</div>
      <div class="nm">${r.l}</div>
      <div class="stock" data-stock-cell="${escapeHtml(stockKey)}" data-stock-value="${info.stock || 0}">${fmtCompact(info.stock)}</div>
      <div class="meta ${warn ? 'warn' : ''} ${prod === 0 ? 'zero' : ''}">${warn ? 'plein' : (prod > 0 ? '+' + prod + '/utj' : '—')}</div>
    </div>`;
  }
  const en = p?.energie || { production: 0, consommation: 0, facteur_production: 1.0 };
  const balance = (en.production || 0) - (en.consommation || 0);
  const fact = en.facteur_production ?? 1.0;
  const malusPct = fact < 1.0 ? Math.round((1 - fact) * 100) : 0;
  const enTip = `${descOf('energie')}\nProduction : ${en.production || 0}/UTJ\nConsommation : ${en.consommation || 0}/UTJ\nBalance : ${balance >= 0 ? '+' : ''}${balance}${malusPct > 0 ? `\nMalus production ressources : −${malusPct}%` : ''}`;
  const metaLabel = balance < 0 ? `−${malusPct}% prod` : 'stable';
  html += `<div class="res" data-r="energie" data-tip="${escapeHtml(enTip)}">
    <div class="ico">${icons.energie}</div>
    <div class="nm">Énergie</div>
    <div class="stock" style="color:${balance < 0 ? 'var(--phosphor)' : 'var(--bone-2)'}">${balance >= 0 ? '+' : ''}${balance}</div>
    <div class="meta ${balance < 0 ? 'warn' : ''}">${metaLabel}</div>
  </div>`;
  document.getElementById('strip').innerHTML = html;
}

function renderPlanetHead(p, emp) {
  // Sur Aperçu → carte héros "Bulletin" complète.
  // Sur les autres vues → barre compacte (nom + coords + chip).
  const head = document.getElementById('planetHead');
  if (!p) {
    head.className = '';
    head.innerHTML = `<div class="empty-stamp">aucune planète attribuée</div>`;
    return;
  }
  const coord = (p.coordonnees || []).join(':');
  const tickCur = state.manifest?.tick ?? 0;

  // Vue compacte hors Aperçu — juste l'identité de la planète.
  if (state.view !== 'overview') {
    head.className = 'planet-bar';
    head.innerHTML = `
      <h1 class="pb-title"><span class="pb-coord">${coord}</span>${p.nom}</h1>
      <span class="pb-chip ${p.type || ''}">${p.type || 'planète'}</span>
      <span class="pb-meta">cycle <b>${tickCur}</b></span>
      <span class="pb-meta">score <b>${fmt(emp?.score_total ?? 0)}</b></span>
      <span class="pb-meta" style="margin-left:auto">champs <b>${p.champs?.utilises ?? 0}/${p.champs?.total ?? 0}</b></span>`;
    return;
  }

  head.className = 'bulletin';
  const buildings = Object.entries(p.batiments || {});
  const built = buildings.filter(([, n]) => n > 0).length;
  const total = buildings.length;

  // News : prochain événement notable (chantier qui finit, recherche, flotte)
  const news = computeNextEvent(p, emp, tickCur);

  // Threats : flottes hostiles d'autres joueurs en route vers une de mes planètes
  const threat = computeIncomingThreat(emp, tickCur);

  // Stats : score, rang, ordres scellés en attente
  const decretsCount = (emp?._ordres?.tick_cible >= tickCur + 1)
    ? (emp._ordres.ordres || []).length : 0;
  const rangStr = emp?.rang != null ? `${emp.rang}` : '—';
  const scoreStr = fmt(emp?.score_total ?? 0);

  head.innerHTML = `
    <div class="label">Bulletin du Cycle ${tickCur}</div>
    <h1 class="planet"><span class="coord">${coord}</span>${p.nom}</h1>
    <div class="sub">
      <span><b>${built}/${total}</b> ouvrages debout</span>
      <span class="chip ${p.type || ''}">${p.type || 'planète'}</span>
      <span>militaire <b>${fmt(emp?.points_militaires ?? 0)}</b></span>
      ${(emp?.ressources_globales?.singularite || 0) > 0 ? `<span data-singularite-chip title="Singularités quantiques produites par tes anomalies colonisées">Σ <b>${emp.ressources_globales.singularite}</b></span>` : ''}
      ${(emp?.ressources_globales?.influence || 0) > 0 ? `<span title="Influence diplomatique">∞ <b>${fmt(Math.floor(emp.ressources_globales.influence))}</b></span>` : ''}
      ${(emp?.malus_moral_jusqu_tick || 0) > tickCur ? `<span style="color:var(--red)" title="Malus moral après rupture de trêve : production −15% jusqu'au tick ${emp.malus_moral_jusqu_tick}">⚡ malus ${emp.malus_moral_jusqu_tick - tickCur}t</span>` : ''}
      <span style="margin-left:auto"><b>${p.champs?.utilises ?? 0}/${p.champs?.total ?? 0}</b> champs</span>
    </div>
    <div class="news">
      <div>
        <h3>${news.label}</h3>
        <div class="item">${news.text}</div>
      </div>
      <div class="stamp">${news.stamp}</div>
    </div>
    ${threat ? `
      <div class="threats">
        <div class="pulse"></div>
        <div class="body">${threat}</div>
      </div>` : ''}
    <div class="stats">
      <div class="s"><div class="k">Score impérial</div><div class="v">${scoreStr}</div></div>
      <div class="s"><div class="k">Rang galactique</div><div class="v">${rangStr}<small>${rangStr === '1' ? 'tête' : ''}</small></div></div>
      <div class="s"><div class="k">Décrets scellés</div><div class="v">${decretsCount}<small>${decretsCount > 0 ? 'en file' : ''}</small></div></div>
    </div>`;

  updateBell(threat, decretsCount);
}

function computeNextEvent(p, emp, tickCur) {
  // 1) Chantier qui s'achève le plus tôt
  const chantiers = (p.file_chantier || []).slice().sort((a, b) => (a.fin_utj || 0) - (b.fin_utj || 0));
  if (chantiers[0]) {
    const c = chantiers[0];
    const remain = Math.max(0, c.fin_utj || 0);
    const ticks = Math.max(1, Math.ceil(remain / 6));
    const tickFin = tickCur + ticks;
    return {
      label: 'Prochaine livraison',
      text: `Vos chantiers livreront <em>${labels[c.batiment] || c.batiment} niveau ${c.niveau_cible}</em> au cycle <em>${tickFin}</em>.`,
      stamp: `dans ${ticks} cycle${ticks > 1 ? 's' : ''} · cycle ${tickFin}`,
    };
  }
  // 2) Flotte en vol
  const vols = emp?.flottes_en_vol || [];
  if (vols[0]) {
    const f = vols[0];
    const dest = f.vers?.planete || f.vers || '—';
    return {
      label: 'Flotte en mission',
      text: `Mission <em>${f.type_mission || 'reconnaissance'}</em> vers <em>${dest}</em>.`,
      stamp: f.tick_arrivee ? `arrivée cycle ${f.tick_arrivee}` : 'en vol',
    };
  }
  // 3) Sinon, état calme
  return {
    label: 'État de l\'Empire',
    text: `Cycle calme. <em>${emp?.points_militaires ? 'La flotte veille' : 'L\'industrie tourne'}</em>, aucune action urgente.`,
    stamp: `tick ${tickCur}`,
  };
}

function computeIncomingThreat(emp, tickCur) {
  // Scan toutes les flottes en vol de tous les joueurs pour trouver celles
  // qui visent une de mes planètes avec une mission hostile.
  if (!state.players || !emp) return null;
  const myPlanets = new Set((emp.planetes || []).map(p => p.nom));
  const me = state.current;
  const hostile = new Set(['attaque', 'siege', 'pillage', 'bombardement']);
  let earliest = null;
  for (const [name, e] of Object.entries(state.players)) {
    if (name === me) continue;
    for (const f of (e.flottes_en_vol || [])) {
      const dest = f.vers?.planete || f.vers;
      if (!myPlanets.has(dest)) continue;
      if (!hostile.has((f.type_mission || '').toLowerCase())) continue;
      const arr = f.tick_arrivee || 0;
      const ticksLeft = Math.max(0, arr - tickCur);
      if (!earliest || ticksLeft < earliest.ticksLeft) {
        earliest = { from: name, dest, ticksLeft, arr, mission: f.type_mission };
      }
    }
  }
  if (!earliest) return null;
  return `Flotte <b>${earliest.mission}</b> de <b>${earliest.from}</b> en approche de <b>${earliest.dest}</b> · impact dans <b>${earliest.ticksLeft} cycle${earliest.ticksLeft > 1 ? 's' : ''}</b>.`;
}

function updateBell(threat, decretsCount) {
  // Bell now reflects unread notif count — see refreshNotifUI().
  refreshNotifUI();
}

function renderOverview(p, emp) {
  const v = document.getElementById('vOverview');
  if (!p) { v.innerHTML = `<div class="empty-stamp">en attente d'attribution</div>`; return; }

  const buildings = Object.entries(p.batiments || {});
  const built = buildings.filter(([,n]) => n > 0).length;
  const total = buildings.length;

  const queueItems = (p.file_chantier || []).length;
  const research = Object.values(emp?.recherche || {}).filter(v => v > 0).length;
  const fleet = Object.values(p.flotte_au_sol || {}).reduce((a, b) => a + (b||0), 0);
  const def = Object.values(p.defenses || {}).reduce((a, b) => a + (b||0), 0);

  v.innerHTML = `
    <h2 class="sect">Bâtiments principaux <span class="num">§ I</span> <span class="rule"></span></h2>
    ${renderBatGrid(p, 4)}
  `;
}
function overviewCard(label, val, sub, ico) {
  return `<div class="bcard ${val === '0' ? 'zero' : ''}">
    <div class="gl">${ico}</div>
    <div class="nm">${label}<small>${sub}</small></div>
    <div class="lvl">${val}<small>actuel</small></div>
  </div>`;
}

// Effet actuel d'un bâtiment au niveau courant — chaîne courte affichée
// sous le niveau dans la carte. null = pas d'affichage.
function batEffet(k, lvl, p) {
  if (lvl === 0) return null;
  const r = p?.ressources || {};
  switch (k) {
    case 'mine_ferrum':         return `<b>+${fmtCompact(r.ferrum?.production_par_utj || 0)}</b> ferrum/utj`;
    case 'extracteur_lumen':    return `<b>+${fmtCompact(r.lumen?.production_par_utj || 0)}</b> lumen/utj`;
    case 'synthetiseur_plasmide': return `<b>+${fmtCompact(r.plasmide?.production_par_utj || 0)}</b> plasmide/utj`;
    case 'centrale_solaire':    return `<b>+${fmtCompact(p.energie?.production || 0)}</b> énergie`;
    case 'depot': {
      const cap = (r.ferrum?.capacite || 0) + (r.lumen?.capacite || 0) + (r.plasmide?.capacite || 0);
      return `cap. <b>${fmtCompact(cap)}</b>`;
    }
    case 'usine_robotique':     return `vitesse chantiers <b>+${lvl * 10}%</b>`;
    case 'chantier_spatial':    return `vitesse flotte <b>+${lvl * 10}%</b>`;
    case 'laboratoire':         return `recherche <b>+${lvl * 10}%</b>`;
    case 'silo_missiles':       return `<b>${lvl * 10}</b> missiles max`;
    case 'terminal_marchand':   return `ratio marché <b>+${(lvl * 5)}%</b>`;
    case 'centre_diplomatique': return `influence <b>+${(lvl * 0.5).toFixed(1)}</b>/utj`;
  }
  return null;
}

// Descriptions des unités, recherches et ressources pour les tooltips.
const DESCRIPTIONS = {
  // Ressources
  ferrum:    'Métal de base. Sert à tout : bâtiments, vaisseaux, défenses.',
  lumen:     'Cristal énergétique. Indispensable aux technologies avancées et aux vaisseaux.',
  plasmide:  'Matière organique rare. Requise par les unités lourdes et les recherches de pointe.',
  energie:   'Surplus = production normale. Déficit = production divisée. Chaque bâtiment consomme.',
  // Vaisseaux
  sonde:           'Drone d\'éclairage. Sans valeur militaire. Sert à espionner les voisins.',
  chasseur_leger:  'Intercepteur économique. Forme l\'épine dorsale de toute flotte. Bonus ×2 vs cargo.',
  chasseur_lourd:  'Frappe robuste. Bonus ×2 contre chasseurs légers. Coûte plus cher mais encaisse.',
  croiseur:        'Ligne de bataille. Excellente attaque/cargo. Bonus ×6 vs chasseur léger, ×3 vs lourd.',
  fregate:         'Frappe rapide. Bonus ×3 contre les croiseurs.',
  cuirasse:        'Capital ship. Brise les flottes adverses par le poids du nombre. Coque 6000, attaque 1000.',
  destroyer:       'Capital lourd. Bonus ×2 contre cuirasse. Hyperspatial requis.',
  dreadnought:     'Super-capital. Requiert une singularité. Détruit tout ce qu\'elle touche.',
  cargo_lourd:     'Transporteur civil. Cargo 25 000. Pas une unité de combat — protège-le.',
  recycleur:       'Récupère les débris des épaves après bataille. Cargo 20 000.',
  vaisseau_colon:  'Permet de coloniser un nouveau monde. Une seule planète par vaisseau.',
  // Défenses
  lance_missiles:           'Tir de surface. Bonus ×1.5 contre chasseurs légers.',
  canon_laser_leger:        'Pièce légère, peu chère. Premier rempart d\'une planète.',
  canon_laser_lourd:        'Pièce moyenne. Encaisse mieux que le léger.',
  canon_gauss:              'Pièce lourde. Bonus ×2 vs croiseur, ×1.5 vs cuirasse.',
  canon_ionique:             'Spécialisé anti-bouclier. Bouclier 500 mais attaque modeste.',
  canon_plasma:             'Pièce capitale. Bonus ×2 vs cuirasse, ×1.5 vs destroyer.',
  petit_bouclier_planetaire: 'Bouclier 2 000. Une seule par planète.',
  grand_bouclier_planetaire: 'Bouclier 10 000. Une seule par planète. Requiert bouclier graviton 6.',
  // Recherches
  robotique:                'Accélère la cadence générale. Prérequis usine robotique pour de nombreuses unités.',
  automation_miniere:       'Améliore les rendements des mines au fil des niveaux.',
  fusion_controlee:         'Améliore le rendement de la centrale solaire et la consommation des unités.',
  drives_impulsion:         'Vitesse des chasseurs et croiseurs. Prérequis pour vaisseaux moyens.',
  drive_hyperspatial:       'Long-courrier. Requis pour cuirasse, recycleur et au-delà.',
  armement:                 'Augmente l\'attaque des unités et défenses. Prérequis lourd.',
  bouclier_graviton:        'Augmente les boucliers. Requis pour les boucliers planétaires et le canon ionique.',
  espionnage_profond:       'Augmente la portée des sondes. Prérequis pour construire des sondes.',
  cryptographie:            'Réduit la portée d\'espionnage de tes adversaires sur toi.',
  diplomatie:               'Influence avec les autres empires. Prérequis pour le centre diplomatique.',
  doctrine_imperiale:       'Cohésion des flottes alliées. Requiert diplomatie 4.',
  distorsion_subluminique:  'Voyage instantané. Requiert drive hyperspatial 6.',
};

function descOf(key) { return DESCRIPTIONS[key] || ''; }

// Tooltip riche pour vaisseaux et défenses (mêmes stats).
function unitTooltip(key, def, qty, kind) {
  const role = descOf(key);
  const stats = [
    def.coque ? `coque ${fmt(def.coque)}` : null,
    def.bouclier ? `bouclier ${fmt(def.bouclier)}` : null,
    def.attaque ? `attaque ${fmt(def.attaque)}` : null,
    def.vitesse ? `vitesse ${fmt(def.vitesse)}` : null,
    def.cargo ? `cargo ${fmt(def.cargo)}` : null,
  ].filter(Boolean).join(' · ');

  const cost = Object.entries(def.cout || {})
    .map(([r, v]) => `${fmtCompact(v)} ${labels[r] || r}`).join(' + ');

  const counters = def.bonus_contre
    ? 'Efficace contre : ' + Object.entries(def.bonus_contre)
        .map(([k, m]) => `${labels[k] || k} ×${m}`).join(', ')
    : '';

  const reqs = def.requiert
    ? 'Requiert : ' + Object.entries(def.requiert)
        .map(([k, n]) => `${labels[k] || k} niv ${n}`).join(', ')
    : '';

  const ownedLine = qty != null ? `${kind === 'vaisseaux' ? 'Possédés' : 'Déployés'} : ${fmt(qty)}` : '';
  return [role, stats, cost ? `Coût : ${cost}` : '', counters, reqs, ownedLine]
    .filter(Boolean).join('\n');
}

// Tooltip recherche.
function techTooltip(tech, def, lvl) {
  const role = descOf(tech);
  const niv = lvl > 0 ? `Niveau actuel : ${lvl}` : 'Non recherché';
  const reqs = def.requiert
    ? 'Requiert : ' + Object.entries(def.requiert)
        .map(([k, n]) => `${labels[k] || k} niv ${n}`).join(', ')
    : '';
  return [role, niv, reqs].filter(Boolean).join('\n');
}

// Tooltip ressource (strip).
function resourceTooltip(res, info) {
  const role = descOf(res);
  const stock = info?.stock != null ? `Stock : ${fmt(info.stock)}` : '';
  const cap   = info?.capacite ? `Capacité : ${fmt(info.capacite)}` : '';
  const prod  = info?.production_par_utj != null
    ? `Production : ${info.production_par_utj > 0 ? '+' : ''}${info.production_par_utj}/utj`
    : '';
  return [role, stock, cap, prod].filter(Boolean).join('\n');
}

// Calcule la production d'une mine à un niveau donné (formule miroir du moteur).
// Epoch 0.2 : baseline production retiré, formule pure base × niv × 1.1^niv × bonus.
function simProd(k, lvl, p) {
  const CFG = {
    mine_ferrum:           { base: 30, bonusPlanet: { tellurique: 1.30 } },
    extracteur_lumen:      { base: 20, bonusPlanet: { cristalline: 1.30 } },
    synthetiseur_plasmide: { base: 10, bonusPlanet: { volcanique: 1.30 } },
  };
  const cfg = CFG[k];
  if (!cfg || lvl <= 0) return null;
  const bonus = cfg.bonusPlanet[p?.type] || 1.0;
  return Math.floor(cfg.base * lvl * Math.pow(1.1, lvl) * bonus);
}

// Tooltip plus long pour le hover (attribut title="").
function batTooltip(k, lvl, p) {
  const lines = {
    mine_ferrum: 'Extrait du Ferrum, ressource métallique principale. Bonus +30% sur planète tellurique.',
    extracteur_lumen: 'Récolte des cristaux Lumen. Bonus +30% sur planète cristalline.',
    synthetiseur_plasmide: 'Synthétise le Plasmide. Bonus +30% sur planète volcanique.',
    centrale_solaire: 'Génère de l\'énergie consommée par tous les autres bâtiments.',
    depot: 'Augmente la capacité de stockage de toutes les ressources.',
    usine_robotique: 'Réduit la durée de construction des bâtiments.',
    chantier_spatial: 'Réduit la durée de construction des vaisseaux et défenses.',
    laboratoire: 'Accélère la progression des recherches scientifiques.',
    silo_missiles: 'Stocke les missiles interplanétaires (offensifs et anti-missiles).',
    terminal_marchand: 'Améliore le ratio des échanges sur le marché galactique.',
    centre_diplomatique: 'Projette l\'influence diplomatique sur les voisins. Requiert terminal marchand niv 4.',
  };
  const RES_LABEL = { mine_ferrum: 'Fe', extracteur_lumen: 'Lu', synthetiseur_plasmide: 'Pl' };
  const BONUS_PLANET = { mine_ferrum: { tellurique: 1.30 }, extracteur_lumen: { cristalline: 1.30 }, synthetiseur_plasmide: { volcanique: 1.30 } };
  const desc = lines[k] || 'Structure planétaire.';
  const niv = lvl > 0 ? `\nNiveau actuel : ${lvl}` : '\nNon construit';
  let projection = '';
  const resLabel = RES_LABEL[k];
  if (resLabel && p) {
    const curProd  = simProd(k, lvl, p);
    const nextProd = simProd(k, lvl + 1, p);
    if (curProd != null && nextProd != null) {
      const delta = nextProd - curProd;
      const pct = Math.round(delta / curProd * 100);
      const pad = ' '.repeat(Math.max(0, String(lvl + 1).length - String(lvl).length));
      projection = `\n\nNiv ${lvl}${pad}  → +${fmtCompact(curProd)} ${resLabel}/utj\nNiv ${lvl+1}  → +${fmtCompact(nextProd)} ${resLabel}/utj  (+${fmtCompact(delta)}, +${pct}%)`;
    } else if (nextProd != null) {
      projection = `\n\nNiv 1  → +${fmtCompact(nextProd)} ${resLabel}/utj`;
    }
    const planetBonus = (BONUS_PLANET[k] || {})[p?.type];
    if (planetBonus) projection += `\nBonus planète ${p.type} ×${planetBonus.toFixed(2)} inclus`;
  }
  return `${desc}${niv}${projection}`;
}

function renderBatGrid(p, max) {
  const all = Object.entries(p.batiments || {});
  // ETA cumulé : chaque chantier en position N attend que les N-1 précédents
  // se terminent. tick-core ne décrémente que file[0].fin_utj — donc fin_utj
  // d'un chantier en queue représente sa durée propre, pas son ETA absolu.
  const queueMap = {};
  let cumulUtj = 0;
  let queueIdx = 0;
  for (const c of (p.file_chantier || [])) {
    cumulUtj += Math.max(0, c.fin_utj || 0);
    queueMap[c.batiment] = { ...c, _etaUtj: cumulUtj, _queueIdx: queueIdx++ };
  }
  const list = max ? all.slice(0, max) : all;
  if (list.length === 0) return `<div class="empty-stamp">néant</div>`;

  const ICOS = { ferrum: 'Fe', lumen: 'Lu', plasmide: 'Pl' };
  // Ordres en attente (pas encore traités par le moteur) — on s'en sert pour bloquer les re-clics
  const emp = state.players[state.current];
  const tickCur = state.manifest?.tick ?? 0;
  const pendingMap = {};
  if (emp?._ordres?.tick_cible >= tickCur + 1) {
    for (const o of (emp._ordres.ordres || [])) {
      if (o.type === 'chantier' && o.planete === p.nom) pendingMap[o.batiment] = o;
    }
  }
  return `<div class="bgrid">${list.map(([k, lvl]) => {
    const q = queueMap[k];
    const pend = pendingMap[k];
    const ico = codexImg(k, labels[k]) || icons[k] || icons.default_b;
    let footer = '';
    if (q) {
      const remain = Math.max(0, q._etaUtj ?? q.fin_utj ?? 0);
      const eta = chantierETA(remain);
      const filePrefix = q._queueIdx > 0 ? `<span style="color:var(--brass);font-weight:600">file #${q._queueIdx + 1}</span> · ` : '';
      footer = `<div class="queue"><span class="pulse"></span>
        ${filePrefix}ouvrage · niv ${q.niveau_cible} · <b style="color:var(--phosphor)">cycle ${eta.tickArrivee}</b> <span style="color:var(--bone-dim)">≈ ${eta.mins} min</span></div>`;
    } else if (pend) {
      footer = `<div class="queue" style="background:rgba(196,180,138,0.18);color:var(--brass)">
        <span class="pulse" style="background:var(--brass);box-shadow:0 0 0 0 rgba(196,180,138,0.6)"></span>
        scellé · niv ${pend.niveau_cible} · <b style="color:var(--brass)">prochain cycle</b></div>`;
    } else if (state.rules && batDef(k)) {
      const cost = nextCost(k, lvl);
      const dur = nextDureeUtj(k, lvl, p);
      const ticks = utjToTicks(dur);
      const afford = canAfford(p, cost);
      const pending = state.pending.has(k);
      const costHtml = Object.entries(cost || {}).map(([res, v]) => {
        const stock = p.ressources?.[res]?.stock || 0;
        const bad = stock < v ? ' bad' : '';
        return `<span><b class="${bad}">${fmtCompact(v)}</b> ${ICOS[res] || res}</span>`;
      }).join(' ');
      const RES_LABEL_DELTA = { mine_ferrum: 'Fe', extracteur_lumen: 'Lu', synthetiseur_plasmide: 'Pl' };
      const resLbl = RES_LABEL_DELTA[k];
      let prodDeltaHtml = '';
      if (resLbl) {
        const curProd  = simProd(k, lvl, p);
        const nextProd = simProd(k, lvl + 1, p);
        if (nextProd != null) {
          if (curProd != null) {
            const delta = nextProd - curProd;
            const pct = Math.round(delta / curProd * 100);
            prodDeltaHtml = `<div class="prod-delta">→ <b>+${fmtCompact(nextProd)}</b> ${resLbl}/utj <span>(+${fmtCompact(delta)}, +${pct}%)</span></div>`;
          } else {
            prodDeltaHtml = `<div class="prod-delta">→ <b>+${fmtCompact(nextProd)}</b> ${resLbl}/utj</div>`;
          }
        }
      }
      footer = `<div class="upg">
        <div class="cost">${costHtml}</div>
        <span class="dur" title="+1 tick de queue avant demarrage">${ticksLabel(ticks)} <span style="color:var(--bone-dim)">+ queue</span></span>
        <button data-improve="${k}" ${(!afford || pending) ? 'disabled' : ''}>${pending ? '…' : 'Améliorer'}</button>
        ${prodDeltaHtml}
      </div>`;
    }
    const effet = batEffet(k, lvl, p);
    const tip = batTooltip(k, lvl, p);
    return `<div class="bcard ${lvl === 0 && !q ? 'zero' : ''}" data-tip="${escapeHtml(tip)}">
      <div class="gl">${ico}</div>
      <div class="nm">${labels[k] || k}<small>${taglines[k] || 'structure'}</small></div>
      <div class="lvl">${lvl}<small>niveau</small></div>
      ${effet ? `<div class="effet">${effet}</div>` : ''}
      ${footer}
    </div>`;
  }).join('')}</div>`;
}

function renderBatiments(p) {
  const v = document.getElementById('vBat');
  if (!p) { v.innerHTML = `<div class="empty-stamp">néant</div>`; return; }
  v.innerHTML = `<h2 class="sect">Édifices planétaires <span class="num">§ B</span> <span class="rule"></span></h2>${renderBatGrid(p)}`;
}

function renderRecherche(emp) {
  const v = document.getElementById('vRec');
  if (!emp || !state.rules?.recherches) {
    v.innerHTML = `<h2 class="sect">Sciences <span class="num">§ R</span> <span class="rule"></span></h2><div class="empty-stamp">cabinets fermés</div>`;
    return;
  }
  v.innerHTML = `<h2 class="sect">Sciences <span class="num">§ R</span> <span class="rule"></span></h2>${renderRecGrid(emp)}`;
}

function renderRecGrid(emp) {
  const ICOS = { ferrum: 'Fe', lumen: 'Lu', plasmide: 'Pl' };
  const recs = state.rules.recherches || {};
  const queue = emp.file_recherche || [];
  const queuedTech = queue[0]?.technologie;
  const tickCur = state.manifest?.tick ?? 0;
  // Un seul ordre de recherche pending à la fois — détecté par tick_cible
  const pendingOrder = (emp._ordres?.tick_cible >= tickCur + 1)
    ? (emp._ordres?.ordres || []).find(o => o.type === 'recherche')
    : null;

  const cards = Object.entries(recs).map(([tech, def]) => {
    const niveauActuel = (emp.recherche || {})[tech] || 0;
    const niveauCible = niveauActuel + 1;
    const cost = nextRecCost(tech, niveauActuel);
    const dur = nextRecDureeUtj(tech, niveauActuel);
    const mins = Math.round((dur || 0) * utjMin());
    const afford = canAffordEmp(emp, cost);
    // Vérifier requiert (sur les recherches uniquement, simple : requiert: { tech: niv })
    let missing = null;
    if (def.requiert) {
      for (const [rk, rv] of Object.entries(def.requiert)) {
        if ((emp.recherche?.[rk] || 0) < rv) { missing = `${labels[rk] || rk} niv ${rv}`; break; }
      }
    }
    const isQueued = queuedTech === tech;
    const isPending = state.pending.has('rec:' + tech);
    const orderPending = pendingOrder && pendingOrder.technologie === tech;
    const anyOrder = !!pendingOrder; // un seul slot recherche

    const costHtml = Object.entries(cost || {}).map(([res, vv]) => {
      const stock = (emp.planetes || []).reduce((a, pl) => a + (pl.ressources?.[res]?.stock || 0), 0);
      const bad = stock < vv ? ' bad' : '';
      return `<span><b class="${bad}">${fmtCompact(vv)}</b> ${ICOS[res] || res}</span>`;
    }).join(' ');

    let footer;
    if (isQueued) {
      const q = queue[0];
      const remain = Math.max(0, q.fin_utj || 0);
      const eta = chantierETA(remain);
      footer = `<div class="queue"><span class="pulse"></span>en cours · niv ${q.niveau_cible} · <b>cycle ${eta.tickArrivee}</b> <span style="color:var(--bone-dim)">≈ ${eta.mins} min</span></div>`;
    } else if (orderPending) {
      footer = `<div class="queue" style="background:rgba(196,180,138,0.18);color:var(--brass)">
        <span class="pulse" style="background:var(--brass);box-shadow:0 0 0 0 rgba(196,180,138,0.6)"></span>
        scellé · niv ${pendingOrder.niveau_cible} · <b style="color:var(--brass)">prochain cycle</b></div>`;
    } else {
      const reqBad = !!missing;
      const blocked = reqBad || !afford || isPending || anyOrder;
      const btnLbl = isPending ? '…' : 'Lancer';
      const title = reqBad ? `requiert ${missing}` : (anyOrder ? 'un autre ordre recherche est déjà signé' : '');
      footer = `<div class="upg">
        <div class="cost">${costHtml}</div>
        <span class="dur" title="+1 tick de queue avant demarrage">${ticksLabel(utjToTicks(dur))} <span style="color:var(--bone-dim)">+ queue</span></span>
        <button data-research="${tech}" ${blocked ? 'disabled' : ''} title="${title}">${btnLbl}</button>
      </div>`;
      if (reqBad) {
        footer = `<div class="req">requiert <b>${missing}</b></div>` + footer;
      }
    }

    const tip = techTooltip(tech, def, niveauActuel);
    return `<div class="bcard ${niveauActuel === 0 ? 'zero' : ''}" data-tip="${escapeHtml(tip)}">
      <div class="gl">${icons.laboratoire}</div>
      <div class="nm">${labels[tech] || tech}<small>discipline scientifique</small></div>
      <div class="lvl">${niveauActuel}<small>niveau</small></div>
      ${footer}
    </div>`;
  }).join('');
  return `<div class="bgrid">${cards}</div>`;
}

function renderFlotte(p) {
  const v = document.getElementById('vFlt');
  if (!p || !state.rules?.vaisseaux) {
    v.innerHTML = `<h2 class="sect">Flotte au sol <span class="num">§ F</span> <span class="rule"></span></h2><div class="empty-stamp">silos vides</div>`;
    return;
  }
  v.innerHTML = `<h2 class="sect">Flotte au sol <span class="num">§ F</span> <span class="rule"></span></h2>${renderUnitGrid(p, 'vaisseaux')}`;
}

function renderDefense(p) {
  const v = document.getElementById('vDef');
  if (!p || !state.rules?.defenses) {
    v.innerHTML = `<h2 class="sect">Défenses <span class="num">§ D</span> <span class="rule"></span></h2><div class="empty-stamp">périmètre indéfendu</div>`;
    return;
  }
  v.innerHTML = `<h2 class="sect">Défenses <span class="num">§ D</span> <span class="rule"></span></h2>${renderUnitGrid(p, 'defenses')}`;
}

function renderUnitGrid(p, kind) {
  const ICOS = { ferrum: 'Fe', lumen: 'Lu', plasmide: 'Pl' };
  const defs = state.rules[kind] || {};
  const owned = (kind === 'vaisseaux' ? (p.flotte_au_sol || {}) : (p.defenses || {}));
  const fallbackIco = kind === 'vaisseaux' ? icons.default_f : icons.default_d;
  const subDefault = kind === 'vaisseaux' ? 'unité spatiale' : 'pièce défensive';

  const queueMap = {};
  for (const c of (p.file_construction || [])) {
    if (!queueMap[c.unite]) queueMap[c.unite] = { qty: 0, fin_utj: 0 };
    queueMap[c.unite].qty += c.quantite || 0;
    queueMap[c.unite].fin_utj = Math.max(queueMap[c.unite].fin_utj, c.fin_utj || 0);
  }

  // Ordres pending (construction) — agréger qty par unité
  const emp = state.players[state.current];
  const tickCur = state.manifest?.tick ?? 0;
  const pendMap = {};
  if (emp?._ordres?.tick_cible >= tickCur + 1) {
    for (const o of (emp._ordres.ordres || [])) {
      if (o.type === 'construction' && o.planete === p.nom) {
        pendMap[o.unite] = (pendMap[o.unite] || 0) + (o.quantite || 0);
      }
    }
  }

  const empRes = (emp?.recherche || {});
  const cards = Object.entries(defs).map(([unite, def]) => {
    const have = owned[unite] || 0;
    const cost = def.cout || {};
    const dur = def.duree_utj || 0;
    let missing = null;
    if (def.requiert) {
      for (const [rk, rv] of Object.entries(def.requiert)) {
        if ((empRes[rk] || 0) < rv) { missing = `${labels[rk] || rk} niv ${rv}`; break; }
      }
    }
    const costHtml = Object.entries(cost).map(([res, vv]) => {
      const isGlobal = res === 'singularite' || res === 'influence';
      const stock = isGlobal
        ? (emp?.ressources_globales?.[res] || 0)
        : (p.ressources?.[res]?.stock || 0);
      const bad = stock < vv ? ' bad' : '';
      const lbl = ICOS[res] || (res === 'singularite' ? 'Σ' : res === 'influence' ? '∞' : res);
      return `<span><b class="${bad}">${fmtCompact(vv)}</b> ${lbl}</span>`;
    }).join(' ');

    const q = queueMap[unite];
    const pendQty = pendMap[unite] || 0;
    const pendingKey = `construction:${unite}`;
    const isPending = state.pending.has(pendingKey);

    let footer = '';
    if (q) {
      const remain = q.fin_utj;
      const eta = chantierETA(remain);
      footer += `<div class="queue"><span class="pulse"></span>en construction · <b>${q.qty} unités</b> · cycle ${eta.tickArrivee} <span style="color:var(--bone-dim)">≈ ${eta.mins} min</span></div>`;
    }
    if (pendQty > 0) {
      footer += `<div class="queue" style="background:rgba(196,180,138,0.18);color:var(--brass)">
        <span class="pulse" style="background:var(--brass);box-shadow:0 0 0 0 rgba(196,180,138,0.6)"></span>
        scellé · <b style="color:var(--brass)">${pendQty} unités</b> · prochain cycle</div>`;
    }

    const max1 = def.max_par_planete === 1;
    const reqBad = !!missing;
    const baseDisabled = reqBad || isPending;

    const mkBtn = (n, sec) => {
      const totalCost = {};
      for (const [k, v] of Object.entries(cost)) totalCost[k] = v * n;
      const afford = canAfford(p, totalCost);
      const overMax = max1 && (have + pendQty + (q?.qty || 0) + n > 1);
      const dis = baseDisabled || !afford || overMax;
      return `<button class="${sec ? 'sec' : ''}" data-construct="${unite}" data-qty="${n}" ${dis ? 'disabled' : ''}>+${n}</button>`;
    };

    const buttons = max1
      ? mkBtn(1, false)
      : `${mkBtn(1, true)}${mkBtn(10, true)}${mkBtn(100, false)}`;

    footer += `<div class="upg qrow">
      <div class="cost">${costHtml}</div>
      <span class="dur">${dur} <span class="utj-help" title="1 tick = 6 UTJ ≈ 15 min (cadence Mutinynet × 30 blocs). Coût en UTJ par unite ; multiplie par la quantite construite.">UTJ</span>/u</span>
      <div class="qbtns">${isPending ? '<button disabled>…</button>' : buttons}</div>
    </div>`;
    if (reqBad) footer = `<div class="req">requiert <b>${missing}</b></div>` + footer;

    const tip = unitTooltip(unite, def, have, kind);
    const ico = codexImg(unite, labels[unite]) || fallbackIco;
    return `<div class="bcard ${have === 0 ? 'zero' : ''}" data-tip="${escapeHtml(tip)}">
      <div class="gl">${ico}</div>
      <div class="nm">${labels[unite] || unite}<small>${taglines[unite] || subDefault}</small></div>
      <div class="lvl">${fmt(have)}<small>${kind === 'vaisseaux' ? 'possédés' : 'déployées'}</small></div>
      ${footer}
    </div>`;
  }).join('');
  return `<div class="bgrid">${cards}</div>`;
}

function renderGalaxie() {
  const v = document.getElementById('vGal');
  const g = state.galaxie;
  if (!g || !g.systemes) { v.innerHTML = `<h2 class="sect">Galaxie</h2><div class="empty-stamp">cartographie indisponible</div>`; return; }
  const myPlanet = state.players[state.current]?.planetes?.[0];
  const myCoord = myPlanet?.coordonnees ? myPlanet.coordonnees.join(':') : null;
  // Clé de mon système (coord sans position). On accepte les deux formats possibles.
  const mySystemKey = myPlanet?.coordonnees
    ? myPlanet.coordonnees.slice(0, 2).join(':')
    : null;

  // Index des flottes hostiles incoming, par nom de planète cible.
  // Une flotte est "hostile sur moi" si vers.joueur === current et type ≠ retour.
  const me = state.current;
  const hostileTypes = new Set(['attaque', 'siege', 'pillage', 'bombardement', 'espionnage']);
  const incomingByPlanet = new Map();
  for (const [pname, e] of Object.entries(state.players || {})) {
    if (pname === me) continue;
    for (const f of (e.flottes_en_vol || [])) {
      if (f.vers?.joueur !== me) continue;
      const dest = f.vers?.planete;
      if (!dest) continue;
      const t = (f.type_mission || '').toLowerCase();
      if (!hostileTypes.has(t)) continue;
      if (!incomingByPlanet.has(dest)) incomingByPlanet.set(dest, []);
      incomingByPlanet.get(dest).push({ from: pname, type: t, arr: f.tick_arrivee, comp: f.composition });
    }
  }

  // Index nom de planète → { coord, i } pour positionner les trajectoires.
  const planetIndex = new Map();
  for (const [coord, sys] of Object.entries(g.systemes)) {
    for (const [k, pos] of Object.entries(sys.positions || {})) {
      if (pos?.type === 'planete' && pos.nom) {
        planetIndex.set(pos.nom, { coord, i: parseInt(k, 10) });
      }
    }
  }

  // Trajectoires intra-système, indexées par coord du système.
  // Cross-system non rendu (les SVG sont séparés par carte).
  const routesBySystem = new Map();
  const pushRoute = (sysKey, route) => {
    if (!routesBySystem.has(sysKey)) routesBySystem.set(sysKey, []);
    routesBySystem.get(sysKey).push(route);
  };
  for (const [pname, e] of Object.entries(state.players || {})) {
    for (const f of (e.flottes_en_vol || [])) {
      const fromName = f.depuis?.planete;
      const toName = f.vers?.planete;
      if (!fromName || !toName) continue;
      const a = planetIndex.get(fromName);
      const b = planetIndex.get(toName);
      if (!a || !b || a.coord !== b.coord) continue;
      const isMine = pname === me;
      const isHostileOnMe = !isMine && f.vers?.joueur === me &&
        hostileTypes.has((f.type_mission || '').toLowerCase());
      const kind = isHostileOnMe ? 'hostile' : (isMine ? 'friendly' : 'neutral');
      if (kind === 'neutral') continue; // on ne montre que mes flottes et les menaces sur moi
      pushRoute(a.coord, { from: a.i, to: b.i, kind, type: f.type_mission });
    }
  }

  // ─── orbital layout constants ─────────────────────────────────
  const ORB_N = 15, ORB_RMIN = 42, ORB_RMAX = 240;
  const orbR = i => ORB_RMIN + (i - 1) * (ORB_RMAX - ORB_RMIN) / (ORB_N - 1);
  // Golden-angle pour répartition douce et déterministe
  const orbA = i => i * 137.508 * Math.PI / 180;
  const orbXY = i => [Math.cos(orbA(i)) * orbR(i), Math.sin(orbA(i)) * orbR(i)];
  const classColor = {
    tellurique: '#7fa570', cristalline: '#3a8a8a', glacee: '#88c8e0',
    volcanique: '#a83a25', gazeuse: '#5a3a6a'
  };
  const planetRadius = cls => cls === 'gazeuse' ? 8.5 : cls === 'tellurique' ? 6.5 : 7;
  // Couleur d'étoile par type spectral
  const starColor = (type) => {
    const t = (type || 'G').toUpperCase();
    return ({ O:'#9bb0ff', B:'#aabfff', A:'#cad7ff', F:'#f8f7ff',
              G:'#f7e09a', K:'#ffd2a1', M:'#ffaa6f' })[t] || '#f7e09a';
  };
  const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

  let html = `<h2 class="sect">Cartographie galactique <span class="num">§ G</span> <span class="rule"></span></h2><div class="galaxy">`;
  let defsId = 0;
  // Mon système en premier, puis les autres dans l'ordre d'origine.
  const systemEntries = Object.entries(g.systemes).sort(([a], [b]) => {
    if (a === mySystemKey) return -1;
    if (b === mySystemKey) return 1;
    return 0;
  });
  for (const [coord, sys] of systemEntries) {
    const star = sys.etoile || {};
    const sc = starColor(star.type);
    const sysIdx = defsId++;
    const haloId = `starHalo-${sysIdx}`;
    const gasRingId = `gasRing-${sysIdx}`;

    let bodiesSvg = '';
    let ringsSvg = '';
    let routesSvg = '';

    for (let i = 1; i <= ORB_N; i++) {
      const pos = sys.positions?.[i] || { type: 'empty' };
      const t = pos.type;
      const cls = pos.classe;
      const owner = pos.proprietaire;
      const fullCoord = `${coord}:${i}`;
      const isMine = fullCoord === myCoord;
      const isEnemy = t === 'planete' && owner && owner !== state.current && !isMine;
      const isAllyOwn = t === 'planete' && owner === state.current && !isMine;
      const isFree = t === 'planete' && (!owner || owner === '~' || owner === 'null');
      const isMissionTarget = isEnemy || isAllyOwn;
      const incoming = (t === 'planete' && pos.nom) ? incomingByPlanet.get(pos.nom) : null;
      const hasIncoming = incoming && incoming.length > 0;

      const [x, y] = orbXY(i);

      // ring de l'orbite — seulement si quelque chose est posé
      if (t !== 'empty') {
        const r = orbR(i);
        ringsSvg += `<circle class="ring${(t === 'planete' && owner) ? ' active' : ''}" cx="0" cy="0" r="${r.toFixed(1)}"/>`;
      }

      if (t === 'empty') {
        bodiesSvg += `<circle class="pos-marker" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="1.6"/>`;
        continue;
      }

      if (t === 'asteroide') {
        // cluster de 3 rochers
        bodiesSvg += `<g class="asteroid-cluster" transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
          <title>astéroïde · §${i}</title>
          <circle class="asteroid" cx="-2.2" cy="-1" r="1.4"/>
          <circle class="asteroid" cx="0" cy="1.4" r="1.5"/>
          <circle class="asteroid" cx="2.2" cy="-0.6" r="1.2"/>
        </g>`;
        continue;
      }

      // planète
      const radius = planetRadius(cls);
      const color = classColor[cls] || '#888';
      // tooltip text (natif via <title>)
      let tip = `${pos.nom || 'planète'} · ${cls || '?'}${owner ? ' · ' + owner : ' · libre'}`;
      if (isEnemy) tip += ' · clic → mission';
      else if (isAllyOwn) tip += ' · clic → transport';
      else if (isFree) tip += ' · clic → coloniser';
      if (hasIncoming) {
        const cur = state.manifest?.tick ?? 0;
        for (const inc of incoming) {
          const left = inc.arr ? Math.max(0, inc.arr - cur) : null;
          tip += ` · ⚠ ${inc.type} ← ${inc.from}${left != null ? ` (T-${left})` : ''}`;
        }
      }

      let dataAttrs = '';
      if (isMissionTarget) dataAttrs = ` data-mission-target="${esc(owner)}|${esc(pos.nom || '')}"`;
      else if (isFree)     dataAttrs = ` data-coloniser-target="${esc(coord)}|${i}|${esc(cls || '')}"`;

      const actionable = isMissionTarget || isFree;
      const groupClasses = ['planet', `c-${cls || 'unknown'}`,
        isMine ? 'mine' : '', isEnemy ? 'enemy' : '',
        isAllyOwn ? 'allyown' : '', isFree ? 'free' : '',
        hasIncoming ? 'incoming' : '', !actionable ? 'no-action' : ''
      ].filter(Boolean).join(' ');

      // Bloc « scalable » (le corps qui grossit au hover) — uniquement les formes centrées sur (0,0)
      let scalerInner = '';
      if (cls === 'gazeuse') {
        scalerInner += `<ellipse rx="${(radius * 2.1).toFixed(1)}" ry="${(radius * 0.55).toFixed(1)}" fill="none" stroke="url(#${gasRingId})" stroke-width="2.2" transform="rotate(-18)"/>`;
        scalerInner += `<ellipse rx="${(radius * 1.55).toFixed(1)}" ry="${(radius * 0.4).toFixed(1)}" fill="none" stroke="rgba(196,180,138,.7)" stroke-width=".8" transform="rotate(-18)"/>`;
      }
      if (isMine) scalerInner += `<circle class="mine-halo" r="${radius + 6}"/>`;
      scalerInner += `<circle class="body" r="${radius}" fill="${color}"/>`;

      // Bloc « overlay » (labels, ⚠) — fixe, ne suit pas le scale du hover
      let overlayInner = '';
      overlayInner += `<text class="label-num" y="${(radius + 4).toFixed(1)}">§${i}${pos.nom ? ' · ' + esc(pos.nom) : ''}</text>`;
      if (owner) {
        const ownFill = isEnemy ? '#a83a25' : (isMine ? '#0e1d33' : (isAllyOwn ? '#5a7a3a' : '#8a7c64'));
        overlayInner += `<text class="owner-tag" y="${(-radius - 12).toFixed(1)}" fill="${ownFill}">${esc(owner.slice(0, 7))}</text>`;
      } else if (isFree) {
        overlayInner += `<text class="owner-tag" y="${(-radius - 12).toFixed(1)}" fill="#8a7c64">libre</text>`;
      }
      if (hasIncoming) {
        overlayInner += `<text class="incoming-warn" x="${radius + 6}" y="${-radius - 2}">⚠</text>`;
      }

      bodiesSvg += `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
        <g class="${groupClasses}" data-c="${esc(cls || '')}"${dataAttrs}>
          <title>${esc(tip)}</title>
          <g class="scaler">${scalerInner}</g>
          ${overlayInner}
        </g>
      </g>`;
    }

    // Trajectoires de flotte intra-système (mes flottes + flottes hostiles sur moi).
    const sysRoutes = routesBySystem.get(coord) || [];
    sysRoutes.forEach((r, k) => {
      const [x1, y1] = orbXY(r.from);
      const [x2, y2] = orbXY(r.to);
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      // Arc latéral pour donner du mouvement
      const nx = -dy / len, ny = dx / len;
      const curveAmt = Math.min(40, len * 0.18);
      const cx = (x1 + x2) / 2 + nx * curveAmt;
      const cy = (y1 + y2) / 2 + ny * curveAmt;
      const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      const pid = `route-${sysIdx}-${k}`;
      const dur = r.kind === 'hostile' ? '5.5s' : '4.2s';
      routesSvg += `<path id="${pid}" class="route ${r.kind}" d="${d}"/>`;
      // Vaisseau-cône qui glisse + 3 points de traînée décalés.
      routesSvg += `<polygon class="ship ${r.kind}" points="5,0 -3,-2.6 -3,2.6">
        <animateMotion dur="${dur}" repeatCount="indefinite" rotate="auto">
          <mpath xlink:href="#${pid}" href="#${pid}"/>
        </animateMotion>
      </polygon>`;
      for (let n = 1; n <= 3; n++) {
        routesSvg += `<circle class="ship-trail ${r.kind}" r="${(1.6 - n * 0.35).toFixed(2)}"
          fill="${r.kind === 'hostile' ? '#a83a25' : '#5a7a3a'}"
          opacity="${(0.55 - n * 0.15).toFixed(2)}">
          <animateMotion dur="${dur}" repeatCount="indefinite" begin="-${(n * 0.18).toFixed(2)}s">
            <mpath xlink:href="#${pid}" href="#${pid}"/>
          </animateMotion>
        </circle>`;
      }
    });

    const isMySystem = coord === mySystemKey;
    html += `<div class="system${isMySystem ? ' my-system' : ''}"><header>
      <span class="star-name">${esc(star.nom || '—')}</span>
      <span class="star-meta">type ${esc(star.type || '?')} · ${esc(star.temperature_k || '?')}K</span>
      ${isMySystem ? '<span class="here-badge" title="vous êtes ici">★ ici</span>' : ''}
      <span class="coord">${esc(coord)}</span>
    </header><div class="orbital">
      <svg viewBox="-260 -260 520 520" xmlns:xlink="http://www.w3.org/1999/xlink" aria-label="système ${esc(star.nom || coord)}">
        <defs>
          <radialGradient id="${haloId}" cx="50%" cy="50%" r="50%">
            <stop offset="0%"  stop-color="#fff2c2" stop-opacity="1"/>
            <stop offset="18%" stop-color="${sc}" stop-opacity=".85"/>
            <stop offset="42%" stop-color="#d49a3a" stop-opacity=".32"/>
            <stop offset="72%" stop-color="#a83a25" stop-opacity=".10"/>
            <stop offset="100%" stop-color="#a83a25" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="${gasRingId}" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stop-color="#c4b48a" stop-opacity="0"/>
            <stop offset="50%"  stop-color="#c4b48a" stop-opacity=".55"/>
            <stop offset="100%" stop-color="#c4b48a" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <g class="rings">${ringsSvg}</g>
        <circle cx="0" cy="0" r="64" fill="url(#${haloId})" opacity=".85">
          <animate attributeName="r" values="60;68;60" dur="6s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values=".7;.92;.7" dur="6s" repeatCount="indefinite"/>
        </circle>
        <circle cx="0" cy="0" r="22" fill="url(#${haloId})" opacity=".95"/>
        <circle cx="0" cy="0" r="13" fill="${sc}" stroke="#d49a3a" stroke-width=".6"/>
        <g class="routes">${routesSvg}</g>
        <text class="star-label" y="42">${esc(star.nom || '—')}</text>
        <text class="star-meta-text" y="56">${esc(star.type || '?')} · ${esc(star.temperature_k || '?')}K</text>
        <g class="bodies">${bodiesSvg}</g>
      </svg>
    </div></div>`;
  }
  html += `</div>`;
  v.innerHTML = html;
  // Marque la sentinelle après le premier rendu — coupe l'animation d'entrée
  // sur les refresh suivants (sinon les .system flashent à chaque tick).
  if (!v.dataset.rendered) v.dataset.rendered = '1';
}

function renderJournal(p, emp) {
  const v = document.getElementById('vJou');
  const m = state.manifest;
  const lines = [];
  lines.push({ tick: m?.tick ?? 0, txt: 'lecture du protocole', tone: 'phos' });
  if (p?.file_chantier?.length) {
    for (const c of p.file_chantier) {
      lines.push({ tick: m.tick, txt: `chantier · ${labels[c.batiment] || c.batiment} → niv ${c.niveau_cible} (${Math.max(0, c.fin_utj || 0)} UTJ restants)`, tone: 'brass' });
    }
  }
  if (emp?.flottes_en_vol?.length) {
    for (const f of emp.flottes_en_vol) {
      let dest;
      if (f.type_mission === 'colonisation') {
        dest = `${f.vers?.systeme}:${f.vers?.position}${f.nom_colonie ? ' (' + f.nom_colonie + ')' : ''}`;
      } else {
        dest = f.vers?.planete || (typeof f.vers === 'string' ? f.vers : '?');
      }
      lines.push({ tick: m.tick, txt: `${f.type_mission} · ${f.depuis?.planete} → ${dest}`, tone: 'rust' });
    }
  }
  v.innerHTML = `<h2 class="sect">Journal de bord <span class="num">§ J</span> <span class="rule"></span></h2>
    <div style="font-family:var(--mono);font-size:12px;line-height:2.1">
    ${lines.map(l => `<div style="display:flex;gap:18px;border-bottom:1px dashed var(--hairline);padding:6px 0">
      <span style="color:var(--brass-dim);font-family:var(--display);min-width:60px">T${String(l.tick).padStart(3,'0')}</span>
      <span style="color:${l.tone==='phos'?'var(--phosphor)':l.tone==='rust'?'var(--rust)':'var(--bone)'}">${l.txt}</span>
    </div>`).join('')}
    </div>`;
}

// État local du panneau rapports : index du rapport ouvert (-1 = liste).
const rapState = { openIdx: -1, openKey: null };

function collectRapports(me) {
  const r = state.reports || {};
  const out = [];
  for (const it of (r.intelByPlayer?.[me] || [])) {
    out.push({ kind: 'intel', tick: it.tick, filename: it.filename, content: it.content });
  }
  for (const it of (r.alertsByPlayer?.[me] || [])) {
    out.push({ kind: 'alert', tick: it.tick, filename: it.filename, content: it.content });
  }
  for (const b of (r.battles || [])) {
    if (b.attaquant === me || b.defenseur === me) {
      out.push({ kind: 'battle', tick: b.tick, filename: b.filename, content: b.content,
                 attaquant: b.attaquant, defenseur: b.defenseur, lieu: b.lieu, issue: b.issue });
    }
  }
  // tri descendant par tick (récents en haut)
  out.sort((a, b) => b.tick - a.tick);
  return out;
}

// Rendu markdown minimal — suffisant pour les rapports générés par tick-core.
function renderMd(md) {
  let s = String(md || '');
  // strip frontmatter YAML (--- ... ---)
  s = s.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // escape HTML
  s = s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  // headers
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // blockquotes
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // bullets — laisse en texte préformaté (white-space: pre-wrap fera le reste)
  return s;
}

function rapportTitle(r) {
  if (r.kind === 'intel') {
    const m = /Rapport d'espionnage — ([^\n]+)/.exec(r.content);
    return m ? `espionnage · ${m[1]}` : 'rapport d\'espionnage';
  }
  if (r.kind === 'alert') return `alerte · espionnage intercepté`;
  if (r.kind === 'battle') {
    const me = state.current;
    const adv = r.attaquant === me ? r.defenseur : r.attaquant;
    const role = r.attaquant === me ? 'attaque' : 'défense';
    return `${role} · ${adv || '?'}/${r.lieu || '?'}`;
  }
  return 'rapport';
}

function rapportIssueLabel(r) {
  if (r.kind !== 'battle' || !r.issue) return '';
  const map = {
    'victoire-attaquant': 'victoire att.',
    'victoire-defenseur': 'victoire déf.',
    'match-nul': 'nul',
  };
  return map[r.issue] || r.issue;
}

// Extrait la cible d'un rapport d'espionnage depuis le frontmatter YAML.
// Format produit par engine/tick-core.mjs (renderIntelReport) :
//   ---
//   type: rapport-espionnage
//   tick: 42
//   cible: { joueur: NomJoueur, planete: NomPlanete }
//   niveau_intel: 3
//   ---
// Fallback : split sur le titre "Rapport d'espionnage — Joueur/Planete".
function parseIntelTarget(r) {
  if (!r || r.kind !== 'intel') return null;
  const c = String(r.content || '');
  const mCible = /cible\s*:\s*\{\s*joueur\s*:\s*([^,}]+?)\s*,\s*planete\s*:\s*([^,}]+?)\s*\}/i.exec(c);
  if (mCible) {
    const joueur = mCible[1].replace(/^['"]|['"]$/g, '').trim();
    const planete = mCible[2].replace(/^['"]|['"]$/g, '').trim();
    let niveau = null;
    const mN = /niveau_intel\s*:\s*(\d+)/i.exec(c);
    if (mN) niveau = parseInt(mN[1], 10);
    if (joueur && planete) return { joueur, planete, niveau };
  }
  const mT = /Rapport d'espionnage — ([^\/\n]+)\/([^\n]+)/.exec(c);
  if (mT) return { joueur: mT[1].trim(), planete: mT[2].trim(), niveau: null };
  return null;
}

// Bascule sur la galaxie, ouvre le compositeur de mission pré-réglé en attaque.
function launchAttackFromReport(joueurCible, planeteCible) {
  if (!joueurCible || !planeteCible) return;
  state.view = 'galaxie';
  localStorage.setItem('aetheris.view', 'galaxie');
  applyView();
  // openMission gère le pré-set des champs ; on force ensuite le type "attaque"
  // si le bouton n'est pas désactivé (ex. cible alliée).
  openMission(joueurCible, planeteCible);
  const atkBtn = document.querySelector('#missionType button[data-mt="attaque"]');
  if (atkBtn && !atkBtn.disabled) {
    mission.type = 'attaque';
    document.querySelectorAll('#missionType button').forEach(x =>
      x.classList.toggle('on', x.dataset.mt === 'attaque'));
    if (typeof renderMissionFleet === 'function') renderMissionFleet();
  }
}

function renderRapports() {
  const v = document.getElementById('vRap');
  if (!v) return;
  const me = state.current;
  if (!me) { v.innerHTML = `<h2 class="sect">Rapports</h2><div class="empty-stamp">aucun commandant sélectionné</div>`; return; }

  const items = collectRapports(me);

  if (rapState.openIdx >= 0 && rapState.openKey) {
    const r = items.find(x => `${x.kind}|${x.filename}` === rapState.openKey);
    if (r) {
      let actionsHtml = '';
      if (r.kind === 'intel') {
        const tgt = parseIntelTarget(r);
        if (tgt) {
          // Niveau d'intel < 2 = pas de visibilité sur les défenses adverses.
          const lowIntel = tgt.niveau != null && tgt.niveau < 2;
          actionsHtml = `<div class="rap-actions">
            ${lowIntel ? `<div class="rap-warn">Niveau d'intel insuffisant pour évaluer les défenses</div>` : ''}
            <button type="button" class="rap-attack-btn" id="rapAttackBtn"
              data-target-joueur="${escapeHtml(tgt.joueur)}"
              data-target-planete="${escapeHtml(tgt.planete)}">⚔ Lancer une attaque sur cette planète</button>
          </div>`;
        }
      }
      v.innerHTML = `<h2 class="sect">Rapports <span class="num">§ R</span> <span class="rule"></span></h2>
        <a class="rap-back" id="rapBack">← retour à la liste</a>
        <div class="rap-detail">${renderMd(r.content)}</div>
        ${actionsHtml}`;
      const back = document.getElementById('rapBack');
      if (back) back.onclick = () => { rapState.openIdx = -1; rapState.openKey = null; renderRapports(); };
      const atk = document.getElementById('rapAttackBtn');
      if (atk) atk.onclick = () => {
        const j = atk.dataset.targetJoueur;
        const pl = atk.dataset.targetPlanete;
        launchAttackFromReport(j, pl);
      };
      return;
    }
    // clé périmée
    rapState.openIdx = -1; rapState.openKey = null;
  }

  if (!items.length) {
    v.innerHTML = `<h2 class="sect">Rapports <span class="num">§ R</span> <span class="rule"></span></h2>
      <div class="empty-stamp">aucun rapport — espionne ou attaque pour en générer</div>`;
    return;
  }

  let html = `<h2 class="sect">Rapports <span class="num">§ R</span> <span class="rule"></span></h2><div class="rap-list">`;
  for (const r of items) {
    const key = `${r.kind}|${r.filename}`;
    html += `<div class="rap-item ${r.kind}" data-rap-key="${escapeHtml(key)}">
      <span class="rap-tick">T${String(r.tick).padStart(3,'0')}</span>
      <span class="rap-kind">${r.kind === 'intel' ? 'Intel' : r.kind === 'alert' ? 'Alerte' : 'Bataille'}</span>
      <span class="rap-title">${escapeHtml(rapportTitle(r))}</span>
      <span class="rap-issue">${rapportIssueLabel(r)}</span>
    </div>`;
  }
  html += `</div>`;
  v.innerHTML = html;
  v.querySelectorAll('[data-rap-key]').forEach(el => {
    el.addEventListener('click', () => {
      rapState.openKey = el.dataset.rapKey;
      rapState.openIdx = 0;
      renderRapports();
    });
  });
}

function renderMarche(myPlanete, emp) {
  const v = document.getElementById('vMkt');
  if (!v) return;
  const RES = { ferrum: 'Fe', lumen: 'Lu', plasmide: 'Pl' };
  const PAIRES = ['ferrum-lumen', 'ferrum-plasmide', 'lumen-plasmide'];
  const books = state.manifest?.marche?.books || {};
  const me = state.current;
  const tickCur = state.manifest?.tick ?? 0;

  // Compteur top-bar : ordres ouverts à mon nom.
  let mineCount = 0;
  for (const k of PAIRES) {
    for (const o of (books[k] || [])) if (o.joueur === me) mineCount++;
  }
  const navCt = document.getElementById('ctMkt');
  if (navCt) navCt.textContent = mineCount || '—';

  // Mes ordres ouverts.
  const mineRows = [];
  for (const k of PAIRES) {
    for (const o of (books[k] || [])) {
      if (o.joueur === me) mineRows.push({ ...o, paire: k });
    }
  }
  mineRows.sort((a, b) => a.expire_tick - b.expire_tick);

  const fmtRatio = (n) => {
    if (!Number.isFinite(n)) return '—';
    return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  };
  const renderBookSide = (orders, side) => {
    if (!orders.length) return `<tr><td colspan="4" class="empty-rail">aucun ordre</td></tr>`;
    return orders.slice(0, 8).map(o => {
      const prixB_per_A = o.qty_demande_restant / o.qty_vend_restant;
      const isMe = o.joueur === me ? ' style="color:var(--brass);font-weight:600"' : '';
      return `<tr${isMe}>
        <td>${escapeHtml(o.joueur)}</td>
        <td class="num-c">${fmt(o.qty_vend_restant)} ${RES[o.vend]}</td>
        <td class="num-c">${fmt(o.qty_demande_restant)} ${RES[o.demande]}</td>
        <td class="num-c">${fmtRatio(prixB_per_A)}</td>
      </tr>`;
    }).join('');
  };

  const ratiosBase = state.rules?.marche?.ratio_base || {};
  const refRatio = (a, b) => (ratiosBase[b] && ratiosBase[a]) ? (ratiosBase[a] / ratiosBase[b]).toFixed(2) : '—';

  let html = `<h2 class="sect">Marché galactique <span class="num">§ M</span> <span class="rule"></span></h2>
    <div style="font-size:11px;color:var(--bone-dim);margin-bottom:14px;letter-spacing:0.02em;line-height:1.5">
      Pose un ordre limite ; il sera apparié au prochain tick avec un ordre opposé compatible. Les ordres non remplis expirent après 12 ticks (~3h) et te sont remboursés. Fee de 5% prélevée à chaque match (réduite par <em>terminal_marchand</em>).
    </div>`;

  // Mes ordres
  html += `<h3 class="sect" style="margin-top:8px">Mes ordres ouverts</h3>`;
  if (!mineRows.length) {
    html += `<div class="empty-stamp" style="margin-bottom:14px">aucun ordre en attente</div>`;
  } else {
    html += `<table class="hs-table" style="margin-bottom:18px"><thead><tr><th>Paire</th><th>Origine</th><th class="num-c">Vend (restant)</th><th class="num-c">Demande (restant)</th><th class="num-c">Expire (tick)</th></tr></thead><tbody>`;
    for (const o of mineRows) {
      html += `<tr>
        <td>${o.paire.split('-').map(r => RES[r]).join('↔')}</td>
        <td>${escapeHtml(o.planete)}</td>
        <td class="num-c">${fmt(o.qty_vend_restant)} ${RES[o.vend]}</td>
        <td class="num-c">${fmt(o.qty_demande_restant)} ${RES[o.demande]}</td>
        <td class="num-c">${o.expire_tick} <small style="color:var(--bone-dim)">(t+${o.expire_tick - tickCur})</small></td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  // Books par paire
  for (const k of PAIRES) {
    const [a, b] = k.split('-');
    const book = books[k] || [];
    const sellsA = book.filter(o => o.vend === a).sort((x, y) => (x.qty_demande_restant / x.qty_vend_restant) - (y.qty_demande_restant / y.qty_vend_restant));
    const sellsB = book.filter(o => o.vend === b).sort((x, y) => (x.qty_demande_restant / x.qty_vend_restant) - (y.qty_demande_restant / y.qty_vend_restant));
    html += `<h3 class="sect" style="margin-top:18px">${RES[a]} ↔ ${RES[b]} <span style="color:var(--bone-dim);font-weight:400;font-size:11px;margin-left:8px">référence ${refRatio(a, b)} ${RES[b]}/${RES[a]}</span></h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:8px">
        <div>
          <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--bone-dim);margin-bottom:4px">Vend ${RES[a]} → demande ${RES[b]}</div>
          <table class="hs-table"><thead><tr><th>Joueur</th><th class="num-c">Vend</th><th class="num-c">Demande</th><th class="num-c">${RES[b]}/${RES[a]}</th></tr></thead><tbody>${renderBookSide(sellsA, 'a')}</tbody></table>
        </div>
        <div>
          <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--bone-dim);margin-bottom:4px">Vend ${RES[b]} → demande ${RES[a]}</div>
          <table class="hs-table"><thead><tr><th>Joueur</th><th class="num-c">Vend</th><th class="num-c">Demande</th><th class="num-c">${RES[a]}/${RES[b]}</th></tr></thead><tbody>${renderBookSide(sellsB, 'b')}</tbody></table>
        </div>
      </div>`;
  }

  // Formulaire de pose
  const planetes = (emp?.planetes || []).map(p => ({ nom: p.nom, ressources: p.ressources }));
  const defaultPlanete = myPlanete?.nom || planetes[0]?.nom || '';
  html += `<h3 class="sect" style="margin-top:22px">Poser un ordre</h3>
    <div class="form-card" style="background:rgba(196,180,138,0.06);border:1px solid var(--hairline);border-radius:6px;padding:16px;display:grid;grid-template-columns:repeat(2,1fr);gap:12px;font-size:12px">
      <label>Planète d'origine
        <select id="mktPlanete" style="width:100%;margin-top:4px;font-family:var(--mono);padding:6px">
          ${planetes.map(p => `<option value="${escapeHtml(p.nom)}" ${p.nom === defaultPlanete ? 'selected' : ''}>${escapeHtml(p.nom)} (Fe ${fmtCompact(p.ressources?.ferrum?.stock || 0)} · Lu ${fmtCompact(p.ressources?.lumen?.stock || 0)} · Pl ${fmtCompact(p.ressources?.plasmide?.stock || 0)})</option>`).join('')}
        </select>
      </label>
      <label>Expire dans (ticks)
        <input id="mktExpire" type="number" min="1" max="48" value="12" style="width:100%;margin-top:4px;font-family:var(--mono);padding:6px"/>
      </label>
      <label>Je vends
        <div style="display:flex;gap:6px;margin-top:4px">
          <select id="mktVendRes" style="flex:0 0 80px;font-family:var(--mono);padding:6px">
            <option value="ferrum">Fe</option><option value="lumen">Lu</option><option value="plasmide">Pl</option>
          </select>
          <input id="mktVendQty" type="number" min="1" placeholder="quantité" style="flex:1;font-family:var(--mono);padding:6px"/>
        </div>
      </label>
      <label>Je demande
        <div style="display:flex;gap:6px;margin-top:4px">
          <select id="mktDemRes" style="flex:0 0 80px;font-family:var(--mono);padding:6px">
            <option value="lumen">Lu</option><option value="ferrum">Fe</option><option value="plasmide">Pl</option>
          </select>
          <input id="mktDemQty" type="number" min="1" placeholder="quantité" style="flex:1;font-family:var(--mono);padding:6px"/>
        </div>
      </label>
      <div style="grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px;margin-top:6px">
        <button id="mktSubmit" class="btn-primary" ${state.pending.has('mkt:pose') ? 'disabled' : ''}>${state.pending.has('mkt:pose') ? '…' : 'Poser l\'ordre'}</button>
      </div>
    </div>`;

  v.innerHTML = html;

  const btn = document.getElementById('mktSubmit');
  if (btn) btn.onclick = () => {
    const depuis = document.getElementById('mktPlanete').value;
    const vendRes = document.getElementById('mktVendRes').value;
    const demRes = document.getElementById('mktDemRes').value;
    const vendQty = parseInt(document.getElementById('mktVendQty').value, 10);
    const demQty = parseInt(document.getElementById('mktDemQty').value, 10);
    const expire = parseInt(document.getElementById('mktExpire').value, 10) || 12;
    if (vendRes === demRes) { toast('Paire invalide', 'Vend et demande doivent porter sur deux ressources distinctes.', true); return; }
    if (!vendQty || !demQty || vendQty <= 0 || demQty <= 0) { toast('Quantités invalides', 'Renseigne des quantités positives.', true); return; }
    submitMarchePoser({ depuis, vend: { [vendRes]: vendQty }, demande: { [demRes]: demQty }, expire_dans_ticks: expire });
  };
}

async function submitMarchePoser({ depuis, vend, demande, expire_dans_ticks }) {
  const pendingKey = 'mkt:pose';
  if (state.pending.has(pendingKey)) return;
  if (!cfg.ready) { openSettings(); toast('Wallet requis', 'Configure ton wallet Bitcoin dans les paramètres pour inscrire des ordres.', true); return; }
  state.pending.add(pendingKey); render();
  try {
    const [vendRes, vendQty] = Object.entries(vend)[0];
    const [demRes, demQty] = Object.entries(demande)[0];
    const message = `${state.current}: marché ${vendQty} ${vendRes} → ${demQty} ${demRes} (depuis ${depuis})`;
    const r = await appendOrderAndPush({ type: 'marche-poser', depuis, vend, demande, expire_dans_ticks }, message);
    toast('Ajouté au panier', `Marché ${vendQty} ${vendRes} → ${demQty} ${demRes} en attente (${r.count} ordre${r.count > 1 ? 's' : ''}).`);
  } catch (e) {
    toast('Échec', e.message || String(e), true);
  } finally {
    state.pending.delete(pendingKey); render();
  }
}

function renderClassement() {
  const v = document.getElementById('vCls');
  if (!v) return;
  const me = state.current;
  const rows = Object.entries(state.players || {})
    .map(([name, emp]) => ({
      name,
      score: emp?.score ?? 0,
      planetes: (emp?.planetes || []).length,
      flotte: Object.values((emp?.planetes || [])[0]?.flotte_au_sol || {}).reduce((a, b) => a + (b || 0), 0)
              + ((emp?.flottes_en_vol) || []).reduce((a, f) => a + Object.values(f.composition || {}).reduce((x, y) => x + (y || 0), 0), 0),
    }))
    .sort((a, b) => b.score - a.score);

  if (!rows.length) {
    v.innerHTML = `<h2 class="sect">Classement</h2><div class="empty-stamp">aucun empire</div>`;
    return;
  }

  const myEmp = state.players?.[me];
  const myRel = myEmp?.relations || {};
  const tickCur = state.manifest?.tick ?? 0;
  let html = `<h2 class="sect">Classement galactique <span class="num">§ C</span> <span class="rule"></span></h2>
    <table class="hs-table">
      <thead><tr><th class="rank">#</th><th>Empire</th><th>Relation</th><th class="num-c">Planètes</th><th class="num-c">Flotte</th><th class="score">Score</th></tr></thead>
      <tbody>`;
  rows.forEach((r, i) => {
    const isMe = r.name === me ? ' class="me"' : '';
    let relCell = '—';
    if (r.name !== me) {
      const rel = myRel[r.name];
      if (rel?.status === 'treve' && (rel.expire_tick || 0) > tickCur) {
        const ttl = rel.expire_tick - tickCur;
        relCell = `<span style="color:var(--green);font-weight:600" title="Trêve unilatérale active jusqu'au tick ${rel.expire_tick}">🕊 trêve · ${ttl} ticks</span>`;
      }
    }
    html += `<tr${isMe}>
      <td class="rank">${i + 1}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${relCell}</td>
      <td class="num-c">${r.planetes}</td>
      <td class="num-c">${fmtCompact(r.flotte)}</td>
      <td class="score">${fmt(r.score)}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  v.innerHTML = html;
}

// Résumé court d'un ordre en panier (titre + sous-titre).
function summarizeQueuedOrder(o) {
  const L = (k) => labels[k] || k;
  if (o.type === 'chantier') return { nm: L(o.batiment), sub: `niveau ${o.niveau_cible}` };
  if (o.type === 'construction') return { nm: L(o.unite), sub: `${o.quantite}× sur ${o.planete}` };
  if (o.type === 'recherche') return { nm: L(o.technologie), sub: `niveau ${o.niveau_cible}` };
  if (o.type === 'espionnage') return { nm: 'Espionnage', sub: `${o.depuis} → ${o.cible.joueur}/${o.cible.planete}` };
  if (o.type === 'attaque') return { nm: 'Attaque', sub: `${o.depuis} → ${o.cible.joueur}/${o.cible.planete}` };
  if (o.type === 'transport') return { nm: 'Transport', sub: `${o.depuis} → ${o.cible.joueur}/${o.cible.planete}` };
  if (o.type === 'recyclage') return { nm: 'Recyclage', sub: `${o.depuis} → ${o.cible.joueur}/${o.cible.planete}` };
  if (o.type === 'colonisation') return { nm: 'Colonisation', sub: `${o.depuis} → ${o.cible.systeme}:${o.cible.position}` };
  if (o.type === 'marche-poser') {
    const [vr, vq] = Object.entries(o.vend || {})[0] || [];
    const [dr, dq] = Object.entries(o.demande || {})[0] || [];
    return { nm: 'Marché', sub: `${vq} ${vr} → ${dq} ${dr}` };
  }
  return { nm: o.type, sub: '' };
}

function renderCart() {
  const playerName = state.current;
  const q = playerName ? getQueue(playerName) : [];
  const group = document.getElementById('qCartGroup');
  if (!group) return;
  if (q.length === 0) {
    group.hidden = true;
    return;
  }
  group.hidden = false;
  document.getElementById('qCartCt').textContent = q.length;
  const tickCible = q[0].tickCible;
  const locked = state.pending.has('inscribeQueue');
  const inflight = !!inflightInscriptions[playerName];
  const disabled = locked || inflight;
  let html = '';
  for (let i = 0; i < q.length; i++) {
    const s = summarizeQueuedOrder(q[i].order);
    html += `<div class="qitem cart">
      <button class="cancel-btn" data-cart-remove="${i}" ${disabled ? 'disabled' : ''} title="Retirer du panier">✕</button>
      <div class="top">
        <div class="nm">${s.nm}<small>${s.sub}</small></div>
        <div class="tgt" style="color:var(--phosphor)">∙∙∙<small style="font-family:var(--sans);font-size:9.5px;font-weight:600;letter-spacing:0.04em;color:var(--bone-dim);display:block;margin-top:4px;text-align:right;text-transform:uppercase">tick ${tickCible}</small></div>
      </div>
    </div>`;
  }
  let btnLabel;
  if (locked) btnLabel = 'Inscription en cours…';
  else if (inflight) btnLabel = 'TX Bitcoin en attente de confirmation';
  else btnLabel = `Inscrire ${q.length} ordre${q.length > 1 ? 's' : ''}`;
  html += `<button class="cart-inscribe" id="cartInscribeBtn" ${disabled ? 'disabled' : ''}>${btnLabel}</button>`;
  const hint = inflight
    ? 'Inscription précédente non confirmée (Mutinynet ≈ 30s). Le panier reste prêt.'
    : 'Une seule inscription Bitcoin pour tout le panier.';
  html += `<div class="cart-hint">${hint}</div>`;
  document.getElementById('qCart').innerHTML = html;
}

function renderSealedActive() {
  const list = loadSealedList();
  const group = document.getElementById('qSealedGroup');
  const slot = document.getElementById('qSealed');
  const ct = document.getElementById('qSealedCt');
  if (!group || !slot) return;
  // Garde seulement sceaux pas encore confirmés (pending ou broadcast).
  const active = list.filter(s => s.revealStatus !== 'confirmed');
  if (active.length === 0) { group.hidden = true; return; }
  group.hidden = false;
  if (ct) ct.textContent = active.length;

  const tickCur = state.manifest?.tick ?? 0;
  const bpt = state.bitcoin?.blocsParTick ?? 30;
  const tip = state.bitcoin?.tip ?? 0;
  const blocGenesis = state.bitcoin?.blocGenesis;

  let html = '';
  for (const s of active) {
    const ticksRemaining = s.tick_impact - tickCur;
    const blocksRemaining = blocGenesis
      ? Math.max(0, (window.aetherisBitcoin?.blockHeightForTick?.(s.tick_impact, blocGenesis, bpt, 0) ?? 0) - tip)
      : 0;
    const minutes = Math.round(blocksRemaining * 30 / 60);
    let status, color;
    if (s.revealStatus === 'broadcast') { status = 'reveal publié · attente confirm'; color = '#dad45e'; }
    else if (ticksRemaining <= 0)        { status = 'impact imminent · auto-reveal'; color = '#d04648'; }
    else                                  { status = `vol · ${ticksRemaining} tick(s) · ~${minutes} min`; color = 'var(--phosphor)'; }
    const cible = `${s.secret.cible.joueur}/${s.secret.cible.planete}`;
    html += `<div class="qitem cart" style="border-left:2px solid #d04648">
      <div class="top">
        <div class="nm">⚙ ${s.planete_origine} → ${cible}<small>tick_impact ${s.tick_impact}</small></div>
        <div class="tgt" style="color:${color}">${status}<small style="font-family:var(--sans);font-size:9.5px;font-weight:600;letter-spacing:0.04em;color:var(--bone-dim);display:block;margin-top:4px;text-align:right;text-transform:uppercase">${s.sealed_txid.slice(0, 10)}…</small></div>
      </div>
    </div>`;
  }
  slot.innerHTML = html;
}

function renderRail(p, emp) {
  renderCart();
  renderSealedActive();
  // Chantier — combine ordres en attente (depuis ordres.yaml) + chantiers actifs (file_chantier)
  const queue = p?.file_chantier || [];
  const tickCur = state.manifest?.tick ?? 0;
  const pendingAll = (emp?._ordres?.ordres || []).filter(o => o.type === 'chantier');
  const tickCible = emp?._ordres?.tick_cible;
  const pending = (tickCible && tickCible >= tickCur + 1) ? pendingAll : [];

  document.getElementById('qBatCt').textContent = (pending.length + queue.length) || '—';
  let html = '';

  // Ordres en attente (pas encore traités par le moteur)
  const cancelLocked = state.pending.has('cancelOrder');
  for (let pi = 0; pi < pending.length; pi++) {
    const o = pending[pi];
    html += `<div class="qitem pending">
      <button class="cancel-btn" data-cancel-idx="${pi}" ${cancelLocked ? 'disabled' : ''} title="Retirer cet ordre">✕</button>
      <div class="top">
        <div class="nm">${labels[o.batiment] || o.batiment}<small>niveau ${o.niveau_cible}</small></div>
        <div class="tgt" style="color:var(--brass)">∙∙∙<small style="font-family:var(--sans);font-size:9.5px;font-weight:600;letter-spacing:0.04em;color:var(--bone-dim);display:block;margin-top:4px;text-align:right;text-transform:uppercase">tick ${tickCible}</small></div>
      </div>
    </div>`;
  }

  // Chantiers actifs — file séquentielle : seul le head avance, les autres attendent.
  let cumTicksBat = 0;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const remain = Math.max(0, c.fin_utj || 0);
    const itemTicks = Math.max(1, Math.ceil(remain / 6));
    cumTicksBat += itemTicks;
    const cumMins = Math.round(cumTicksBat * (state.manifest?.duree_tick_min || 15));
    const isHead = i === 0;
    const klass = isHead ? '' : ' queued';
    const pos = isHead
      ? `<span class="qpos">en cours</span>`
      : `<span class="qpos">file · #${i + 1}</span>`;
    const eta = cumTicksBat <= 1 ? 'livré au prochain cycle' : `livré dans ${cumTicksBat} cycles`;
    html += `<div class="qitem${klass}">
      <div class="top">
        <div class="nm">${labels[c.batiment] || c.batiment}<small>niveau ${c.niveau_cible}${pos}</small></div>
        <div class="tgt">${remain}<small style="font-family:var(--sans);font-size:9.5px;font-weight:600;letter-spacing:0.04em;color:var(--bone-dim);display:block;margin-top:4px;text-align:right;text-transform:uppercase"><span class="utj-help" title="1 tick = 6 UTJ ≈ 15 min (cadence Mutinynet × 30 blocs). Le moteur progresse par ticks ; UTJ est l'unite interne de duree.">UTJ</span></small></div>
      </div>
      <div class="tmeta"><span>≈ <b>${cumMins}</b> min</span><span>${eta}</span></div>
    </div>`;
  }

  if (!html) html = `<div class="empty-rail">aucun ouvrage</div>`;
  document.getElementById('qBat').innerHTML = html;

  // Atelier — vaisseaux & défenses (en attente + en cours)
  const atelierPending = (tickCible && tickCible >= tickCur + 1)
    ? (emp?._ordres?.ordres || []).filter(o => o.type === 'construction')
    : [];
  const atelierQueue = p?.file_construction || [];
  document.getElementById('qAtlCt').textContent = (atelierPending.length + atelierQueue.length) || '—';
  let atlHtml = '';
  for (let pi = 0; pi < atelierPending.length; pi++) {
    const o = atelierPending[pi];
    atlHtml += `<div class="qitem pending">
      <div class="top">
        <div class="nm">${labels[o.unite] || o.unite}<small>${o.quantite || 1} unité${(o.quantite || 1) > 1 ? 's' : ''}</small></div>
        <div class="tgt" style="color:var(--brass)">∙∙∙<small style="font-family:var(--sans);font-size:9.5px;font-weight:600;letter-spacing:0.04em;color:var(--bone-dim);display:block;margin-top:4px;text-align:right;text-transform:uppercase">cycle ${tickCible}</small></div>
      </div>
    </div>`;
  }
  let cumTicksAtl = 0;
  for (let i = 0; i < atelierQueue.length; i++) {
    const c = atelierQueue[i];
    const remain = Math.max(0, c.fin_utj || 0);
    const itemTicks = Math.max(1, Math.ceil(remain / 6));
    cumTicksAtl += itemTicks;
    const cumMins = Math.round(cumTicksAtl * (state.manifest?.duree_tick_min || 15));
    const isHead = i === 0;
    const klass = isHead ? '' : ' queued';
    const pos = isHead
      ? `<span class="qpos">en cours</span>`
      : `<span class="qpos">file · #${i + 1}</span>`;
    const eta = cumTicksAtl <= 1 ? 'livré au prochain cycle' : `livré dans ${cumTicksAtl} cycles`;
    atlHtml += `<div class="qitem${klass}">
      <div class="top">
        <div class="nm">${labels[c.unite] || c.unite}<small>${c.quantite || 1} unité${(c.quantite || 1) > 1 ? 's' : ''} · ${c.planete || ''}${pos}</small></div>
        <div class="tgt">${remain}<small style="font-family:var(--sans);font-size:9.5px;font-weight:600;letter-spacing:0.04em;color:var(--bone-dim);display:block;margin-top:4px;text-align:right;text-transform:uppercase"><span class="utj-help" title="1 tick = 6 UTJ ≈ 15 min (cadence Mutinynet × 30 blocs).">UTJ</span></small></div>
      </div>
      <div class="tmeta"><span>≈ <b>${cumMins}</b> min</span><span>${eta}</span></div>
    </div>`;
  }
  if (!atlHtml) atlHtml = `<div class="empty-rail">aucune production</div>`;
  document.getElementById('qAtl').innerHTML = atlHtml;

  // Recherche
  const rq = emp?.file_recherche || [];
  document.getElementById('qRecCt').textContent = rq.length || '—';
  document.getElementById('qRec').innerHTML = rq.length === 0
    ? `<div class="empty-rail">cabinets vides</div>`
    : rq.map(r => {
        const remain = Math.max(0, r.fin_utj || 0);
        const key = r.technologie || r.recherche || r.discipline;
        const nm = (key && labels[key]) || key || '?';
        return `<div class="qitem">
          <div class="top">
            <div class="nm">${nm}<small>niv ${r.niveau_cible || '?'}</small></div>
            <div class="tgt">${remain}<small style="font-family:var(--mono);font-size:9px;letter-spacing:0.18em;color:var(--bone-dim);display:block;margin-top:2px;text-align:right"><span class="utj-help" title="1 tick = 6 UTJ ≈ 15 min (cadence Mutinynet × 30 blocs). Le moteur progresse par ticks ; UTJ est l'unite interne de duree.">UTJ</span></small></div>
          </div>
        </div>`;
      }).join('');

  // Flottes
  const f = emp?.flottes_en_vol || [];
  document.getElementById('qFltCt').textContent = f.length || '—';
  document.getElementById('qFlt').innerHTML = f.length === 0
    ? `<div class="empty-rail">aucune sortie</div>`
    : f.map(x => {
        const remain = Math.max(0, (x.arrivee_utj || 0));
        return `<div class="qitem">
          <div class="top">
            <div class="nm">${x.type_mission || 'mission'}<small>${(x.depuis?.planete||'?')} → ${(x.vers?.planete||x.vers||'?')}</small></div>
            <div class="tgt">${remain}<small style="font-family:var(--mono);font-size:9px;letter-spacing:0.18em;color:var(--bone-dim);display:block;margin-top:2px;text-align:right"><span class="utj-help" title="1 tick = 6 UTJ ≈ 15 min (cadence Mutinynet × 30 blocs). Le moteur progresse par ticks ; UTJ est l'unite interne de duree.">UTJ</span></small></div>
          </div>
        </div>`;
      }).join('');
}

/* ───────────────────────────── View switching ───────────────────────────── */
function applyView() {
  // Propage la vue courante au <body> pour les sélecteurs CSS scoped
  // (e.g. parallax céleste actif uniquement en vue Galaxie).
  document.body.dataset.view = state.view || '';
  document.querySelectorAll('.nav button').forEach(b => {
    b.classList.toggle('on', b.dataset.view === state.view);
  });
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('on', v.dataset.v === state.view);
  });
  // Le planet-head bascule entre Bulletin (Aperçu) et barre compacte (autres
  // vues), il faut le re-render à chaque changement de vue sans attendre
  // le prochain tick de refresh.
  const emp = state.players[state.current];
  const p = emp && (emp.planetes || [])[0];
  if (emp) renderPlanetHead(p, emp);
  if (state.view === 'messagerie') {
    try { renderMsgView(); refreshMsgCount(); } catch {}
  }
}
document.getElementById('nav').addEventListener('click', e => {
  const btn = e.target.closest('button[data-view]'); if (!btn) return;
  state.view = btn.dataset.view;
  localStorage.setItem('aetheris.view', state.view);
  applyView();
});

document.getElementById('main').addEventListener('click', e => {
  const imp = e.target.closest('button[data-improve]');
  if (imp) { submitImprove(imp.dataset.improve); return; }

  const con = e.target.closest('button[data-construct]');
  if (con) {
    const emp = state.players[state.current];
    const planete = emp?.planetes?.[0]; if (!planete) return;
    submitConstruction(planete.nom, con.dataset.construct, parseInt(con.dataset.qty, 10));
    return;
  }

  const rec = e.target.closest('button[data-research]');
  if (rec) {
    const emp = state.players[state.current]; if (!emp) return;
    const tech = rec.dataset.research;
    const niveauActuel = (emp.recherche || {})[tech] || 0;
    submitRecherche(tech, niveauActuel + 1);
    return;
  }

  const tgt = e.target.closest('[data-mission-target]');
  if (tgt) {
    const [joueur, planete] = tgt.dataset.missionTarget.split('|');
    openMission(joueur, planete);
    return;
  }

  const colTgt = e.target.closest('[data-coloniser-target]');
  if (colTgt) {
    const [systeme, position, classe] = colTgt.dataset.coloniserTarget.split('|');
    openColonisation(systeme, parseInt(position, 10), classe);
    return;
  }
});

/* ───────────────────────────── Tick countdown ───────────────────────────── */
function tickCountdown() {
  const info = nextTickInfo();
  document.getElementById('countdown').textContent = `prochain · ${fmtCountdown(info.secs)}`;
  refreshOnboardingTick();
}
setInterval(tickCountdown, 1000);

/* ───────────────────────────── Cost / duration ──────────────────────────── */
function batDef(b) { return state.rules?.batiments?.[b]; }

function nextCost(batiment, niveauActuel) {
  const def = batDef(batiment); if (!def) return null;
  const mult = Math.pow(def.multiplicateur_cout || 1.5, niveauActuel);
  const out = {};
  for (const [k, v] of Object.entries(def.cout_base || {})) out[k] = Math.floor(v * mult);
  return out;
}
function nextDureeUtj(batiment, niveauActuel, planete) {
  const def = batDef(batiment); if (!def) return null;
  // Vitesse accélérée par usine_robotique (cohérent avec tick-core.mjs:963).
  const bonusUsine = state.rules?.batiments?.usine_robotique?.bonus_vitesse_par_niveau ?? 0;
  const niveauUsine = planete?.batiments?.usine_robotique || 0;
  const vitesse = 1 + bonusUsine * niveauUsine;
  return Math.ceil(((def.duree_base_utj || 1) * Math.pow(def.multiplicateur_duree || 1.5, niveauActuel)) / vitesse);
}
function canAfford(planete, cost) {
  if (!cost) return false;
  for (const [k, v] of Object.entries(cost)) {
    if ((planete?.ressources?.[k]?.stock || 0) < v) return false;
  }
  return true;
}

function recDef(t) { return state.rules?.recherches?.[t]; }
function nextRecCost(tech, niveauActuel) {
  const def = recDef(tech); if (!def) return null;
  const mult = Math.pow(def.mult || 2.0, niveauActuel);
  const out = {};
  for (const [k, v] of Object.entries(def.cout_base || {})) out[k] = Math.floor(v * mult);
  return out;
}
function nextRecDureeUtj(tech, niveauActuel) {
  const def = recDef(tech); if (!def) return null;
  return Math.ceil((def.duree_base || 1) * Math.pow(2, niveauActuel));
}
function canAffordEmp(emp, cost) {
  if (!cost) return false;
  // Le moteur cherche une planète qui peut payer seule — on vérifie pareil
  return (emp?.planetes || []).some(pl => canAfford(pl, cost));
}

/* ───────────────────────────── Signature & GitHub commit ────────────────── */
function pemToBytes(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
async function importPrivKey(pem) {
  const bytes = pemToBytes(pem);
  return await crypto.subtle.importKey('pkcs8', bytes, { name: 'Ed25519' }, false, ['sign']);
}
async function signCanonical(canonical, pem) {
  const key = await importPrivKey(pem);
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(canonical));
  let bin = '';
  const u = new Uint8Array(sig);
  for (let i = 0; i < u.byteLength; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin);
}

function buildOrdresYamlOrders({ joueur, tickCible, nonce, orderBlocks }) {
  // Le nonce est quote pour rester une string YAML — sinon un nonce 100% digits
  // (ex: "362100") serait parse en number par le validateur et rejete.
  return `# Généré depuis la console (${new Date().toISOString()})
version: 1
joueur: ${joueur}
tick_cible: ${tickCible}
nonce: "${nonce}"

ordres:
${orderBlocks.join('\n')}
`;
}

// Serialise un ordre (objet) en bloc YAML pour appender dans ordres.yaml.
// Inverse de ce que yparse produit ; doit matcher le schema attendu par le moteur.
function serializeOrder(o) {
  if (o.type === 'chantier') return `  - type: chantier
    planete: ${o.planete}
    batiment: ${o.batiment}
    niveau_cible: ${o.niveau_cible}`;
  if (o.type === 'construction') return `  - type: construction
    planete: ${o.planete}
    unite: ${o.unite}
    quantite: ${o.quantite}`;
  if (o.type === 'recherche') return `  - type: recherche
    technologie: ${o.technologie}
    niveau_cible: ${o.niveau_cible}`;
  if (o.type === 'espionnage') return `  - type: espionnage
    depuis: ${o.depuis}
    cible: { joueur: ${o.cible.joueur}, planete: ${o.cible.planete} }
    nombre_sondes: ${o.nombre_sondes}`;
  if (o.type === 'attaque') return `  - type: attaque
    depuis: ${o.depuis}
    cible: { joueur: ${o.cible.joueur}, planete: ${o.cible.planete} }
    flotte: ${inlineMap(o.flotte)}`;
  if (o.type === 'transport') return `  - type: transport
    depuis: ${o.depuis}
    cible: { joueur: ${o.cible.joueur}, planete: ${o.cible.planete} }
    flotte: ${inlineMap(o.flotte)}
    cargaison: ${inlineMap(o.cargaison || {})}`;
  if (o.type === 'colonisation') {
    let s = `  - type: colonisation
    depuis: ${o.depuis}
    cible: { systeme: "${o.cible.systeme}", position: ${o.cible.position} }
    flotte: ${inlineMap(o.flotte)}
    cargaison: ${inlineMap(o.cargaison || {})}`;
    if (o.nom_colonie) s += `\n    nom_colonie: ${o.nom_colonie}`;
    return s;
  }
  if (o.type === 'recyclage') return `  - type: recyclage
    depuis: ${o.depuis}
    cible: { joueur: ${o.cible.joueur}, planete: ${o.cible.planete} }
    flotte: ${inlineMap(o.flotte)}`;
  if (o.type === 'marche-poser') {
    return `  - type: marche-poser
    depuis: ${o.depuis}
    vend: ${inlineMap(o.vend)}
    demande: ${inlineMap(o.demande)}
    expire_dans_ticks: ${o.expire_dans_ticks || 12}`;
  }
  throw new Error(`serializeOrder: type inconnu "${o.type}"`);
}

document.getElementById('rail').addEventListener('click', e => {
  const cancelBtn = e.target.closest('button[data-cancel-idx]');
  if (cancelBtn) { cancelOrder(parseInt(cancelBtn.dataset.cancelIdx, 10)); return; }
  const cartRm = e.target.closest('button[data-cart-remove]');
  if (cartRm) { removeQueuedOrder(state.current, parseInt(cartRm.dataset.cartRemove, 10)); return; }
  const inscribeBtn = e.target.closest('#cartInscribeBtn');
  if (inscribeBtn) { inscribeQueuedOrders(); return; }
});

async function cancelOrder(idx) {
  const emp = state.players[state.current];
  if (!emp?._ordres) return;
  if (!cfg.ready) { openSettings(); toast('Wallet requis', 'Configure ton wallet Bitcoin pour pouvoir modifier les ordres.', true); return; }
  if (state.pending.has('cancelOrder')) return;

  const tickCible = emp._ordres.tick_cible;
  const ordres = (emp._ordres.ordres || []).filter((_, i) => i !== idx);
  const nonce = randomNonce();
  const orderBlocks = ordres.map(serializeOrder);
  const body = buildOrdresYamlOrders({ joueur: state.current, tickCible, nonce, orderBlocks });

  state.pending.add('cancelOrder'); render();
  try {
    await pushSignedOrder(body, `${state.current}: annule ordre ${idx + 1} (tick ${tickCible})`);
    emp._ordres = { ...emp._ordres, ordres };
    toast('Ordre retiré', ordres.length ? `File mise à jour (${ordres.length} ordre${ordres.length > 1 ? 's' : ''} restant).` : 'File vidée.');
  } catch (e) {
    toast('Échec', e.message || String(e), true);
  } finally {
    state.pending.delete('cancelOrder'); render();
  }
}

// Mutex pour sérialiser les inscriptions Bitcoin (un seul push à la fois,
// évite que deux clics rapides consomment les mêmes UTXOs côté wallet).
let pushQueue = Promise.resolve();
// Inscriptions broadcastées mais pas encore confirmées on-chain. Tant que
// c'est rempli pour un joueur, toute nouvelle inscription Bitcoin échouera
// avec "replacement-fee-rate" (la TX précédente bloque l'UTXO en mempool).
// Clé : nom du joueur → { nonce, tickCible, ts }. Cleared dans load() quand
// le scan voit le même nonce on-chain.
const inflightInscriptions = {};
// Cache local des ordres soumis : survit aux load() pendant la fenêtre
// "TX broadcastée → confirmée → scanned → appliquée au tick" (~30-60s sur
// Mutinynet). Sinon l'UI semble perdre l'ordre fraîchement soumis pendant
// que le scan suivant n'a pas encore vu l'inscription.
const localOrdersCache = {};

// ─── Panier local : ordres ajoutés mais PAS encore inscrits on-chain ────
// Architecture cart UX : on accumule plusieurs ordres côté client puis on
// fait UNE seule inscription Bitcoin (un seul UTXO consommé, pas de conflit
// RBF entre TXs concurrentes). Clé : nom du joueur → tableau de
// { order, message, tickCible }. Reset après inscription réussie ou quand
// le tick avance.
const localQueue = {};
let __lastQueueTick = -1;

function getQueue(playerName) {
  return localQueue[playerName] || [];
}

// Détecte si un ordre identique (même cible structurelle) est déjà en
// panier ou déjà inscrit pour le prochain tick. Évite les doublons type
// "améliorer mine ferrum" cliqué 2 fois.
function findDuplicateOrder(playerName, newOrder) {
  const queue = getQueue(playerName);
  const emp = state.players[playerName];
  const tickCible = (state.manifest?.tick ?? 0) + 1;
  const inscribed = (emp?._ordres?.tick_cible === tickCible)
    ? (emp._ordres.ordres || [])
    : [];
  const all = [...queue.map(q => q.order), ...inscribed];
  for (const o of all) {
    if (o.type !== newOrder.type) continue;
    if (o.type === 'chantier' && o.planete === newOrder.planete && o.batiment === newOrder.batiment) return o;
    if (o.type === 'recherche' && o.technologie === newOrder.technologie) return o;
    if (o.type === 'construction' && o.planete === newOrder.planete && o.unite === newOrder.unite) return o;
    // missions / marche / colonisation : autorise plusieurs (cibles distinctes possibles)
  }
  return null;
}

// Ajoute un ordre au panier local (PAS de push Bitcoin). Le push se fait
// en bloc via inscribeQueuedOrders() quand l'user clique "Inscrire N ordres".
function queueOrderLocally(newOrder, message) {
  const playerName = state.current;
  if (!playerName) throw new Error('aucun joueur actif');
  if (findDuplicateOrder(playerName, newOrder)) {
    toast('Déjà au panier', 'Un ordre identique est déjà en attente ou inscrit pour ce tick.', true);
    throw new Error('ordre dupliqué');
  }
  const tickCible = (state.manifest?.tick ?? 0) + 1;
  if (!localQueue[playerName]) localQueue[playerName] = [];
  localQueue[playerName].push({ order: newOrder, message, tickCible });
  __lastQueueTick = tickCible;
  render();
  return localQueue[playerName].length;
}

function removeQueuedOrder(playerName, idx) {
  const q = localQueue[playerName];
  if (!q) return;
  q.splice(idx, 1);
  if (q.length === 0) delete localQueue[playerName];
  render();
}

// Inscrit en UNE SEULE inscription Bitcoin tous les ordres du panier du
// joueur courant + ceux déjà inscrits pour le même tick (cas où l'user a
// déjà inscrit une première salve et veut ajouter d'autres ordres).
async function inscribeQueuedOrders() {
  const playerName = state.current;
  if (!playerName) return;
  const q = getQueue(playerName);
  if (q.length === 0) return;
  if (!cfg.ready) { openSettings(); toast('Wallet requis', 'Configure ton wallet Bitcoin dans les paramètres pour inscrire des ordres.', true); return; }
  if (state.pending.has('inscribeQueue')) return;
  if (inflightInscriptions[playerName]) {
    toast('Inscription Bitcoin en attente',
      'Ta précédente inscription est encore en mempool (~30s sur Mutinynet). Réessaie dans un instant — ton panier est conservé.',
      true);
    return;
  }

  const tickCible = q[0].tickCible;
  // Si certains ordres du panier sont pour un autre tick (tick avancé entre-
  // temps), refuse. Le clear-on-tick-advance devrait empêcher ce cas.
  if (q.some(x => x.tickCible !== tickCible)) {
    toast('File incohérente', 'Le tick a avancé. Le panier a été réinitialisé.', true);
    delete localQueue[playerName];
    render();
    return;
  }

  state.pending.add('inscribeQueue'); render();
  const run = async () => {
    const emp = state.players[playerName];
    if (!emp) throw new Error(`joueur "${playerName}" introuvable`);
    const existing = emp._ordres && emp._ordres.tick_cible === tickCible ? emp._ordres : null;
    const allOrders = [
      ...(existing ? existing.ordres : []),
      ...q.map(x => x.order),
    ];
    const nonce = randomNonce();
    const orderBlocks = allOrders.map(serializeOrder);
    const body = buildOrdresYamlOrders({ joueur: playerName, tickCible, nonce, orderBlocks });
    const summary = q.length === 1
      ? q[0].message
      : `${playerName}: ${q.length} ordres groupés (tick ${tickCible})`;
    await pushSignedOrder(body, summary);
    const snapshot = { tick_cible: tickCible, ordres: [...allOrders], nonce };
    emp._ordres = snapshot;
    localOrdersCache[playerName] = snapshot;
    inflightInscriptions[playerName] = { nonce, tickCible, ts: Date.now() };
    delete localQueue[playerName];
  };
  const task = pushQueue.then(run, run);
  pushQueue = task.catch(() => {});
  try {
    await task;
    toast('Ordres scellés', `${q.length} ordre${q.length > 1 ? 's' : ''} inscrit${q.length > 1 ? 's' : ''} sur Mutinynet (tick ${tickCible}).`);
  } catch (e) {
    if (e?.code === 'RBF_CONFLICT') {
      // Une TX précédente du wallet est encore en mempool. On garde le
      // panier intact et on bloque les retries jusqu'à confirmation.
      inflightInscriptions[playerName] = inflightInscriptions[playerName] || { nonce: null, tickCible, ts: Date.now() };
      toast('Inscription Bitcoin en attente',
        'Une inscription précédente n\'est pas encore confirmée (Mutinynet ≈ 30s). Ton panier reste intact — réessaie dès que le prochain bloc tombe.',
        true);
    } else {
      toast('Échec inscription', e.message || String(e), true);
    }
  } finally {
    state.pending.delete('inscribeQueue'); render();
  }
}

// Compat : ancien appel direct. Désormais redirige vers le panier local.
// Toutes les call sites (submitImprove/Construction/Recherche/Mission/Marche)
// passent par ici. Le toast "Ordre scellé" côté caller devient "Ajouté au
// panier" — on le surcharge ici en levant une info structurée.
async function appendOrderAndPush(newOrder, message) {
  // queueOrderLocally throw 'ordre dupliqué' si déjà présent.
  const count = queueOrderLocally(newOrder, message);
  // Signale au caller : "ajouté au panier" plutôt que "scellé".
  // Le caller peut détecter via err.code === 'QUEUED' mais on préfère
  // retourner normalement et laisser le caller toaster.
  return { queued: true, count };
}

// Sérialiseur YAML inline pour map { k: v, ... } — n'inclut que les valeurs > 0
function inlineMap(obj) {
  const entries = Object.entries(obj || {}).filter(([, v]) => v && v > 0);
  if (entries.length === 0) return '{}';
  return '{ ' + entries.map(([k, v]) => `${k}: ${v}`).join(', ') + ' }';
}

async function ghFetch(path, init = {}) {
  const headers = {
    Authorization: `Bearer ${cfg.pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'If-None-Match': '',
    ...(init.headers || {}),
  };
  const r = await fetch(`https://api.github.com${path}`, { ...init, headers, cache: 'no-store' });
  if (!r.ok) {
    const txt = await r.text();
    let msg = `${r.status} ${r.statusText}`;
    try { msg = JSON.parse(txt).message || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

function randomNonce() {
  const a = new Uint8Array(3); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ───────────────────────────── Wallet Bitcoin ───────────────────────────── */
// Chiffré AES-GCM (clé dérivée PBKDF2 SHA-256, 200k itérations). Le password
// est demandé une fois par session et conservé en mémoire (state.walletPassword).
// Rétro-compat : un wallet stocké en clair (legacy) est lu directement et migré
// au prochain save si l'user fournit un password.

const WALLET_KEY = 'aetheris.btc.wallet';

function b64encode(bytes) {
  let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
async function deriveWalletKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}
async function encryptWallet(wallet, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWalletKey(password, salt);
  const data = new TextEncoder().encode(JSON.stringify(wallet));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return {
    encrypted: 'aes-gcm-pbkdf2-v1',
    salt: b64encode(salt),
    iv: b64encode(iv),
    ciphertext: b64encode(new Uint8Array(ct)),
  };
}
async function decryptWallet(blob, password) {
  const salt = b64decode(blob.salt);
  const iv = b64decode(blob.iv);
  const ct = b64decode(blob.ciphertext);
  const key = await deriveWalletKey(password, salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// Lecture brute du localStorage — retourne soit le wallet clair (legacy),
// soit un blob chiffré { encrypted, salt, iv, ciphertext }.
function readWalletBlob() {
  try { return JSON.parse(localStorage.getItem(WALLET_KEY) || 'null'); }
  catch { return null; }
}

// Wrapper sync pour rétro-compat avec les call sites legacy. Retourne le
// wallet clair si non chiffré ; sinon retourne null (l'appelant doit utiliser
// la version async loadBitcoinWalletAsync).
function loadBitcoinWallet() {
  const blob = readWalletBlob();
  if (!blob) return null;
  if (blob.encrypted) return null; // chiffré → ne peut pas charger sync
  return blob;
}

async function loadBitcoinWalletAsync() {
  const blob = readWalletBlob();
  if (!blob) return null;
  if (!blob.encrypted) return blob; // legacy clair

  // Chiffré — demande password (1 fois par session)
  let password = state.walletPassword;
  if (!password) {
    password = window.prompt('🔒 Password pour déchiffrer ton wallet Bitcoin');
    if (!password) throw new Error('password requis');
  }
  try {
    const wallet = await decryptWallet(blob, password);
    state.walletPassword = password;
    return wallet;
  } catch (e) {
    state.walletPassword = null;
    throw new Error('password incorrect ou wallet corrompu');
  }
}

async function saveBitcoinWallet(w) {
  // Demande un password si pas en session (premier setup ou nouveau wallet).
  let password = state.walletPassword;
  if (!password) {
    password = window.prompt(
      '🔒 Choisis un password pour chiffrer ton wallet localement.\n' +
      '(laisser vide = stockage en clair, déconseillé)'
    );
  }
  if (!password) {
    // Stockage en clair (legacy / opt-out)
    localStorage.setItem(WALLET_KEY, JSON.stringify(w));
    state.walletPassword = null;
    return;
  }
  const blob = await encryptWallet(w, password);
  localStorage.setItem(WALLET_KEY, JSON.stringify(blob));
  state.walletPassword = password;
}

function clearBitcoinWallet() {
  localStorage.removeItem(WALLET_KEY);
  state.wallet = null;
  state.walletPassword = null;
}

async function getBitcoinWallet() {
  if (state.wallet?.privateKeyWIF && state.wallet?.taprootAddress) return state.wallet;
  let cached;
  try { cached = await loadBitcoinWalletAsync(); }
  catch (e) {
    toast('Wallet verrouillé', e.message, true);
    throw e;
  }
  if (cached?.privateKeyWIF && cached?.taprootAddress) {
    state.wallet = cached;
    return cached;
  }
  // Pas de wallet stocké — ouvre le modal pour saisir.
  openSettings();
  toast('Wallet Bitcoin requis', 'Colle le contenu de ton .btc-key (JSON) dans le champ wallet, puis sceller.', true);
  throw new Error('wallet bitcoin non configuré');
}

// pushSignedOrder version Bitcoin-native : pas de signature applicative.
// L'authentification = la pubkey Schnorr qui signe le witness Bitcoin (vérifiée
// par le boot lors du scan). Le YAML est inscrit tel quel.
async function pushSignedOrder(canonicalBody, message) {
  const step = async (label, fn) => {
    try { return await fn(); }
    catch (e) {
      const hint = label === 'fork' && /403|404/.test(e.message)
        ? ' — verifie que ton PAT a le scope `public_repo` (PAT classique) ou Contents+Pull-Requests Read&Write (fine-grained)'
        : '';
      const wrapped = new Error(`[${label}] ${e.message}${hint}`);
      if (e.code) wrapped.code = e.code;
      throw wrapped;
    }
  };

  // Pas de signature applicative — la pubkey Schnorr du witness Bitcoin authentifie.
  const finalContent = canonicalBody.replace(/\s+$/, '') + '\n';

  // Récupère le wallet Bitcoin (modal si pas déjà dispo).
  const wallet = await step('wallet bitcoin', () => getBitcoinWallet());

  const ab = window.aetherisBitcoin;
  if (!ab?.ready) throw new Error('module Bitcoin non chargé');

  showStatus('▸ inscription Bitcoin (commit + reveal)…', true);
  const result = await step('inscribe', () => ab.inscribe({
    yamlText: finalContent,
    keyData: wallet,
    networkName: wallet.network || 'mutinynet',
    feeRate: 1,
    libs: { btc: ab.btc, schnorr: ab.schnorr },
    log: (m) => showStatus(m, true),
  }));

  showStatus(`✓ inscrit · reveal ${result.revealTxid.slice(0, 12)}…`, true);
  // Pas de reset cache — le prochain boot scanne incrémentalement depuis
  // lastBlock+1 et ramassera la nouvelle inscription une fois confirmée.

  return result;
}

async function submitImprove(batiment) {
  if (state.pending.has(batiment)) return;
  if (!cfg.ready) { openSettings(); toast('Wallet requis', 'Configure ton wallet Bitcoin dans les paramètres pour inscrire des ordres.', true); return; }

  const emp = state.players[state.current];
  const planete = emp?.planetes?.[0]; if (!planete) return;
  const niveauActuel = planete.batiments?.[batiment] || 0;
  const niveauCible = niveauActuel + 1;
  const cost = nextCost(batiment, niveauActuel);
  if (!canAfford(planete, cost)) { toast('Ressources insuffisantes', `${batiment} niv ${niveauCible} requiert plus que tes stocks.`, true); return; }

  const tickCible = (state.manifest?.tick ?? 0) + 1;

  state.pending.add(batiment); render();
  try {
    const message = `${state.current}: chantier ${batiment} → niv ${niveauCible} (tick ${tickCible})`;
    const r = await appendOrderAndPush({ type: 'chantier', planete: planete.nom, batiment, niveau_cible: niveauCible }, message);
    toast('Ajouté au panier', `${labels[batiment] || batiment} → niveau ${niveauCible} (${r.count} ordre${r.count > 1 ? 's' : ''} en attente).`);
  } catch (e) {
    if (e?.message === 'ordre dupliqué') { /* déjà toasté par queueOrderLocally */ }
    else toast('Échec', e.message || String(e), true);
  } finally {
    state.pending.delete(batiment); render();
  }
}

async function submitConstruction(planeteNom, unite, quantite) {
  const pendingKey = `construction:${unite}`;
  if (state.pending.has(pendingKey)) return;
  if (!cfg.ready) { openSettings(); toast('Wallet requis', 'Configure ton wallet Bitcoin dans les paramètres pour inscrire des ordres.', true); return; }
  if (!quantite || quantite <= 0) return;

  const emp = state.players[state.current];
  const planete = (emp?.planetes || []).find(p => p.nom === planeteNom); if (!planete) return;
  const def = state.rules?.vaisseaux?.[unite] || state.rules?.defenses?.[unite];
  if (!def) { toast('Inconnu', `Unité ${unite} introuvable dans les règles.`, true); return; }

  const totalCost = {};
  for (const [k, v] of Object.entries(def.cout || {})) totalCost[k] = v * quantite;
  if (!canAfford(planete, totalCost)) { toast('Ressources insuffisantes', `${quantite}× ${unite} dépasse tes stocks.`, true); return; }

  const tickCible = (state.manifest?.tick ?? 0) + 1;

  state.pending.add(pendingKey); render();
  try {
    const message = `${state.current}: construction ${quantite}× ${unite} sur ${planeteNom} (tick ${tickCible})`;
    const r = await appendOrderAndPush({ type: 'construction', planete: planeteNom, unite, quantite }, message);
    toast('Ajouté au panier', `${quantite}× ${labels[unite] || unite} sur ${planeteNom} (${r.count} ordre${r.count > 1 ? 's' : ''} en attente).`);
  } catch (e) {
    if (e?.message === 'ordre dupliqué') { /* déjà toasté */ }
    else toast('Échec', e.message || String(e), true);
  } finally {
    state.pending.delete(pendingKey); render();
  }
}

async function submitRecherche(technologie, niveauCible) {
  const pendingKey = 'rec:' + technologie;
  if (state.pending.has(pendingKey)) return;
  if (!cfg.ready) { openSettings(); toast('Wallet requis', 'Configure ton wallet Bitcoin dans les paramètres pour inscrire des ordres.', true); return; }

  const emp = state.players[state.current]; if (!emp) return;
  const niveauActuel = (emp.recherche || {})[technologie] || 0;
  if (niveauCible !== niveauActuel + 1) return;
  const cost = nextRecCost(technologie, niveauActuel);
  if (!canAffordEmp(emp, cost)) { toast('Ressources insuffisantes', `Aucune planète ne peut payer ${technologie} niv ${niveauCible}.`, true); return; }

  const tickCible = (state.manifest?.tick ?? 0) + 1;

  state.pending.add(pendingKey); render();
  try {
    const message = `${state.current}: recherche ${technologie} → niv ${niveauCible} (tick ${tickCible})`;
    const r = await appendOrderAndPush({ type: 'recherche', technologie, niveau_cible: niveauCible }, message);
    toast('Ajouté au panier', `${labels[technologie] || technologie} → niveau ${niveauCible} (${r.count} ordre${r.count > 1 ? 's' : ''} en attente).`);
  } catch (e) {
    if (e?.message === 'ordre dupliqué') { /* déjà toasté */ }
    else toast('Échec', e.message || String(e), true);
  } finally {
    state.pending.delete(pendingKey); render();
  }
}

async function submitMission({ type, depuis, cibleJoueur, ciblePlanete, cibleSysteme, ciblePosition, flotte, cargaison, nombreSondes, nomColonie }) {
  const cibleKey = type === 'colonisation'
    ? `${cibleSysteme}:${ciblePosition}`
    : `${cibleJoueur}:${ciblePlanete}`;
  const pendingKey = `mission:${type}:${depuis}:${cibleKey}`;
  if (state.pending.has(pendingKey)) return;
  if (!cfg.ready) { openSettings(); toast('Wallet requis', 'Configure ton wallet Bitcoin dans les paramètres pour inscrire des ordres.', true); return; }

  const tickCible = (state.manifest?.tick ?? 0) + 1;

  // Validation et construction de l'ordre objet selon le type.
  let orderObj;
  if (type === 'espionnage') {
    if (!nombreSondes || nombreSondes <= 0) { toast('Sondes requises', 'Au moins 1 sonde nécessaire.', true); return; }
    orderObj = { type, depuis, cible: { joueur: cibleJoueur, planete: ciblePlanete }, nombre_sondes: nombreSondes };
  } else if (type === 'attaque') {
    if (inlineMap(flotte) === '{}') { toast('Flotte vide', 'Inclus au moins 1 vaisseau dans la composition.', true); return; }
    orderObj = { type, depuis, cible: { joueur: cibleJoueur, planete: ciblePlanete }, flotte: { ...flotte } };
  } else if (type === 'transport') {
    if (inlineMap(flotte) === '{}') { toast('Flotte vide', 'Au moins 1 vaisseau de transport est requis.', true); return; }
    orderObj = { type, depuis, cible: { joueur: cibleJoueur, planete: ciblePlanete }, flotte: { ...flotte }, cargaison: { ...(cargaison || {}) } };
  } else if (type === 'recyclage') {
    if (!flotte || (flotte.recycleur || 0) <= 0) { toast('Recycleurs requis', 'Au moins 1 recycleur nécessaire.', true); return; }
    orderObj = { type, depuis, cible: { joueur: cibleJoueur, planete: ciblePlanete }, flotte: { recycleur: flotte.recycleur } };
  } else if (type === 'colonisation') {
    if (!flotte || (flotte.vaisseau_colon || 0) < 1) { toast('Colon requis', 'Au moins 1 vaisseau_colon nécessaire.', true); return; }
    if (!cibleSysteme || cibleSysteme.split(':').length !== 2) { toast('Cible invalide', `Système attendu "g:s", reçu "${cibleSysteme}".`, true); return; }
    if (!Number.isFinite(ciblePosition) || ciblePosition < 1) { toast('Cible invalide', 'Position invalide.', true); return; }
    if (nomColonie && !/^[a-z][a-z0-9\-]{2,39}$/.test(nomColonie)) {
      toast('Nom invalide', 'Nom de colonie : minuscules a-z, chiffres et tirets, 3 à 40 caractères, doit commencer par une lettre.', true);
      return;
    }
    if (nomColonie && /^.+-c\d+$/.test(nomColonie)) {
      toast('Nom réservé', 'Le format <joueur>-c<n> est réservé au nommage automatique.', true);
      return;
    }
    orderObj = {
      type, depuis,
      cible: { systeme: cibleSysteme, position: ciblePosition },
      flotte: { ...flotte },
      cargaison: { ...(cargaison || {}) },
    };
    if (nomColonie) orderObj.nom_colonie = nomColonie;
  } else {
    toast('Type inconnu', type, true); return;
  }

  state.pending.add(pendingKey); render();
  try {
    const dst = type === 'colonisation'
      ? `${cibleSysteme}:${ciblePosition}${nomColonie ? ' (' + nomColonie + ')' : ''}`
      : `${cibleJoueur}/${ciblePlanete}`;
    const message = `${state.current}: ${type} ${depuis} → ${dst} (tick ${tickCible})`;
    const r = await appendOrderAndPush(orderObj, message);
    toast('Ajouté au panier', `${type} · ${depuis} → ${dst} (${r.count} ordre${r.count > 1 ? 's' : ''} en attente).`);
    closeMission();
  } catch (e) {
    if (e?.message === 'ordre dupliqué') { /* déjà toasté */ }
    else toast('Échec', e.message || String(e), true);
  } finally {
    state.pending.delete(pendingKey); render();
  }
}

/* ─────────────────── Sealed attacks (commit-reveal protocol) ──────────────
 * Permet au joueur de lancer une attaque dont la cible + composition sont
 * cachées on-chain jusqu'à l'impact. Le secret est stocké en localStorage,
 * un auto-revealer surveille la hauteur du bloc et publie le reveal quand
 * la flotte arrive physiquement (tick_depart + flight_time).
 *
 * localStorage shape :
 *   aetheris.sealed.<network>.<pubkey> = [ { sealed_txid, joueur, tick_depart,
 *     tick_impact, planete_origine, hash, secret, revealStatus, ... }, ... ]
 */

const SEALED_KEY_PREFIX = 'aetheris.sealed';

function sealedStorageKey() {
  const wallet = state.wallet;
  const network = wallet?.network || 'mutinynet';
  const pubkey = wallet?.pubKeyHex || 'anon';
  return `${SEALED_KEY_PREFIX}.${network}.${pubkey}`;
}

function loadSealedList() {
  try {
    const raw = localStorage.getItem(sealedStorageKey());
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveSealedList(list) {
  try { localStorage.setItem(sealedStorageKey(), JSON.stringify(list)); }
  catch (e) { console.warn('saveSealedList failed:', e); }
}

function addSealedRecord(record) {
  const list = loadSealedList();
  list.push(record);
  saveSealedList(list);
  return list.length;
}

function updateSealedRecord(sealed_txid, patch) {
  const list = loadSealedList();
  const idx = list.findIndex(s => s.sealed_txid === sealed_txid);
  if (idx < 0) return;
  list[idx] = { ...list[idx], ...patch };
  saveSealedList(list);
}

function removeSealedRecord(sealed_txid) {
  const list = loadSealedList().filter(s => s.sealed_txid !== sealed_txid);
  saveSealedList(list);
}

// Reproduit la logique de tick-core.mjs::queueAttaque : flight_ticks =
// ceil(ceil(distance/vMin*100) / UTJ_PAR_TICK). Distance se calcule via
// les coordonnées des planètes (cf. computeDistanceFromCoords).
function computeFlightTicks(distance, fleet) {
  const rules = state.rules;
  const UTJ_PAR_TICK = rules?.duree_utj_par_tick || 6;
  const ships = Object.keys(fleet || {});
  if (ships.length === 0) return null;
  const vMin = Math.min(...ships.map(s => rules?.vaisseaux?.[s]?.vitesse || 1000));
  if (!Number.isFinite(vMin) || vMin <= 0) return null;
  const flightUTJ = Math.max(1, Math.ceil(distance / vMin * 100));
  return Math.ceil(flightUTJ / UTJ_PAR_TICK);
}

// Distance entre deux planètes du jeu — réplique computeDistanceFromCoords
// de tick-core.mjs. Si l'une est introuvable → fallback 100 (comme moteur).
function computeDistanceUI(origineNom, cibleJoueur, cibleNom) {
  function findPlanet(name) {
    for (const emp of Object.values(state.players || {})) {
      const p = (emp.planetes || []).find(p => p.nom === name);
      if (p) return p;
    }
    return null;
  }
  const src = findPlanet(origineNom);
  const dst = findPlanet(cibleNom);
  if (!src?.coordonnees || !dst?.coordonnees) return 100;
  const [g1, s1, p1] = src.coordonnees;
  const [g2, s2, p2] = dst.coordonnees;
  if (g1 !== g2) return 20000 + Math.abs(g1 - g2) * 5000;
  if (s1 !== s2) return 2700 + Math.abs(s1 - s2) * 95;
  return 1000 + Math.abs(p1 - p2) * 5;
}

function buildSealedYamlClient({ joueur, tick_depart, planete_origine, hash }) {
  return [
    'type: sealed',
    'version: 1',
    `joueur: ${joueur}`,
    `tick_depart: ${tick_depart}`,
    `planete_origine: ${planete_origine}`,
    'kind: militaire',
    `hash: ${hash}`,
    '',
  ].join('\n');
}

function buildRevealYamlClient({ joueur, tick_impact, sealed_txid, secret }) {
  const fleetLines = Object.entries(secret.flotte || {})
    .map(([k, n]) => `    ${k}: ${n}`)
    .join('\n');
  return [
    'type: reveal',
    'version: 1',
    `joueur: ${joueur}`,
    `tick_impact: ${tick_impact}`,
    `sealed_txid: ${sealed_txid}`,
    'secret:',
    `  type: ${secret.type}`,
    `  depuis: ${secret.depuis}`,
    '  cible:',
    `    joueur: ${secret.cible.joueur}`,
    `    planete: ${secret.cible.planete}`,
    '  flotte:',
    fleetLines || '    chasseur_leger: 0',
    `  vitesse: ${secret.vitesse}`,
    `  nonce: ${secret.nonce}`,
    '',
  ].join('\n');
}

function randomSealNonce() {
  const a = new Uint8Array(8); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Met à jour l'aperçu sealed dans le compositeur de mission (distance + tick
// d'impact prédit + temps d'attente). Appelé quand toggle/fleet/from/target
// changent.
function updateSealedPreview() {
  const info = document.getElementById('missionSealedInfo');
  const toggle = document.getElementById('missionSealedToggle');
  if (!info || !toggle) return;
  if (mission.type !== 'attaque' || !toggle.checked) { info.style.display = 'none'; return; }

  const flotte = {};
  document.querySelectorAll('#missionFleet input[data-ship]').forEach(inp => {
    const n = parseInt(inp.value, 10) || 0;
    if (n > 0) flotte[inp.dataset.ship] = n;
  });
  if (Object.keys(flotte).length === 0) {
    info.style.display = '';
    info.innerHTML = '<span style="color:#d27d2c">⚠ Sélectionne au moins 1 vaisseau pour estimer le tick d\'impact</span>';
    return;
  }

  const distance = computeDistanceUI(mission.depuis, mission.cibleJoueur, mission.ciblePlanete);
  const flightTicks = computeFlightTicks(distance, flotte);
  if (flightTicks === null) {
    info.style.display = '';
    info.innerHTML = '<span style="color:#d27d2c">⚠ Composition invalide</span>';
    return;
  }
  const tickCourant = state.manifest?.tick ?? 0;
  const tick_depart = tickCourant + 1;
  const tick_impact = tick_depart + flightTicks;
  const bpt = state.bitcoin?.blocsParTick ?? 30;
  const waitSec = (tick_impact - tickCourant) * bpt * 30;
  const waitMin = Math.round(waitSec / 60);

  info.style.display = '';
  info.innerHTML = `
    <div><span style="color:#d04648">●</span> distance ${distance} · vMin ${Math.min(...Object.keys(flotte).map(s => state.rules?.vaisseaux?.[s]?.vitesse || 0))} · vol ${flightTicks} tick(s)</div>
    <div>tick_depart : <strong style="color:var(--bone)">${tick_depart}</strong> → tick_impact : <strong style="color:#d04648">${tick_impact}</strong></div>
    <div style="margin-top:4px;color:var(--bone-dim)">⏱ Tu devras revenir dans ~${waitMin} min pour publier le reveal (onglet ouvert = auto)</div>
  `;
}

// Construit + inscrit un sceau. À la fin, sauve le secret en localStorage
// pour que l'auto-revealer puisse publier le reveal au tick_impact.
async function submitSealedAttack({ depuis, cibleJoueur, ciblePlanete, flotte }) {
  if (!cfg.ready) { openSettings(); toast('Wallet requis', 'Configure ton wallet Bitcoin.', true); return; }
  if (Object.keys(flotte || {}).length === 0) {
    toast('Flotte vide', 'Inclus au moins 1 vaisseau dans la composition.', true);
    return;
  }
  const ab = window.aetherisBitcoin;
  if (!ab?.ready) { toast('Bitcoin pas prêt', 'Module Bitcoin non chargé.', true); return; }

  const pendingKey = `sealed:${depuis}:${cibleJoueur}:${ciblePlanete}`;
  if (state.pending.has(pendingKey)) return;

  const distance = computeDistanceUI(depuis, cibleJoueur, ciblePlanete);
  const flightTicks = computeFlightTicks(distance, flotte);
  if (flightTicks === null) { toast('Composition invalide', 'Impossible de calculer le temps de vol.', true); return; }

  const tickCourant = state.manifest?.tick ?? 0;
  const tick_depart = tickCourant + 1;
  const tick_impact = tick_depart + flightTicks;

  const nonce = randomSealNonce();
  const secret = {
    type: 'attaque',
    depuis,
    cible: { joueur: cibleJoueur, planete: ciblePlanete },
    flotte: { ...flotte },
    vitesse: 100,
    nonce,
  };
  const hash = ab.computeSealHash(secret);
  const yamlText = buildSealedYamlClient({
    joueur: state.current, tick_depart, planete_origine: depuis, hash,
  });

  state.pending.add(pendingKey); render();
  try {
    const result = await pushSignedOrder(yamlText, `${state.current}: SEALED attaque depuis ${depuis} (tick_depart ${tick_depart})`);
    const record = {
      sealed_txid: result.revealTxid,
      sealed_commit_txid: result.commitTxid,
      joueur: state.current,
      tick_depart, tick_impact,
      planete_origine: depuis,
      distance,
      hash,
      secret,
      revealStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    addSealedRecord(record);
    toast('Sceau publié', `Cible cachée jusqu'à tick ${tick_impact}. Le reveal sera auto-broadcasté à l'arrivée — garde l'onglet ouvert.`);
    closeMission();
    render();
  } catch (e) {
    toast('Échec sealed', e.message || String(e), true);
  } finally {
    state.pending.delete(pendingKey); render();
  }
}

// Auto-revealer : pour chaque sealed local en pending, vérifie si le bloc
// du tick_impact est atteint. Si oui, publie le reveal automatiquement.
// Appelé après chaque boot et après chaque tick advance.
let __autoRevealerBusy = false;
async function runAutoRevealer() {
  if (__autoRevealerBusy) return;
  if (!state.wallet) return;
  const ab = window.aetherisBitcoin;
  if (!ab?.ready) return;
  const list = loadSealedList();
  if (list.length === 0) return;

  const bpt = state.bitcoin?.blocsParTick ?? 30;
  const blocGenesis = state.bitcoin?.blocGenesis;
  if (!blocGenesis) return;
  const tip = state.bitcoin?.tip ?? 0;

  __autoRevealerBusy = true;
  try {
    for (const sealed of list) {
      if (sealed.revealStatus !== 'pending') continue;
      const blockImpact = ab.blockHeightForTick(sealed.tick_impact, blocGenesis, bpt, 0);
      if (tip < blockImpact) continue; // pas encore l'heure

      // Construis et inscris le reveal
      const revealYaml = buildRevealYamlClient({
        joueur: sealed.joueur,
        tick_impact: sealed.tick_impact,
        sealed_txid: sealed.sealed_txid,
        secret: sealed.secret,
      });
      try {
        showStatus(`▸ auto-reveal sceau ${sealed.sealed_txid.slice(0, 8)}…`, true);
        const result = await pushSignedOrder(revealYaml, `${sealed.joueur}: REVEAL sceau ${sealed.sealed_txid.slice(0, 12)}`);
        updateSealedRecord(sealed.sealed_txid, {
          revealStatus: 'broadcast',
          reveal_txid: result.revealTxid,
          reveal_commit_txid: result.commitTxid,
          revealedAt: new Date().toISOString(),
        });
        toast('Reveal auto-publié', `Attaque ${sealed.secret.depuis} → ${sealed.secret.cible.joueur}/${sealed.secret.cible.planete} : impact en cours.`);
      } catch (e) {
        console.warn(`autoRevealer reveal failed for ${sealed.sealed_txid}:`, e);
        toast('Reveal échoué', `Impossible de publier le reveal de ${sealed.sealed_txid.slice(0, 12)}… : ${e.message}`, true);
      }
    }

    // Cleanup : retire les seal "broadcast" qui n'apparaissent plus dans
    // sealedPending on-chain (= consommés par le moteur).
    const pendingOnChain = state.manifest?.sealedPending || {};
    const list2 = loadSealedList();
    let changed = false;
    for (const sealed of list2) {
      if (sealed.revealStatus === 'broadcast' && !pendingOnChain[sealed.sealed_txid]) {
        // Le moteur a consommé le sceau (match ou rejet hash/timing).
        updateSealedRecord(sealed.sealed_txid, { revealStatus: 'confirmed' });
        changed = true;
      }
    }
    if (changed) render();
  } finally {
    __autoRevealerBusy = false;
  }
}

/* ───────────────────────────── OAuth Device Flow ────────────────────────── */
// Reutilise l'OAuth App + worker proxy de join.html. Le token recu remplace
// le PAT manuel, mais est stocke sous la meme cle (cfg.pat) — c'est juste
// un Bearer token aux yeux de l'API GitHub.

let oauthPolling = false;

async function refreshOauthUI() {
  const idle = document.getElementById('oauthIdle');
  const flow = document.getElementById('oauthFlow');
  const done = document.getElementById('oauthDone');
  if (!cfg.pat) {
    idle.hidden = false; flow.hidden = true; done.hidden = true;
    return;
  }
  // Token present — verifier qu'il marche encore et recuperer le login.
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${cfg.pat}`, Accept: 'application/vnd.github+json' },
    });
    if (r.ok) {
      const me = await r.json();
      document.getElementById('oauthUser').textContent = me.login;
      idle.hidden = true; flow.hidden = true; done.hidden = false;
      return;
    }
  } catch {}
  // Token expire/revoque — reset
  cfg.pat = '';
  idle.hidden = false; flow.hidden = true; done.hidden = true;
}

async function oauthDeviceFlow() {
  if (oauthPolling) return;
  oauthPolling = true;
  const idle = document.getElementById('oauthIdle');
  const flow = document.getElementById('oauthFlow');
  const status = document.getElementById('oauthStatus');
  try {
    const r1 = await fetch(`${OAUTH_PROXY}/login/device/code`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, scope: 'public_repo' }),
    });
    if (!r1.ok) throw new Error(`device/code HTTP ${r1.status}`);
    const dev = await r1.json();

    idle.hidden = true;
    flow.hidden = false;
    document.getElementById('oauthUrl').href = dev.verification_uri;
    document.getElementById('oauthUrl').textContent = dev.verification_uri.replace(/^https?:\/\//, '');
    document.getElementById('oauthCode').textContent = dev.user_code;
    status.textContent = 'En attente de ton autorisation…';
    window.open(dev.verification_uri, '_blank', 'noopener');

    const interval = (dev.interval || 5) * 1000;
    const deadline = Date.now() + (dev.expires_in || 900) * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, interval));
      const r2 = await fetch(`${OAUTH_PROXY}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: OAUTH_CLIENT_ID,
          device_code: dev.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const data = await r2.json();
      if (data.access_token) {
        cfg.pat = data.access_token;
        await refreshOauthUI();
        toast('Connecté à GitHub', 'Tu peux maintenant signer et pousser des ordres.');
        render();
        return;
      }
      if (data.error === 'authorization_pending' || data.error === 'slow_down') {
        status.textContent = 'En attente de ton autorisation…';
        continue;
      }
      throw new Error(`OAuth: ${data.error}${data.error_description ? ' — ' + data.error_description : ''}`);
    }
    throw new Error('Code expire avant autorisation. Re-clique pour recommencer.');
  } catch (e) {
    status.textContent = '';
    flow.hidden = true;
    idle.hidden = false;
    toast('Connexion échouée', e.message || String(e), true);
  } finally {
    oauthPolling = false;
  }
}

document.getElementById('oauthConnect').onclick = oauthDeviceFlow;
document.getElementById('oauthLogout').onclick = () => {
  cfg.pat = '';
  refreshOauthUI();
  toast('Déconnecté', 'Tu devras te reconnecter pour signer un nouvel ordre.');
  render();
};

/* ───────────────────────────── Settings modal ───────────────────────────── */
function openSettings() {
  document.getElementById('cfgRepo').value = cfg.repo;
  document.getElementById('cfgBranch').value = cfg.branch;
  document.getElementById('cfgPat').value = cfg.pat;
  document.getElementById('cfgKey').value = cfg.key;
  // Pré-remplir le wallet Bitcoin
  const wallet = state.wallet || loadBitcoinWallet();
  document.getElementById('cfgWallet').value = wallet ? JSON.stringify(wallet, null, 2) : '';
  document.getElementById('modalBg').classList.add('on');
}
function closeSettings() { document.getElementById('modalBg').classList.remove('on'); }
function applySrcUI() {
  // Mode Bitcoin permanent : le bouton devient un indicateur read-only.
  const btn = document.getElementById('srcBtn');
  const lbl = document.getElementById('srcLabel');
  if (!btn || !lbl) return;
  const tip = state.bitcoin?.tip;
  lbl.textContent = tip ? `⛓ ${tip}` : '⛓ bitcoin';
  btn.title = state.bitcoin
    ? `Bitcoin Mutinynet · tip ${tip} · tick ${state.bitcoin.tickCourant}`
    : 'Source : Bitcoin Mutinynet (lecture en cours)';
  btn.style.cursor = 'default';
}
document.getElementById('srcBtn').onclick = () => { /* read-only en mode Bitcoin */ };
applySrcUI();

document.getElementById('gearBtn').onclick = openSettings;
document.getElementById('cfgCancel').onclick = closeSettings;
document.getElementById('modalBg').onclick = e => { if (e.target.id === 'modalBg') closeSettings(); };
document.getElementById('cfgSave').onclick = async () => {
  // Wallet Bitcoin : parse JSON, valide, chiffre avec password, persiste.
  const walletRaw = document.getElementById('cfgWallet').value.trim();
  if (walletRaw) {
    try {
      const w = JSON.parse(walletRaw);
      if (!w.privateKeyWIF || !w.taprootAddress) {
        toast('Wallet invalide', 'Le JSON doit contenir privateKeyWIF et taprootAddress.', true);
        return;
      }
      await saveBitcoinWallet(w);
      state.wallet = w;
    } catch (e) {
      toast('Wallet illisible', e.message, true);
      return;
    }
  }
  closeSettings();
  if (state.wallet) {
    const lock = state.walletPassword ? '🔒 chiffré' : '⚠ en clair';
    toast('Wallet scellé', `${state.wallet.taprootAddress.slice(0,16)}… (${lock})`);
  }
  else toast('Wallet manquant', 'Colle ton .btc-key (JSON) pour pouvoir inscrire des ordres.', true);
  render();
};
document.getElementById('cfgClear').onclick = () => {
  if (!confirm('Effacer clé Ed25519, wallet Bitcoin et pseudo de ce navigateur ?')) return;
  cfg.pat = ''; cfg.key = '';
  clearBitcoinWallet();
  localStorage.removeItem('aetheris.player');
  localStorage.removeItem('aetheris.onboarding.done');
  localStorage.removeItem('aetheris.onboarding.step');
  localStorage.removeItem('aetheris.onboarding.tickRef');
  state.current = null;
  openSettings();
};
// Vide le cache scan IndexedDB et recharge — utile si le scan est désynchronisé.
document.getElementById('cfgResetCache').onclick = async () => {
  if (!confirm('Vider le cache scan ? Le prochain boot rescanne toute la chaîne (~quelques minutes).')) return;
  try {
    await window.aetherisBitcoin?.cacheAdapter?.clear();
    closeSettings();
    toast('Cache vidé', 'Rescan complet en cours…');
    await load();
  } catch (e) {
    toast('Erreur', e.message, true);
  }
};

/* ───────────────────────────── Mission modal ────────────────────────────── */
const mission = {
  type: 'espionnage',
  cibleJoueur: null, ciblePlanete: null,
  // Mode colonisation : cible adressée par { systeme, position, classe }.
  cibleSysteme: null, ciblePosition: null, cibleClasse: null,
  depuis: null,
};

function openColonisation(systeme, position, classe) {
  const emp = state.players[state.current];
  if (!emp || !(emp.planetes || []).length) {
    toast('Pas de planète', 'Tu n\'as aucune planète d\'origine pour lancer une mission.', true);
    return;
  }
  const cap = state.manifest?.parametres?.planetes_max_par_joueur ?? 9;
  const colsEnVol = (emp.flottes_en_vol || []).filter(f => f.type_mission === 'colonisation').length;
  if ((emp.planetes?.length || 0) + colsEnVol >= cap) {
    toast('Quota atteint', `Cap ${cap} planètes (possédées + colons en vol). Annule une colonisation en cours pour en lancer une autre.`, true);
    return;
  }
  mission.cibleJoueur = null;
  mission.ciblePlanete = null;
  mission.cibleSysteme = systeme;
  mission.ciblePosition = position;
  mission.cibleClasse = classe || null;
  mission.depuis = emp.planetes[0].nom;
  mission.type = 'colonisation';

  document.getElementById('missionTarget').innerHTML =
    `colonisation · case libre <b>${systeme}:${position}</b>${classe ? ` · ${classe}` : ''}`;

  // En mode colonisation, seul le bouton "Coloniser" est actif.
  document.querySelectorAll('#missionType button').forEach(b => {
    const mt = b.dataset.mt;
    b.disabled = mt !== 'colonisation';
    b.title = mt !== 'colonisation' ? 'Cible inhabitée : seule la colonisation est possible' : '';
    if (mt === 'recyclage') b.textContent = 'Recyclage';
  });
  document.querySelectorAll('#missionType button').forEach(b =>
    b.classList.toggle('on', b.dataset.mt === 'colonisation')
  );

  // dropdown source
  const fromSel = document.getElementById('missionFrom');
  fromSel.innerHTML = emp.planetes.map(p =>
    `<option value="${p.nom}">${p.nom} · ${(p.coordonnees||[]).join(':')}</option>`
  ).join('');
  fromSel.value = mission.depuis;
  fromSel.onchange = () => { mission.depuis = fromSel.value; renderMissionFleet(); };

  // Hook bouton "Coloniser" (au cas où l'utilisateur reclique dessus).
  document.querySelectorAll('#missionType button').forEach(b => {
    b.onclick = () => {
      if (b.disabled) return;
      mission.type = b.dataset.mt;
      document.querySelectorAll('#missionType button').forEach(x =>
        x.classList.toggle('on', x.dataset.mt === mission.type)
      );
      renderMissionFleet();
    };
  });

  // Pré-remplir le champ nom_colonie vide.
  document.getElementById('missionNomColonie').value = '';

  renderMissionFleet();
  document.getElementById('missionBg').classList.add('on');
}

function openMission(joueurCible, planeteCible) {
  const emp = state.players[state.current];
  if (!emp || !(emp.planetes || []).length) {
    toast('Pas de planète', 'Tu n\'as aucune planète d\'origine pour lancer une mission.', true);
    return;
  }
  mission.cibleJoueur = joueurCible;
  mission.ciblePlanete = planeteCible;
  mission.cibleSysteme = null;
  mission.ciblePosition = null;
  mission.cibleClasse = null;
  // Si la cible est une de mes propres planètes, on ne sélectionne pas
  // celle-ci comme source par défaut (transport sur soi-même = no-op).
  const isOwnTarget = joueurCible === state.current;
  const others = emp.planetes.filter(p => p.nom !== planeteCible);
  mission.depuis = (isOwnTarget && others.length > 0 ? others[0] : emp.planetes[0]).nom;
  mission.type = isOwnTarget ? 'transport' : 'espionnage';

  document.getElementById('missionTarget').innerHTML =
    isOwnTarget
      ? `transport interne vers <b>${planeteCible}</b>`
      : `cible : <b>${planeteCible}</b> · ${joueurCible}`;

  // Détecte un éventuel champ de débris sur la planète cible (uniquement
  // si elle est à toi : on lit empire.yaml).
  const targetPlanet = isOwnTarget
    ? (emp.planetes || []).find(p => p.nom === planeteCible)
    : null;
  const debris = targetPlanet?.champ_debris;
  const totalDebris = (debris?.ferrum || 0) + (debris?.lumen || 0);

  // Désactive les types incompatibles avec une cible alliée et le
  // recyclage si pas de débris à ramasser.
  document.querySelectorAll('#missionType button').forEach(b => {
    const mt = b.dataset.mt;
    let dis = false, why = '';
    if (isOwnTarget && (mt === 'espionnage' || mt === 'attaque')) {
      dis = true; why = 'Pas de mission hostile sur tes propres planètes';
    }
    if (mt === 'recyclage' && (!isOwnTarget || totalDebris === 0)) {
      dis = true;
      why = !isOwnTarget
        ? 'Recyclage v1 limité à tes propres planètes'
        : 'Aucun débris à recycler ici';
    }
    if (mt === 'colonisation') {
      dis = true;
      why = 'La colonisation cible une case libre (clique sur une planète sans propriétaire).';
    }
    b.disabled = dis;
    b.title = why;
    if (mt === 'recyclage' && totalDebris > 0) {
      b.textContent = `Recyclage (${fmtCompact(totalDebris)})`;
    } else if (mt === 'recyclage') {
      b.textContent = 'Recyclage';
    }
  });

  // dropdown source
  const fromSel = document.getElementById('missionFrom');
  fromSel.innerHTML = emp.planetes.map(p =>
    `<option value="${p.nom}">${p.nom} · ${(p.coordonnees||[]).join(':')}</option>`
  ).join('');
  fromSel.value = mission.depuis;
  fromSel.onchange = () => { mission.depuis = fromSel.value; renderMissionFleet(); };

  // segmented buttons
  document.querySelectorAll('#missionType button').forEach(b => {
    b.classList.toggle('on', b.dataset.mt === mission.type);
    b.onclick = () => {
      mission.type = b.dataset.mt;
      document.querySelectorAll('#missionType button').forEach(x => x.classList.toggle('on', x.dataset.mt === mission.type));
      renderMissionFleet();
    };
  });

  renderMissionFleet();
  document.getElementById('missionBg').classList.add('on');
}

function closeMission() { document.getElementById('missionBg').classList.remove('on'); }

function renderMissionFleet() {
  const emp = state.players[state.current];
  const planete = (emp?.planetes || []).find(p => p.nom === mission.depuis);
  const owned = planete?.flotte_au_sol || {};
  const lblEl = document.getElementById('missionFleetLabel');
  const wrap = document.getElementById('missionFleet');
  const cargoBlock = document.getElementById('missionCargoBlock');
  const nomBlock = document.getElementById('missionNomBlock');
  const sealedBlock = document.getElementById('missionSealedBlock');
  // Le bloc "nom de la colonie" n'est visible qu'en mode colonisation.
  if (nomBlock) nomBlock.style.display = mission.type === 'colonisation' ? '' : 'none';
  // Le toggle de scellement n'est offert qu'en mode attaque (v1).
  if (sealedBlock) {
    sealedBlock.style.display = mission.type === 'attaque' ? '' : 'none';
    if (mission.type !== 'attaque') {
      const t = document.getElementById('missionSealedToggle');
      if (t) t.checked = false;
      const info = document.getElementById('missionSealedInfo');
      if (info) info.style.display = 'none';
    }
  }

  if (mission.type === 'espionnage') {
    lblEl.textContent = 'Sondes';
    cargoBlock.style.display = 'none';
    const have = owned.sonde || 0;
    const initial = Math.min(Math.max(1, have), Math.max(1, have));
    wrap.innerHTML = `<div class="fleetgrid">
      <span class="nm">Sonde</span>
      <span class="av">${have} dispo</span>
      <input type="number" min="1" max="${Math.max(1, have)}" value="${have > 0 ? Math.min(1, have) : 1}" data-ship="sonde"/>
    </div>`;
    if (have === 0) {
      wrap.innerHTML += `<div class="empty-fleet">Aucune sonde sur ${mission.depuis}. Construis-en avant de lancer une mission d'espionnage.</div>`;
    }
  } else if (mission.type === 'attaque') {
    lblEl.textContent = 'Composition de la flotte';
    cargoBlock.style.display = 'none';
    const ships = Object.entries(owned).filter(([k, n]) => n > 0 && state.rules?.vaisseaux?.[k]);
    if (ships.length === 0) {
      wrap.innerHTML = `<div class="empty-fleet">Aucun vaisseau disponible sur ${mission.depuis}.</div>`;
      return;
    }
    wrap.innerHTML = `<div class="fleetgrid">${ships.map(([k, n]) => `
      <span class="nm">${labels[k] || k}</span>
      <span class="av">${fmt(n)} dispo</span>
      <input type="number" min="0" max="${n}" value="0" data-ship="${k}"/>
    `).join('')}</div>`;
  } else if (mission.type === 'transport') {
    lblEl.textContent = 'Flotte de transport';
    cargoBlock.style.display = '';
    const ships = Object.entries(owned).filter(([k, n]) => n > 0 && state.rules?.vaisseaux?.[k]);
    if (ships.length === 0) {
      wrap.innerHTML = `<div class="empty-fleet">Aucun vaisseau disponible sur ${mission.depuis}.</div>`;
      return;
    }
    wrap.innerHTML = `<div class="fleetgrid">${ships.map(([k, n]) => `
      <span class="nm">${labels[k] || k}</span>
      <span class="av">${fmt(n)} dispo · cargo ${state.rules.vaisseaux[k]?.cargo || 0}</span>
      <input type="number" min="0" max="${n}" value="${k === 'cargo_lourd' ? Math.min(1, n) : 0}" data-ship="${k}"/>
    `).join('')}</div>`;
    // pré-remplir cargaison à 0
    document.getElementById('cargoFerrum').value = 0;
    document.getElementById('cargoLumen').value = 0;
    document.getElementById('cargoPlasmide').value = 0;
  } else if (mission.type === 'recyclage') {
    lblEl.textContent = 'Recycleurs à envoyer';
    cargoBlock.style.display = 'none';
    const have = owned.recycleur || 0;
    const cargoUnit = state.rules.vaisseaux?.recycleur?.cargo || 20000;
    wrap.innerHTML = `<div class="fleetgrid">
      <span class="nm">Recycleur</span>
      <span class="av">${fmt(have)} dispo · cargo ${fmtCompact(cargoUnit)}/u</span>
      <input type="number" min="0" max="${have}" value="${Math.min(1, have)}" data-ship="recycleur"/>
    </div>`;
    if (have === 0) {
      wrap.innerHTML += `<div class="empty-fleet">Aucun recycleur sur ${mission.depuis}. Construis-en un (chantier spatial).</div>`;
    }
  } else if (mission.type === 'colonisation') {
    lblEl.textContent = 'Flotte de colonisation';
    cargoBlock.style.display = '';
    const haveColon = owned.vaisseau_colon || 0;
    // On expose vaisseau_colon (obligatoire ≥1) + tout autre vaisseau présent en escorte.
    const others = Object.entries(owned).filter(([k, n]) => n > 0 && k !== 'vaisseau_colon' && state.rules?.vaisseaux?.[k]);
    let html = `<div class="fleetgrid">
      <span class="nm">Vaisseau colon <span style="opacity:0.55">(consommé)</span></span>
      <span class="av">${fmt(haveColon)} dispo</span>
      <input type="number" min="1" max="${Math.max(1, haveColon)}" value="${haveColon > 0 ? 1 : 1}" data-ship="vaisseau_colon"/>`;
    for (const [k, n] of others) {
      html += `
      <span class="nm">${labels[k] || k} <span style="opacity:0.55">(escorte)</span></span>
      <span class="av">${fmt(n)} dispo · cargo ${state.rules.vaisseaux[k]?.cargo || 0}</span>
      <input type="number" min="0" max="${n}" value="0" data-ship="${k}"/>`;
    }
    html += `</div>`;
    wrap.innerHTML = html;
    if (haveColon === 0) {
      wrap.innerHTML += `<div class="empty-fleet">Aucun vaisseau_colon sur ${mission.depuis}. Construis-en au chantier spatial avant de lancer une colonisation.</div>`;
    }
    // pré-remplir cargaison à 0
    document.getElementById('cargoFerrum').value = 0;
    document.getElementById('cargoLumen').value = 0;
    document.getElementById('cargoPlasmide').value = 0;
  }
}

document.getElementById('missionCancel').onclick = closeMission;
document.getElementById('missionBg').onclick = e => { if (e.target.id === 'missionBg') closeMission(); };
// Listeners pour réactualiser l'aperçu sealed dès qu'une input change.
document.addEventListener('input', (e) => {
  if (e.target.closest && e.target.closest('#missionFleet')) updateSealedPreview();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'missionSealedToggle') updateSealedPreview();
});

document.getElementById('missionSubmit').onclick = () => {
  const flotte = {};
  document.querySelectorAll('#missionFleet input[data-ship]').forEach(inp => {
    const n = parseInt(inp.value, 10) || 0;
    if (n > 0) flotte[inp.dataset.ship] = n;
  });

  // Mode scellement : court-circuit le panier classique, broadcast direct.
  const sealedToggle = document.getElementById('missionSealedToggle');
  if (mission.type === 'attaque' && sealedToggle?.checked) {
    submitSealedAttack({
      depuis: mission.depuis,
      cibleJoueur: mission.cibleJoueur,
      ciblePlanete: mission.ciblePlanete,
      flotte,
    });
    return;
  }

  const payload = {
    type: mission.type,
    depuis: mission.depuis,
    cibleJoueur: mission.cibleJoueur,
    ciblePlanete: mission.ciblePlanete,
  };
  if (mission.type === 'espionnage') {
    payload.nombreSondes = flotte.sonde || 0;
  } else if (mission.type === 'attaque') {
    payload.flotte = flotte;
  } else if (mission.type === 'transport') {
    payload.flotte = flotte;
    payload.cargaison = {
      ferrum: parseInt(document.getElementById('cargoFerrum').value, 10) || 0,
      lumen: parseInt(document.getElementById('cargoLumen').value, 10) || 0,
      plasmide: parseInt(document.getElementById('cargoPlasmide').value, 10) || 0,
    };
  } else if (mission.type === 'recyclage') {
    payload.flotte = flotte;
  } else if (mission.type === 'colonisation') {
    payload.cibleSysteme = mission.cibleSysteme;
    payload.ciblePosition = mission.ciblePosition;
    payload.flotte = flotte;
    payload.cargaison = {
      ferrum: parseInt(document.getElementById('cargoFerrum').value, 10) || 0,
      lumen: parseInt(document.getElementById('cargoLumen').value, 10) || 0,
      plasmide: parseInt(document.getElementById('cargoPlasmide').value, 10) || 0,
    };
    payload.nomColonie = (document.getElementById('missionNomColonie').value || '').trim();
  }
  submitMission(payload);
};

/* ───────────────────────────── Onboarding (tour 5 étapes) ───────────────── */
// État persistant : 0 = pas commencé, 1..4 = étape N vue mais la suivante
// pas encore atteinte, 5 = guide terminé. Le tour ne revient jamais une fois ≥5.
const OB_STORAGE_KEY = 'aetheris.onboarding.step';
const OB_TOTAL = 5;
function obGetStep() {
  const v = parseInt(localStorage.getItem(OB_STORAGE_KEY) || '0', 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(OB_TOTAL, v)) : 0;
}
function obSetStep(n) {
  localStorage.setItem(OB_STORAGE_KEY, String(Math.max(0, Math.min(OB_TOTAL, n))));
}
// Tick de référence stocké au moment où l'étape 1 est déclenchée — utilisé
// comme heuristique pour détecter "≥2 améliorations" plus tard (étape 3).
const OB_TICK_REF_KEY = 'aetheris.onboarding.tickRef';

// État runtime : étape actuellement à l'écran (1..5), 0 si fermé.
const obTour = { current: 0, primaryAction: null };

function showOnboardingStep(step, p, emp) {
  if (!cfg.ready) return;
  const modal = document.getElementById('obBg');
  if (!modal) return;
  obTour.current = step;
  document.getElementById('obStepMarker').textContent = `Étape ${step}/${OB_TOTAL}`;

  const stats = document.getElementById('obStep1Stats');
  const tickBlock = document.getElementById('obStep1Tick');
  const list = document.getElementById('obStep1List');
  const title = document.getElementById('obTourTitle');
  const sub = document.getElementById('obTourSub');
  const goBtn = document.getElementById('obGoBtn');

  // Par défaut, masque les blocs spécifiques à l'étape 1.
  stats.style.display = 'none';
  tickBlock.style.display = 'none';
  list.style.display = 'none';

  if (step === 1) {
    const planetName = p?.nom || '—';
    title.innerHTML = `Bienvenue, <span id="ob-name">${escapeHtml(state.current || 'commandant')}</span>.`;
    sub.innerHTML = `Tu contrôles <strong id="ob-planet">${escapeHtml(planetName)}</strong>. Citadel est un MMO 4X qui vit dans la blockchain Bitcoin : chaque ordre est une inscription Taproot signée par ta clé, appliquée par le moteur à chaque <span class="gloss" title="Un tick = 30 blocs Mutinynet (signet Bitcoin). Cible ≈ 15 min. Tous les ordres confirmés dans le cycle de 30 blocs sont appliqués au tick suivant.">tick</span>.`;
    stats.style.display = '';
    tickBlock.style.display = '';
    list.style.display = '';
    document.getElementById('ob-coords').textContent = (p?.coordonnees || []).join(':') || '—';
    document.getElementById('ob-classe').textContent = p?.type || '—';
    const ch = p?.champs || {};
    document.getElementById('ob-champs').textContent = `${(ch.total || 0) - (ch.utilises || 0)} / ${ch.total || 0}`;
    const niv = p?.batiments?.mine_ferrum || 0;
    goBtn.textContent = niv === 0
      ? 'Construire ma Mine de Ferrum →'
      : `Améliorer ma Mine (niv ${niv} → ${niv + 1}) →`;
    obTour.primaryAction = async () => {
      try {
        const tref = (state.manifest?.tick) ?? 0;
        localStorage.setItem(OB_TICK_REF_KEY, String(tref));
      } catch {}
      closeOnboarding(true);
      await submitImprove('mine_ferrum');
    };
    refreshOnboardingTick();
  } else if (step === 2) {
    title.textContent = 'Découvre la galaxie';
    sub.innerHTML = `Ton ordre est inscrit. En attendant le prochain bloc, explore la galaxie : clique sur une planète ennemie pour préparer une mission.`;
    goBtn.textContent = 'Ouvrir la galaxie →';
    obTour.primaryAction = () => {
      closeOnboarding(false);
      state.view = 'galaxie';
      localStorage.setItem('aetheris.view', 'galaxie');
      applyView();
    };
  } else if (step === 3) {
    title.textContent = 'Construis ton premier vaisseau';
    sub.innerHTML = `Avec un <strong>Chantier Spatial</strong> (qui requiert Usine Robotique niv 2), tu peux construire des vaisseaux. Le <strong>Chasseur Léger</strong> est l'unité d'entrée — pas de recherche requise, peu cher, polyvalent.`;
    goBtn.textContent = 'Aller à la Flotte →';
    obTour.primaryAction = () => {
      closeOnboarding(false);
      state.view = 'flotte';
      localStorage.setItem('aetheris.view', 'flotte');
      applyView();
    };
  } else if (step === 4) {
    title.textContent = 'Lance ton premier raid';
    sub.innerHTML = `Tu as une flotte ! Ouvre la galaxie, choisis une planète ennemie et envoie une <strong>attaque</strong>. Si tu gagnes, tu pilles ses ressources et le combat génère un champ de débris recyclable.`;
    goBtn.textContent = 'Ouvrir la galaxie →';
    obTour.primaryAction = () => {
      closeOnboarding(false);
      state.view = 'galaxie';
      localStorage.setItem('aetheris.view', 'galaxie');
      applyView();
    };
  } else if (step === 5) {
    title.textContent = 'Lis tes rapports';
    sub.innerHTML = `Ton rapport de bataille est arrivé. L'onglet <strong>Rapports</strong> archive tous tes combats et espionnages. Plus tard, quand tu auras la recherche <em>Espionnage Profond</em>, tu pourras envoyer des sondes avant chaque attaque pour évaluer les défenses adverses.`;
    goBtn.textContent = 'Voir mes rapports →';
    obTour.primaryAction = () => {
      // Étape finale : marque le guide comme terminé.
      obSetStep(OB_TOTAL);
      obTour.current = 0;
      modal.classList.remove('on');
      state.view = 'rapports';
      localStorage.setItem('aetheris.view', 'rapports');
      applyView();
    };
  }
  modal.classList.add('on');
}

// Rétro-compat : ancien point d'entrée. La logique vit dans
// maybeAdvanceOnboarding(p, emp).
function showOnboarding(_planetName) {
  const emp = state.players[state.current];
  const p = emp?.planetes?.[0];
  maybeAdvanceOnboarding(p, emp);
}

// Détection de progression : appelée à chaque rerender. Si la condition de
// l'étape suivante est remplie, ouvre le modal correspondant.
function maybeAdvanceOnboarding(p, emp) {
  if (!cfg.ready || !p || !emp) return;
  const stored = obGetStep();
  if (stored >= OB_TOTAL) return; // guide terminé
  if (obTour.current > 0) return; // déjà ouvert

  if (stored === 0) {
    showOnboardingStep(1, p, emp);
    return;
  }
  // Étape 2 : un ordre est en pending OU mine_ferrum >= 1.
  if (stored === 1) {
    const hasPending = state.pending && state.pending.size > 0;
    const niv = (p.batiments?.mine_ferrum || 0);
    if (hasPending || niv >= 1) {
      showOnboardingStep(2, p, emp);
      return;
    }
  }
  // Étape 3 : chantier_spatial >= 1 OU heuristique ≥2 améliorations.
  if (stored === 2) {
    const cs = (p.batiments?.chantier_spatial || 0);
    let advanced = cs >= 1;
    if (!advanced) {
      const tref = parseInt(localStorage.getItem(OB_TICK_REF_KEY) || '0', 10);
      const tcur = (state.manifest?.tick) ?? 0;
      const totalLvl = Object.values(p.batiments || {}).reduce((a, b) => a + (b || 0), 0);
      if ((tcur - tref) >= 2 && totalLvl >= 2) advanced = true;
    }
    if (advanced) {
      showOnboardingStep(3, p, emp);
      return;
    }
  }
  // Étape 4 : au moins une unité offensive au sol (chasseur ou +).
  // La sonde requiert la recherche espionnage_profond — pas réaliste pour un débutant.
  if (stored === 3) {
    const fl = p.flotte_au_sol || {};
    const offensiveUnits = (fl.chasseur_leger || 0) + (fl.chasseur_lourd || 0)
      + (fl.croiseur || 0) + (fl.fregate || 0) + (fl.cuirasse || 0)
      + (fl.destroyer || 0) + (fl.dreadnought || 0);
    if (offensiveUnits >= 1) {
      showOnboardingStep(4, p, emp);
      return;
    }
  }
  // Étape 5 : au moins un rapport (bataille ou intel) où le joueur est impliqué.
  if (stored === 4) {
    const me = state.current;
    const intel = state.reports?.intelByPlayer?.[me] || [];
    const battles = (state.reports?.battles || [])
      .filter(b => b.attaquant === me || b.defenseur === me);
    if (intel.length > 0 || battles.length > 0) {
      showOnboardingStep(5, p, emp);
      return;
    }
  }
}

function refreshOnboardingTick() {
  const el = document.getElementById('ob-countdown');
  const modal = document.getElementById('obBg');
  if (!el || !modal || !modal.classList.contains('on')) return;
  if (obTour.current !== 1) return;
  const info = nextTickInfo();
  const m = Math.floor(info.secs / 60);
  const s = info.secs % 60;
  el.textContent = `${m}m ${String(s).padStart(2,'0')}s`;
}

// "Plus tard" : on enregistre l'étape courante comme vue ; le modal reviendra
// quand la condition de l'étape suivante sera satisfaite.
function closeOnboarding(goToBat) {
  if (obTour.current > 0) {
    obSetStep(obTour.current);
  }
  obTour.current = 0;
  const modal = document.getElementById('obBg');
  if (modal) modal.classList.remove('on');
  if (goToBat) {
    state.view = 'batiments';
    localStorage.setItem('aetheris.view', 'batiments');
    applyView();
  }
}

// "Passer le guide" : termine définitivement le tour.
function skipOnboardingTour() {
  obSetStep(OB_TOTAL);
  obTour.current = 0;
  const modal = document.getElementById('obBg');
  if (modal) modal.classList.remove('on');
}

// Action principale du modal — déléguée à l'étape courante.
function onboardingPrimaryAction() {
  if (typeof obTour.primaryAction === 'function') {
    obTour.primaryAction();
  }
}

// Escape ferme le modal (équivalent à "Plus tard").
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('obBg');
  if (modal && modal.classList.contains('on') && obTour.current > 0) {
    closeOnboarding(false);
  }
});

// Alias rétro-compat conservé pour ne casser aucun appel inline existant.
async function upgradeFirstMine() {
  closeOnboarding(true);
  await submitImprove('mine_ferrum');
}

/* ───────────────────────────── Toast ────────────────────────────────────── */
let toastTimer = null;
function toast(title, msg, isErr) {
  const t = document.getElementById('toast');
  t.className = 'toast on' + (isErr ? ' err' : '');
  t.innerHTML = `<button class="close" aria-label="Fermer" onclick="this.parentElement.classList.remove('on')">×</button>
    <div class="title">${title}</div><div>${msg}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 6000);
}

/* tooltip global — délégué sur tout élément avec data-tip */
(function setupTooltip() {
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  document.body.appendChild(tip);
  let target = null;

  function show(el) {
    target = el;
    tip.textContent = el.getAttribute('data-tip') || '';
    tip.classList.add('on');
    position(el);
  }
  function hide() {
    target = null;
    tip.classList.remove('on');
  }
  function position(el) {
    const r = el.getBoundingClientRect();
    // Affiche tooltip de préférence à droite, sinon à gauche, sinon en bas
    const tipR = tip.getBoundingClientRect();
    const margin = 8;
    let left = r.right + margin;
    let top  = r.top;
    if (left + tipR.width > window.innerWidth - 8) {
      left = r.left - tipR.width - margin;
    }
    if (left < 8) {
      left = Math.min(window.innerWidth - tipR.width - 8, Math.max(8, r.left));
      top = r.bottom + margin;
    }
    if (top + tipR.height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - tipR.height - 8);
    }
    tip.style.left = left + 'px';
    tip.style.top  = top  + 'px';
  }

  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]');
    if (el && el !== target) show(el);
  });
  document.addEventListener('mouseout', e => {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    hide();
  });
  window.addEventListener('scroll', hide, true);
})();

/* ───────────────────────────── Notifications ────────────────────────────── */
const notif = {
  list: [],
  pushPerm: (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported',
  storageKey() { return `aetheris.notifs.${state.current || '_'}`; },
  load() {
    try { this.list = JSON.parse(localStorage.getItem(this.storageKey()) || '[]'); }
    catch { this.list = []; }
  },
  save() {
    try { localStorage.setItem(this.storageKey(), JSON.stringify(this.list.slice(0, 200))); } catch {}
  },
  add(n) {
    n.id = `${n.type}:${n.key}`;
    if (this.list.some(x => x.id === n.id)) return false;
    n.ts = Date.now(); n.read = false;
    this.list.unshift(n);
    this.save();
    toast(n.title, n.body, n.severity === 'high');
    if (document.hidden && this.pushPerm === 'granted' && n.severity !== 'low') {
      try {
        const stripped = String(n.body).replace(/<[^>]+>/g, '');
        new Notification(n.title, { body: stripped, tag: n.id });
      } catch {}
    }
    return true;
  },
  unread() { return this.list.filter(x => !x.read).length; },
  markAllRead() { this.list.forEach(x => x.read = true); this.save(); refreshNotifUI(); },
  clearAll() { this.list = []; this.save(); refreshNotifUI(); },
  async requestPush() {
    if (typeof Notification === 'undefined') return;
    try {
      const p = await Notification.requestPermission();
      this.pushPerm = p;
      refreshNotifUI();
      if (p === 'granted') toast('Notifications activées', 'Tu recevras les alertes critiques même hors-onglet.');
    } catch {}
  },
};

const notifSnap = {};

let notifLoadedFor = null;
function detectNotifs() {
  const me = state.current; if (!me) return;
  const emp = state.players[me]; if (!emp) return;
  if (notifLoadedFor !== me) {
    notif.load();
    notifLoadedFor = me;
  }
  const tick = state.manifest?.tick ?? 0;

  const chantiers = new Map();
  for (const p of (emp.planetes || [])) {
    for (const c of (p.file_chantier || [])) {
      const key = `${p.nom}|${c.batiment || c.unite || '?'}|${c.niveau_cible ?? c.quantite ?? ''}|${c.fin_utj ?? ''}`;
      chantiers.set(key, { p, c });
    }
  }
  const research = new Map();
  for (const r of (emp.file_recherche || [])) {
    const key = `${r.technologie || r.recherche || r.discipline}|${r.niveau_cible ?? ''}|${r.fin_utj ?? ''}`;
    research.set(key, r);
  }
  const hostile = new Set(['attaque', 'siege', 'pillage', 'bombardement']);
  const myPlanets = new Set((emp.planetes || []).map(p => p.nom));
  const incoming = new Map();
  for (const [pname, e] of Object.entries(state.players || {})) {
    if (pname === me) continue;
    for (const f of (e.flottes_en_vol || [])) {
      const dest = f.vers?.planete || f.vers;
      if (!myPlanets.has(dest)) continue;
      if (!hostile.has((f.type_mission || '').toLowerCase())) continue;
      const key = `${pname}|${f.depuis?.planete || '?'}|${dest}|${f.type_mission}|${f.tick_arrivee || 0}`;
      incoming.set(key, { from: pname, f, dest });
    }
  }
  const stockFull = new Map();
  for (const p of (emp.planetes || [])) {
    for (const [res, r] of Object.entries(p.ressources || {})) {
      if (!r || !r.capacite) continue;
      if (r.stock >= r.capacite * 0.95 && (r.production_par_utj || 0) > 0) {
        stockFull.set(`${p.nom}|${res}`, { p, res, r });
      }
    }
  }

  const prev = notifSnap[me];
  if (prev) {
    for (const [key, m] of prev.chantiers) {
      if (!chantiers.has(key)) {
        const what = m.c.batiment
          ? `${m.c.batiment} → niv ${m.c.niveau_cible ?? ''}`
          : `${m.c.quantite ?? 1}× ${m.c.unite ?? '?'}`;
        notif.add({ type: 'chantier-done', severity: 'med', key,
          title: 'Chantier terminé',
          body: `${what} sur <b>${m.p.nom}</b>.` });
      }
    }
    for (const [key, r] of prev.research) {
      if (!research.has(key)) {
        notif.add({ type: 'research-done', severity: 'med', key,
          title: 'Recherche complétée',
          body: `<b>${r.technologie || r.recherche || r.discipline}</b> → niv ${r.niveau_cible ?? ''}.` });
      }
    }
    for (const [key, m] of incoming) {
      if (!prev.incoming.has(key)) {
        const arr = m.f.tick_arrivee || 0;
        const ticksLeft = Math.max(0, arr - tick);
        notif.add({ type: 'incoming', severity: 'high', key,
          title: 'Flotte hostile détectée',
          body: `<b>${m.from}</b> envoie une <b>${m.f.type_mission}</b> sur <b>${m.dest}</b> · impact dans <b>${ticksLeft} cycle${ticksLeft > 1 ? 's' : ''}</b>.` });
      }
    }
    for (const [key, m] of stockFull) {
      if (!prev.stockFull.has(key)) {
        const pct = Math.round(100 * m.r.stock / m.r.capacite);
        notif.add({ type: 'stock-full', severity: 'low', key: `${key}|${tick}`,
          title: 'Stockage saturé',
          body: `<b>${m.res}</b> sur <b>${m.p.nom}</b> à ${pct}% (${fmt(m.r.stock)}/${fmt(m.r.capacite)}).` });
      }
    }
    // Rapports nouveaux : intel/alert/battle pour le joueur courant
    for (const r of (state.reports?.intelByPlayer?.[me] || [])) {
      const key = `intel|${r.filename}`;
      if (!prev.reports.has(key)) {
        notif.add({ type: 'rapport-intel', severity: 'med', key,
          title: 'Nouveau rapport d\'espionnage',
          body: `Tick ${r.tick} · ${escapeHtml(rapportTitle({kind:'intel', content:r.content}))}` });
      }
    }
    for (const r of (state.reports?.alertsByPlayer?.[me] || [])) {
      const key = `alert|${r.filename}`;
      if (!prev.reports.has(key)) {
        notif.add({ type: 'rapport-alert', severity: 'high', key,
          title: '⚠ Tu as été espionné',
          body: `Tick ${r.tick} · contre-espionnage activé` });
      }
    }
    for (const b of (state.reports?.battles || [])) {
      if (b.attaquant !== me && b.defenseur !== me) continue;
      const key = `battle|${b.filename}`;
      if (!prev.reports.has(key)) {
        const isAtt = b.attaquant === me;
        const adv = isAtt ? b.defenseur : b.attaquant;
        const sev = (!isAtt && b.issue === 'victoire-attaquant') ? 'high' : 'med';
        notif.add({ type: 'rapport-battle', severity: sev, key,
          title: isAtt ? 'Rapport de bataille' : '⚔ Attaque sur ton empire',
          body: `Tick ${b.tick} · ${isAtt ? 'contre' : 'par'} <b>${adv}</b> sur <b>${b.lieu || '?'}</b> · ${b.issue || ''}` });
      }
    }
  }

  // Index des rapports déjà notifiés (sous forme Set de clés)
  const reportKeys = new Set();
  for (const r of (state.reports?.intelByPlayer?.[me] || [])) reportKeys.add(`intel|${r.filename}`);
  for (const r of (state.reports?.alertsByPlayer?.[me] || [])) reportKeys.add(`alert|${r.filename}`);
  for (const b of (state.reports?.battles || [])) {
    if (b.attaquant === me || b.defenseur === me) reportKeys.add(`battle|${b.filename}`);
  }

  // Singularité produite — moment rare, mérite un toast doré + un éclat
  // sur le badge Σ du sub-header.
  const singCur = emp?.ressources_globales?.singularite || 0;
  if (prev && singCur > (prev.singularite || 0)) {
    const delta = singCur - prev.singularite;
    toast(
      '✦ Singularité quantique condensée',
      `Tes anomalies colonisées ont produit <b>${delta}</b> singularité${delta > 1 ? 's' : ''}. Total : <b>${singCur}</b>.`,
      false,
    );
    requestAnimationFrame(() => {
      const chip = document.querySelector('[data-singularite-chip]');
      if (chip) {
        chip.classList.remove('sing-burst');
        void chip.offsetWidth;
        chip.classList.add('sing-burst');
        setTimeout(() => chip.classList.remove('sing-burst'), 2500);
      }
    });
  }

  notifSnap[me] = { tick, chantiers, research, incoming, stockFull, reports: reportKeys, singularite: singCur };
  refreshNotifUI();
}

function notifTimeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `il y a ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h}h`;
  return `il y a ${Math.floor(h / 24)}j`;
}

function refreshNotifUI() {
  const bell = document.getElementById('bellBtn');
  const dot = document.getElementById('bellDot');
  if (bell && dot) {
    const n = notif.unread();
    if (n === 0) { bell.classList.add('silent'); dot.textContent = '0'; }
    else { bell.classList.remove('silent'); dot.textContent = n > 99 ? '99+' : String(n); }
  }
  const list = document.getElementById('notifList');
  if (list) {
    if (!notif.list.length) {
      list.innerHTML = `<div class="empty">aucune alerte</div>`;
    } else {
      list.innerHTML = notif.list.map(n => `
        <div class="notif-item ${n.read ? '' : 'unread'} ${n.severity || ''}">
          <div class="nti">${escapeHtml(n.title)}</div>
          <div class="nbo">${n.body}</div>
          <div class="nts">${notifTimeAgo(n.ts)}</div>
        </div>`).join('');
    }
  }
  const ps = document.getElementById('notifPushState');
  if (ps) {
    const pushLabels = {
      granted: 'push activé',
      denied: 'push refusé par le navigateur',
      default: 'push désactivé',
      unsupported: 'push indisponible',
    };
    ps.textContent = pushLabels[notif.pushPerm] || notif.pushPerm;
  }
  const pb = document.getElementById('notifPushBtn');
  if (pb) pb.style.display = (notif.pushPerm === 'default') ? '' : 'none';
}

(function setupNotifPanel() {
  const bell = document.getElementById('bellBtn');
  const panel = document.getElementById('notifPanel');
  const clearBtn = document.getElementById('notifClearBtn');
  const pushBtn = document.getElementById('notifPushBtn');
  if (!bell || !panel) return;

  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !panel.classList.contains('on');
    panel.classList.toggle('on');
    if (opening) {
      refreshNotifUI();
      setTimeout(() => notif.markAllRead(), 1200);
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('on')) return;
    if (e.target.closest('#notifPanel') || e.target.closest('#bellBtn')) return;
    panel.classList.remove('on');
  });
  if (clearBtn) clearBtn.addEventListener('click', () => notif.clearAll());
  if (pushBtn) pushBtn.addEventListener('click', () => notif.requestPush());

  setInterval(() => {
    if (panel.classList.contains('on')) refreshNotifUI();
  }, 30000);
})();

notif.load();
refreshNotifUI();

/* ───────────────────────────── Onboarding ───────────────────────────────── */
const OB_STEPS = [
  {
    title: 'Bienvenue dans CITADEL',
    body: `<p>Tu joues sur <b>Mutinynet</b>, un testnet Bitcoin. Tout l'état du jeu vit on-chain : tes empires, tes ordres, tes batailles.</p>
<p>Aucun serveur ne détient la vérité — ton navigateur scanne la blockchain et reconstruit l'état localement. Personne ne peut tricher sans qu'on le voie.</p>`,
  },
  {
    title: 'Un cycle de 30 blocs Bitcoin = un tick',
    body: `<p>Mutinynet produit un nouveau bloc toutes les <b>~30 secondes</b>. Le moteur regroupe <b>30 blocs en un tick</b> (≈ 15 minutes) — assez de temps pour réfléchir, planifier et signer plusieurs ordres avant la résolution.</p>
<p>Les ordres que tu inscris pendant le tick <code>T</code> sont appliqués au tick <code>T+1</code>. La console se rafraîchit automatiquement à chaque nouveau bloc.</p>`,
  },
  {
    title: 'Lire ta map',
    body: `<p>Le panneau central montre tes <b>planètes</b>, tes <b>ressources</b> et tes <b>flottes</b>. Le rail de droite affiche les chantiers, recherches et productions en cours.</p>
<p>La cloche en haut à droite (<b>🔔</b>) clignote dès qu'une alerte survient : flotte hostile entrante, chantier terminé, stockage saturé.</p>`,
  },
  {
    title: 'Soumettre un ordre',
    body: `<p>Choisis un bâtiment à construire, une recherche à lancer ou une flotte à envoyer. Clique <b>Inscrire</b> : la console signe une transaction Taproot avec ton wallet et la broadcaste sur Mutinynet.</p>
<p>Coût : quelques sats du faucet. Confirmation : 1-2 blocs. Une fois confirmé, ton ordre est appliqué au prochain tour.</p>`,
  },
];

const onboarding = {
  step: 0,
  storageKey: 'aetheris.onboardingDone',
  isDone() { try { return localStorage.getItem(this.storageKey) === '1'; } catch { return false; } },
  markDone() { try { localStorage.setItem(this.storageKey, '1'); } catch {} },
  show() {
    this.step = 0;
    this.render();
    const el = document.getElementById('obBgLegacy');
    if (el) { el.hidden = false; el.classList.add('on'); }
  },
  hide() {
    const el = document.getElementById('obBgLegacy');
    if (el) { el.classList.remove('on'); el.hidden = true; }
    this.markDone();
  },
  render() {
    const s = OB_STEPS[this.step];
    document.getElementById('obStepNum').textContent = `étape ${this.step + 1} / ${OB_STEPS.length}`;
    document.getElementById('obTitle').textContent = s.title;
    document.getElementById('obBody').innerHTML = s.body;
    document.getElementById('obDots').innerHTML = OB_STEPS
      .map((_, i) => `<span class="${i === this.step ? 'on' : ''}"></span>`).join('');
    const prev = document.getElementById('obPrev');
    const next = document.getElementById('obNext');
    prev.style.visibility = this.step === 0 ? 'hidden' : '';
    next.textContent = this.step === OB_STEPS.length - 1 ? 'Terminer' : 'Suivant';
  },
  next() {
    if (this.step < OB_STEPS.length - 1) { this.step++; this.render(); }
    else this.hide();
  },
  prev() { if (this.step > 0) { this.step--; this.render(); } },
};

(function setupOnboarding() {
  const bg = document.getElementById('obBgLegacy');
  if (!bg) return;
  document.getElementById('obNext').addEventListener('click', () => onboarding.next());
  document.getElementById('obPrev').addEventListener('click', () => onboarding.prev());
  document.getElementById('obSkip').addEventListener('click', () => onboarding.hide());
  bg.addEventListener('click', (e) => { if (e.target === bg) onboarding.hide(); });
  document.addEventListener('keydown', (e) => {
    if (!bg.classList.contains('on')) return;
    if (e.key === 'Escape') onboarding.hide();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') onboarding.next();
    else if (e.key === 'ArrowLeft') onboarding.prev();
  });
})();

/* boot — le tour onboarding moderne (5 étapes) prend le relais via maybeAdvanceOnboarding(). */
load();
tickCountdown();

// Si un wallet chiffré est stocké, demande le password au boot (1 fois)
// pour qu'il soit dispo pour les soumissions suivantes sans friction.
(async () => {
  if (state.wallet) return; // déjà chargé (cas legacy clair)
  const blob = readWalletBlob();
  if (!blob?.encrypted) return; // pas de wallet ou clair → rien à faire
  try {
    const w = await loadBitcoinWalletAsync();
    if (w?.privateKeyWIF) {
      state.wallet = w;
      toast('Wallet déverrouillé', `${w.taprootAddress.slice(0,16)}…`);
      render();
    }
  } catch (e) {
    // L'user a annulé ou mauvais password — sera redemandé au prochain submit.
    console.warn('[wallet]', e.message);
  }
})();

/* ───────────────────────────── Messagerie (NIP-17) ──────────────────────── */
// Pont : nostr-dm + nostr-pool + roster Bitcoin + AES local + UI panneau.
// Démarre après que le boot a peuplé state.identites et que le wallet est
// déverrouillé (nécessaire pour la privkey Schnorr).

const messagerieState = {
  instance: null,
  selectedPeer: null,
  status: '',
  err: null,
};

function pubkeyByPlayer(name) {
  const id = state.identites?.[name];
  if (!id?.cle_publique) return null;
  const pk = id.cle_publique;
  return pk.startsWith('schnorr:') ? pk.slice(8) : null;
}

function playerByPubkey(pk) {
  for (const [name, id] of Object.entries(state.identites || {})) {
    const cur = id?.cle_publique;
    if (cur === 'schnorr:' + pk) return name;
  }
  return null;
}

function buildRoster() {
  const set = new Set();
  for (const id of Object.values(state.identites || {})) {
    const pk = id?.cle_publique;
    if (typeof pk === 'string' && pk.startsWith('schnorr:')) set.add(pk.slice(8));
  }
  return set;
}

async function startMessagerieIfNeeded() {
  if (messagerieState.instance) return messagerieState.instance;
  if (!state.identites || !state.current) return null;

  let wallet;
  try { wallet = await getBitcoinWallet(); }
  catch { return null; } // wallet pas dispo — l'user retentera

  const ab = window.aetherisBitcoin;
  if (!ab?.ready) return null;

  const myPk = pubkeyByPlayer(state.current);
  if (!myPk) {
    messagerieState.err = 'Identité Schnorr introuvable pour ce joueur';
    renderMsgView();
    return null;
  }

  let messagerieMod, privFromWallet;
  try {
    // Chemin résolu relativement à app.js (qui vit sous /client/), donc on
    // remonte d'un cran pour atteindre /engine/.
    const mod = await import('../engine/messagerie.mjs');
    messagerieMod = mod;
    privFromWallet = mod.privFromWallet;
  } catch (e) {
    messagerieState.err = 'Module messagerie non chargé : ' + e.message;
    renderMsgView();
    return null;
  }

  let myPrivHex;
  try { myPrivHex = privFromWallet(wallet, { btc: ab.btc }); }
  catch (e) {
    messagerieState.err = 'Impossible de dériver la clé : ' + e.message;
    renderMsgView();
    return null;
  }

  // Vérifie que la privkey correspond bien à la pubkey du joueur courant.
  const derivedPub = ab.schnorr.getPublicKey(Uint8Array.from(myPrivHex.match(/.{2}/g).map(h => parseInt(h, 16))));
  const derivedPubHex = Array.from(derivedPub).map(b => b.toString(16).padStart(2, '0')).join('');
  if (derivedPubHex !== myPk) {
    messagerieState.err = 'Le wallet ne correspond pas à l\'identité de ' + state.current;
    renderMsgView();
    return null;
  }

  // AES helpers — réutilise la même clé que celle du wallet.
  const password = state.walletPassword;
  const aesEncrypt = password ? async (str) => {
    const blob = await encryptWallet({ payload: str }, password);
    return JSON.stringify(blob);
  } : null;
  const aesDecrypt = password ? async (str) => {
    const blob = JSON.parse(str);
    const w = await decryptWallet(blob, password);
    return w.payload;
  } : null;

  const inst = messagerieMod.createMessagerie({
    myPrivHex,
    roster: buildRoster(),
    resolveName: (pk) => playerByPubkey(pk) || (pk.slice(0, 8) + '…'),
    aesEncrypt, aesDecrypt,
    onUpdate: () => { renderMsgView(); refreshMsgCount(); },
    onIncoming: (msg) => {
      const fromName = playerByPubkey(msg.from) || msg.from.slice(0, 10) + '…';
      try {
        notif.add({
          type: 'dm',
          key: 'dm:' + msg.from + ':' + msg.ts,
          title: 'Message de ' + fromName,
          body: String(msg.content).slice(0, 80),
          severity: 'med',
        });
      } catch {}
      try { refreshNotifUI?.(); } catch {}
    },
  });

  messagerieState.instance = inst;
  messagerieState.err = null;
  await inst.start();
  messagerieState.status = 'connecté · ' + inst.myPubkey.slice(0, 12) + '…';
  renderMsgView();
  refreshMsgCount();
  return inst;
}

function refreshMsgCount() {
  const ct = document.getElementById('ctMsg');
  if (!ct) return;
  const inst = messagerieState.instance;
  if (!inst) { ct.textContent = '—'; return; }
  const total = inst.getThreads().reduce((a, t) => a + t.unreadOut, 0);
  ct.textContent = total > 0 ? String(total) : '—';
}

function renderMsgView() {
  const root = document.getElementById('vMsg');
  if (!root) return;
  if (messagerieState.err) {
    root.innerHTML = `<div class="msg-status err">⚠ ${escapeHtml(messagerieState.err)}</div>`;
    return;
  }
  const inst = messagerieState.instance;
  if (!inst) {
    root.innerHTML = `
      <div class="msg-status">Messagerie non démarrée — déverrouille ton wallet.</div>
      <div style="padding:14px"><button class="ic" id="msgStartBtn">Démarrer la messagerie</button></div>
    `;
    document.getElementById('msgStartBtn')?.addEventListener('click', () => startMessagerieIfNeeded());
    return;
  }

  const threads = inst.getThreads();
  const roster = buildRoster();
  const myPk = inst.myPubkey;
  // Liste des peers possibles à contacter (roster moins moi).
  const others = [...roster].filter(pk => pk !== myPk);
  const selected = messagerieState.selectedPeer && roster.has(messagerieState.selectedPeer)
    ? messagerieState.selectedPeer
    : (threads[0]?.peer ?? null);

  const newThreadOptions = others
    .map(pk => `<option value="${pk}">${escapeHtml(playerByPubkey(pk) || pk.slice(0, 12) + '…')}</option>`)
    .join('');

  const threadsHtml = threads.length === 0
    ? '<div class="empty">aucun thread — démarre une conversation</div>'
    : threads.map(t => `
        <div class="thread${t.peer === selected ? ' on' : ''}" data-peer="${t.peer}">
          ${t.unreadOut > 0 ? `<span class="ub">${t.unreadOut}</span>` : ''}
          <div class="nm">${escapeHtml(t.name)}</div>
          <div class="pk">${t.peer.slice(0, 24)}…</div>
        </div>
      `).join('');

  let paneHtml;
  if (!selected) {
    paneHtml = `
      <div class="head"><div class="nm">— sélectionne ou démarre un thread —</div></div>
      <div class="feed"><div class="empty">aucun thread sélectionné</div></div>
    `;
  } else {
    const thread = threads.find(t => t.peer === selected);
    const peerName = playerByPubkey(selected) || selected.slice(0, 12) + '…';
    const msgs = thread?.messages ?? [];
    const feedHtml = msgs.length === 0
      ? '<div class="empty">aucun message — écris le premier ↓</div>'
      : msgs.map(m => `
          <div class="msg-bub ${m.direction}">
            ${escapeHtml(m.content)}
            <span class="ts">${new Date(m.ts * 1000).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}</span>
          </div>
        `).join('');
    paneHtml = `
      <div class="head">
        <div class="nm">${escapeHtml(peerName)}</div>
        <div class="pk">${selected.slice(0, 32)}…</div>
      </div>
      <div class="feed" id="msgFeed">${feedHtml}</div>
      <div class="compose">
        <textarea id="msgInput" placeholder="message…" maxlength="2000"></textarea>
        <button id="msgSend">Envoyer</button>
      </div>
    `;
  }

  root.innerHTML = `
    <div class="msg-wrap">
      <div class="msg-list">
        ${others.length > 0 ? `
          <div class="new-thread">
            <select id="msgPeerSelect">
              <option value="">— nouveau thread —</option>
              ${newThreadOptions}
            </select>
          </div>
        ` : `
          <div class="empty" style="padding:14px;line-height:1.5">
            Aucun autre joueur dans le roster.<br>
            Invite quelqu'un à rejoindre via <code>join-bitcoin.html</code> — il apparaîtra ici dès que sa TX <code>join</code> sera confirmée et scannée.
          </div>
        `}
        ${threadsHtml}
      </div>
      <div class="msg-pane">${paneHtml}</div>
    </div>
    <div class="msg-status">${escapeHtml(messagerieState.status || '')}</div>
  `;

  // Bind events
  root.querySelectorAll('.thread[data-peer]').forEach(el => {
    el.addEventListener('click', () => {
      messagerieState.selectedPeer = el.dataset.peer;
      inst.markThreadRead(el.dataset.peer);
      renderMsgView();
      refreshMsgCount();
    });
  });
  document.getElementById('msgPeerSelect')?.addEventListener('change', e => {
    if (e.target.value) {
      messagerieState.selectedPeer = e.target.value;
      renderMsgView();
    }
  });
  const sendBtn = document.getElementById('msgSend');
  const input = document.getElementById('msgInput');
  if (sendBtn && input) {
    const doSend = async () => {
      const text = input.value.trim();
      if (!text || !selected) return;
      sendBtn.disabled = true;
      try {
        await inst.send(selected, text);
        input.value = '';
      } catch (e) {
        toast('Envoi échoué', e.message, true);
      } finally {
        sendBtn.disabled = false;
      }
    };
    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); }
    });
    // auto-scroll feed
    const feed = document.getElementById('msgFeed');
    if (feed) feed.scrollTop = feed.scrollHeight;
  }
}

// Démarre la messagerie dès que state.identites est peuplé et le wallet
// déverrouillé. Polling léger toutes les 5s, s'arrête une fois démarré.
const _msgBootInterval = setInterval(() => {
  if (messagerieState.instance) { clearInterval(_msgBootInterval); return; }
  if (!state.identites || Object.keys(state.identites).length === 0) return;
  if (!state.wallet?.privateKeyWIF) return;
  startMessagerieIfNeeded().then(inst => {
    if (inst) clearInterval(_msgBootInterval);
  }).catch(e => console.warn('[messagerie]', e.message));
}, 5000);

// Quand l'utilisateur clique sur l'onglet messagerie, render à la volée.
document.getElementById('nav')?.addEventListener('click', e => {
  const btn = e.target.closest('button[data-view="messagerie"]');
  if (btn) { renderMsgView(); refreshMsgCount(); }
});

// Auto-refresh : poll uniquement le tip toutes les 15s. Si le tip a changé,
// reload (boot incrémental — scan juste les nouveaux blocs depuis le cache).
async function pollNewBlocks() {
  const ab = window.aetherisBitcoin;
  if (!ab?.ready || !state.bitcoin?.tip) return;
  try {
    const newTip = await ab.fetchTipHeight('https://mutinynet.com/api');
    if (newTip > state.bitcoin.tip) {
      // Le countdown reset au nouveau bloc.
      console.log(`[poll] tip ${state.bitcoin.tip} → ${newTip}, reload`);
      await load();
    }
  } catch (e) {
    console.warn('[poll]', e.message);
  }
}
setInterval(pollNewBlocks, 15000);

/* ─── Decode inscription ─────────────────────────────────── */
{
  const DEC_APIS = {
    mutinynet: 'https://mutinynet.com/api',
    signet:    'https://mempool.space/signet/api',
    testnet:   'https://mempool.space/testnet/api',
    mainnet:   'https://mempool.space/api',
  };
  const DEC_EXPLORERS = {
    mutinynet: 'https://mutinynet.com/tx/',
    signet:    'https://mempool.space/signet/tx/',
    testnet:   'https://mempool.space/testnet/tx/',
    mainnet:   'https://mempool.space/tx/',
  };

  async function decGunzip(bytes) {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter(); w.write(bytes); w.close();
    const chunks = []; const r = ds.readable.getReader();
    for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
    return new TextDecoder().decode(out);
  }

  function decHex(hex) {
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return b;
  }

  function decExtract(asm) {
    const m = asm.match(/OP_0 OP_IF\s+([\s\S]+?)\s+OP_ENDIF/);
    if (!m) return null;
    const body = m[1];
    const tagM = body.match(/^OP_PUSHBYTES_4 ([0-9a-f]{8})/);
    const tag  = tagM ? new TextDecoder().decode(decHex(tagM[1])) : null;
    const datM = body.match(/OP_PUSHDATA\d+ ([0-9a-f]+)$/) ?? body.match(/OP_PUSHBYTES_\d+ ([0-9a-f]+)$/);
    if (!datM) return null;
    return { tag, hex: datM[1] };
  }

  function decEsc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function decColorYaml(text) {
    return text.split('\n').map(line => {
      if (line.trimStart().startsWith('#')) return `<span class="y-comment">${decEsc(line)}</span>`;
      const kv = line.match(/^(\s*)([\w_.-]+)(\s*:\s*)(.*)$/);
      if (!kv) return decEsc(line);
      const [, indent, key, sep, val] = kv;
      let vHtml;
      if (val === '') vHtml = '';
      else if (/^-?\d[\d.]*$/.test(val)) vHtml = `<span class="y-num">${decEsc(val)}</span>`;
      else if (val === 'true' || val === 'false') vHtml = `<span class="y-bool">${decEsc(val)}</span>`;
      else vHtml = `<span class="y-val">${decEsc(val)}</span>`;
      return `${decEsc(indent)}<span class="y-key">${decEsc(key)}</span>${decEsc(sep)}${vHtml}`;
    }).join('\n');
  }

  const decBtn  = document.getElementById('decBtn');
  const decCard = document.getElementById('decCard');
  const decErr  = document.getElementById('decErr');
  const decMeta = document.getElementById('decMeta');
  const decOut  = document.getElementById('decOut');
  const decLink = document.getElementById('decLink');

  if (decBtn) {
    decBtn.addEventListener('click', async () => {
      const txid = document.getElementById('decTxid').value.trim();
      const net  = document.getElementById('decNet').value;
      if (!txid) { decErr.textContent = 'Entre un TXID.'; decErr.classList.add('on'); return; }
      decErr.classList.remove('on');
      decCard.classList.remove('on');
      decBtn.disabled = true;
      decBtn.innerHTML = '<span class="dec-spinner"></span>Récupération…';
      try {
        const res = await fetch(`${DEC_APIS[net]}/tx/${txid}`);
        if (!res.ok) throw new Error(`API ${res.status} — transaction introuvable sur ${net}`);
        const tx = await res.json();
        let found = null;
        for (const inp of tx.vin) {
          if (!inp.inner_witnessscript_asm) continue;
          found = decExtract(inp.inner_witnessscript_asm);
          if (found) break;
        }
        if (!found) throw new Error('Aucune inscription Tapscript (OP_0 OP_IF envelope) dans cette transaction.');
        const { tag, hex } = found;
        const bytes  = decHex(hex);
        const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
        const content = isGzip ? await decGunzip(bytes) : new TextDecoder().decode(bytes);
        decMeta.innerHTML = [
          ['tag',     tag ?? '(inconnu)', 'tag'],
          ['format',  isGzip ? 'gzip → UTF-8' : 'raw', ''],
          ['bytes',   bytes.length + ' octets', ''],
          ['bloc',    tx.status?.block_height ?? 'non confirmé', ''],
        ].map(([k, v, cls]) =>
          `<span class="dec-mk">${decEsc(k)}</span><span class="dec-mv${cls ? ' '+cls : ''}">${decEsc(String(v))}</span>`
        ).join('');
        decOut.innerHTML = decColorYaml(content);
        decLink.href = DEC_EXPLORERS[net] + txid;
        decLink.textContent = `Voir sur l'explorer (${net}) →`;
        decCard.classList.add('on');
      } catch (e) {
        decErr.textContent = e.message;
        decErr.classList.add('on');
      } finally {
        decBtn.disabled = false;
        decBtn.textContent = 'Décoder';
      }
    });
  }
}
