#!/usr/bin/env node
// CITADEL // PROTOCOL — Onboarding
// Génère une paire de clés Ed25519, scaffolde le dossier joueur.
//
// Usage :
//   node engine/join.mjs --name kael
//   node engine/join.mjs --name kael --alliance aura
//   node engine/join.mjs --name kael --regenerate    # reset des clés (garde le reste)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      args[k] = v;
    }
  }
  return args;
}

const args = parseArgs();
const name = args.name;
const alliance = typeof args.alliance === 'string' ? args.alliance : null;
const regenerate = !!args.regenerate;

if (!name || typeof name !== 'string' || !/^[a-z][a-z0-9-]{1,15}$/.test(name)) {
  console.error('Usage: join.mjs --name <name> [--alliance <tag>] [--regenerate]');
  console.error('  Le nom doit faire 2-16 chars [a-z0-9-], commencer par une lettre.');
  process.exit(2);
}

const ROOT = process.cwd();
const dir = path.join(ROOT, 'joueurs', name);
const keyPath = path.join(dir, '.key.pem');
const idPath = path.join(dir, 'identite.yaml');

const dirExists = fs.existsSync(dir);
if (dirExists && !regenerate) {
  console.error(`✗ Le joueur "${name}" existe déjà. Utilise --regenerate pour reset les clés.`);
  process.exit(1);
}

// 1. Génération Ed25519
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubSpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

// 2. Écriture
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(keyPath, privPem);
fs.chmodSync(keyPath, 0o600);

// Préserver alliance/date d'inscription si on regenerate
let dateInscription = new Date().toISOString();
let allianceFinale = alliance;
if (regenerate && fs.existsSync(idPath)) {
  const old = fs.readFileSync(idPath, 'utf8');
  const m1 = old.match(/^date_inscription(?:_iso)?:\s*(.+)$/m);
  if (m1) dateInscription = m1[1].trim();
  const m2 = old.match(/^alliance:\s*(.+)$/m);
  if (m2 && allianceFinale === null) allianceFinale = m2[1].trim();
}

const identiteYaml = `version: 1
nom: ${name}
cle_publique: ed25519:${pubSpki}
date_inscription: ${dateInscription}
alliance: ${allianceFinale || '~'}
`;
fs.writeFileSync(idPath, identiteYaml);

// 3. Empire de départ (uniquement nouveau joueur)
if (!regenerate) {
  // Lire le manifest et la galaxie pour trouver une planète libre
  const galaxiePath = path.join(ROOT, 'world/galaxie.yaml');
  const manifestPath = path.join(ROOT, 'world/manifest.yaml');
  if (!fs.existsSync(galaxiePath) || !fs.existsSync(manifestPath)) {
    console.error('✗ world/galaxie.yaml ou world/manifest.yaml manquant. Lance d\'abord world-init.mjs.');
    process.exit(1);
  }
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const galaxie = fs.readFileSync(galaxiePath, 'utf8');
  const tickMatch = manifest.match(/^tick:\s*(\d+)/m);
  const tick = tickMatch ? parseInt(tickMatch[1], 10) : 0;

  // Cherche une planète libre tellurique (idéale pour un démarrage)
  // Format : `      8: { type: planete, proprietaire: null, classe: tellurique }`
  const planeteRegex = /^(\s+)(\d+):\s*\{\s*type:\s*planete,\s*proprietaire:\s*null,\s*classe:\s*tellurique\s*\}/m;
  const planeteAny = /^(\s+)(\d+):\s*\{\s*type:\s*planete,\s*proprietaire:\s*null,\s*classe:\s*(\w+)\s*\}/m;
  const sysRegex = /^\s+"(\d+):(\d+)":/gm;

  let chosen = null;
  const lines = galaxie.split('\n');
  let currentSys = null;
  for (let i = 0; i < lines.length; i++) {
    const sm = lines[i].match(/^\s+"(\d+):(\d+)":/);
    if (sm) { currentSys = [parseInt(sm[1]), parseInt(sm[2])]; continue; }
    const pm = lines[i].match(/^\s+(\d+):\s*\{\s*type:\s*planete,\s*proprietaire:\s*null,\s*classe:\s*(\w+)\s*\}/);
    if (pm && currentSys) {
      const pos = parseInt(pm[1]);
      const classe = pm[2];
      // priorité tellurique
      if (classe === 'tellurique') {
        chosen = { coords: [...currentSys, pos], classe, lineIdx: i };
        break;
      }
      if (!chosen) chosen = { coords: [...currentSys, pos], classe, lineIdx: i };
    }
  }

  if (!chosen) {
    console.error('✗ Aucune planète libre dans la galaxie. Lance world-init.mjs avec plus de --systemes.');
    process.exit(1);
  }

  // Réserver la planète dans galaxie.yaml
  const planetName = `${name}-prima`;
  const newLine = lines[chosen.lineIdx].replace(
    /\{\s*type:\s*planete,\s*proprietaire:\s*null,\s*classe:\s*(\w+)\s*\}/,
    `{ type: planete, proprietaire: ${name}, nom: ${planetName}, classe: $1 }`
  );
  lines[chosen.lineIdx] = newLine;
  fs.writeFileSync(galaxiePath, lines.join('\n'));

  // Champs (taille du chantier de la planète) - random selon le type
  const champsTotal = chosen.classe === 'tellurique' ? (200 + Math.floor(Math.random() * 80))
                    : chosen.classe === 'cristalline' ? (130 + Math.floor(Math.random() * 90))
                    : (100 + Math.floor(Math.random() * 100));

  const empPath = path.join(dir, 'empire.yaml');
  const mdPath = path.join(dir, 'empire.md');
  const starterEmp = `# Généré à l'inscription par engine/join.mjs.
version: 1
joueur: ${name}
tick: ${tick}
score_total: 0
points_militaires: 0
rang: 999
alliance: ${allianceFinale || '~'}
planetes:
  - nom: ${planetName}
    coordonnees: [${chosen.coords.join(', ')}]
    type: ${chosen.classe}
    champs:
      utilises: 0
      total: ${champsTotal}
    ressources:
      ferrum:
        stock: 500
        production_par_utj: 30
        capacite: 100000
      lumen:
        stock: 500
        production_par_utj: 20
        capacite: 100000
      plasmide:
        stock: 0
        production_par_utj: 0
        capacite: 100000
    energie:
      production: 0
      consommation: 0
    batiments:
      mine_ferrum: 0
      extracteur_lumen: 0
      synthetiseur_plasmide: 0
      centrale_solaire: 0
      depot: 0
      usine_robotique: 0
      chantier_spatial: 0
      laboratoire: 0
    file_chantier: []
    file_construction: []
    flotte_au_sol: {}
    defenses: {}
flottes_en_vol: []
recherche: {}
file_recherche: []
`;
  fs.writeFileSync(empPath, starterEmp);
  fs.writeFileSync(mdPath, `# Empire de ${name}\n\n> Tick ${tick} · planète **${planetName}** (${chosen.coords.join(':')}) · *${chosen.classe}*\n\nFresh start. Édite \`ordres.yaml\` pour donner ton premier ordre.\n`);

  // Squelette d'ordres.yaml
  fs.writeFileSync(path.join(dir, 'ordres.yaml'), `# Premier ordre — exemple : upgrade ta mine de ferrum.
# Dé-commente les lignes ci-dessous et signe : node engine/sign.mjs joueurs/${name}/ordres.yaml

version: 1
joueur: ${name}
tick_cible: ${tick + 1}
nonce: ${crypto.randomBytes(3).toString('hex')}

ordres: []
#  - type: chantier
#    planete: ${planetName}
#    batiment: mine_ferrum
#    niveau_cible: 1
`);

  console.log(`  planète : ${planetName} en ${chosen.coords.join(':')} (${chosen.classe})`);
}

// 4. .gitignore pour les clés privées
const giPath = path.join(ROOT, 'joueurs', '.gitignore');
const giLine = '*/.key.pem\n';
if (!fs.existsSync(giPath)) {
  fs.writeFileSync(giPath, giLine);
} else {
  const cur = fs.readFileSync(giPath, 'utf8');
  if (!cur.includes('.key.pem')) fs.appendFileSync(giPath, giLine);
}

console.log(`✓ ${regenerate ? 'Clés régénérées' : 'Joueur créé'} : ${name}`);
console.log(`  pubkey  : ed25519:${pubSpki.slice(0, 28)}…`);
console.log(`  privkey : ${path.relative(ROOT, keyPath)}  (gitignored, mode 600)`);
if (!regenerate) {
  console.log(`  → édite joueurs/${name}/ordres.yaml puis : node engine/sign.mjs joueurs/${name}/ordres.yaml`);
}
