#!/usr/bin/env node
// CITADEL // PROTOCOL — Initialisation du monde
// Wipe complet + génération d'un monde tick 0 jouable.
//
// ATTENTION : supprime joueurs/, history/, world/events/. Confirmation requise.
//
// Usage :
//   node engine/world-init.mjs --confirm
//   node engine/world-init.mjs --confirm --serveur alpha-7 --systemes 1

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
const ROOT = path.resolve('.');
const NB_SYSTEMES = parseInt(args.systemes || 1, 10);
const SERVEUR = args.serveur || 'aetheris-1';

if (!args.confirm) {
  console.error('✗ Cette commande wipe joueurs/, history/, world/events/.');
  console.error('  Relance avec : node engine/world-init.mjs --confirm');
  process.exit(2);
}

console.log('━━━ CITADEL // world-init ━━━');
console.log(`serveur  = ${SERVEUR}`);
console.log(`systèmes = ${NB_SYSTEMES}`);

// 1. Wipe
function rmRecursive(p) {
  if (!fs.existsSync(p)) return;
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    for (const f of fs.readdirSync(p)) rmRecursive(path.join(p, f));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

const joueursDir = path.join(ROOT, 'joueurs');
if (fs.existsSync(joueursDir)) {
  for (const j of fs.readdirSync(joueursDir)) {
    if (j.startsWith('.')) continue;
    rmRecursive(path.join(joueursDir, j));
  }
}
rmRecursive(path.join(ROOT, 'world/events'));
rmRecursive(path.join(ROOT, 'history'));
console.log('▸ Wipe terminé');

// 2. Galaxie : NB_SYSTEMES systèmes en galaxie 1, positions 1..15
const types = ['tellurique', 'cristalline', 'volcanique', 'glacee', 'gazeuse'];
const seed = '0x' + crypto.randomBytes(8).toString('hex');
// PRNG xoshiro128** seeded
let s0, s1, s2, s3;
{
  const h = crypto.createHash('sha256').update(seed).digest();
  s0 = h.readUInt32LE(0); s1 = h.readUInt32LE(4);
  s2 = h.readUInt32LE(8); s3 = h.readUInt32LE(12);
}
function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
const rng = () => {
  const result = (rotl(Math.imul(s1, 5), 7) * 9) >>> 0;
  const t = (s1 << 9) >>> 0;
  s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
  s2 ^= t; s3 = rotl(s3, 11);
  return result / 0x100000000;
};

const systemes = {};
for (let s = 1; s <= NB_SYSTEMES; s++) {
  const lines = [];
  lines.push(`  "1:${s}":`);
  lines.push(`    etoile: { nom: stelara-${s}, type: G, temperature_k: ${5000 + Math.floor(rng() * 2000)} }`);
  lines.push(`    positions:`);
  for (let p = 1; p <= 15; p++) {
    if (rng() < 0.45) {
      const t = types[Math.floor(rng() * types.length)];
      lines.push(`      ${p}: { type: planete, proprietaire: null, classe: ${t} }`);
    } else {
      lines.push(`      ${p}: { type: asteroide }`);
    }
  }
  systemes[`1:${s}`] = lines.join('\n');
}

const galaxieYaml = `# CITADEL // galaxie canonique — generée par world-init.mjs
version: 1
tick: 0
systemes:
${Object.values(systemes).join('\n')}
`;
fs.writeFileSync(path.join(ROOT, 'world/galaxie.yaml'), galaxieYaml);
console.log(`▸ Galaxie : ${NB_SYSTEMES} système(s) générés (1:1 .. 1:${NB_SYSTEMES})`);

// 3. Manifest tick 0
const manifestYaml = `# CITADEL // manifest serveur — généré par world-init.mjs
version: 1
protocol_version: 0.1
serveur: ${SERVEUR}
tick: 0
seed: ${seed}
demarrage_iso: ${new Date().toISOString()}
duree_tick_min: 3   # Mutinynet 30s × 6 blocs/tick — cohérent avec genesis.yaml
parametres:
  galaxies: 1
  systemes_par_galaxie: ${NB_SYSTEMES}
  positions_par_systeme: 15
  planetes_max_par_joueur: 9
hash_etat: sha256:${'0'.repeat(32)}
`;
fs.writeFileSync(path.join(ROOT, 'world/manifest.yaml'), manifestYaml);
console.log(`▸ Manifest : tick 0, seed ${seed}`);

// 4. Recrée joueurs/.gitignore
fs.mkdirSync(joueursDir, { recursive: true });
fs.writeFileSync(path.join(joueursDir, '.gitignore'), '*/.key.pem\n');

// 5. Recrée world/events/ vide
fs.mkdirSync(path.join(ROOT, 'world/events'), { recursive: true });

console.log('\n✓ Monde initialisé.');
console.log(`  Prochaine étape : node engine/join.mjs --name <toi>`);
