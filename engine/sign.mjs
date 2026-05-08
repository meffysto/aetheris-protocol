#!/usr/bin/env node
// CITADEL // PROTOCOL — Signature d'un fichier d'ordres
//
// Usage : node engine/sign.mjs joueurs/<name>/ordres.yaml
//
// Calcule la signature Ed25519 sur le contenu canonique du fichier
// (= contenu sans la ligne `signature:`), puis remplace ou ajoute la
// signature à la fin du fichier.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const target = process.argv[2];
if (!target) {
  console.error('Usage: sign.mjs <path/to/orders.yaml>');
  process.exit(2);
}

const fullPath = path.resolve(target);
if (!fs.existsSync(fullPath)) {
  console.error(`✗ Fichier introuvable : ${fullPath}`);
  process.exit(1);
}

// Trouver le dossier joueur (joueurs/<name>/...)
const segs = fullPath.split(path.sep);
const idx = segs.lastIndexOf('joueurs');
if (idx < 0 || !segs[idx + 1]) {
  console.error('✗ Le fichier doit être dans joueurs/<name>/');
  process.exit(1);
}
const playerName = segs[idx + 1];
const playerDir = segs.slice(0, idx + 2).join(path.sep);
const keyPath = path.join(playerDir, '.key.pem');

if (!fs.existsSync(keyPath)) {
  console.error(`✗ Clé privée introuvable : ${path.relative(process.cwd(), keyPath)}`);
  console.error(`  Lance d'abord : node engine/join.mjs --name ${playerName}`);
  process.exit(1);
}

const privKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
const content = fs.readFileSync(fullPath, 'utf8');

// Corps : on retire l'ancienne signature ET l'éventuelle bannière en tête,
// puis on reconstruit une bannière "Décret Impérial" fraîche. La bannière
// fait partie du canonique signé, donc le sceau atteste aussi du registre.
const body = stripBanner(stripSignature(content)).replace(/^\n+/, '');
const tickMatch = body.match(/^tick_cible:\s*(\d+)/m);
const cycle = tickMatch ? tickMatch[1] : '?';
const banner = makeBanner(playerName, cycle);

const canonical = (banner + body).trimEnd() + '\n';
const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privKey).toString('base64');

const newContent = canonical + `signature: ed25519:${sig}\n`;
fs.writeFileSync(fullPath, newContent);

console.log(`✦ Décret impérial de ${playerName} scellé pour le cycle ${cycle}`);
console.log(`  ${path.relative(process.cwd(), fullPath)}`);
console.log(`  sceau: ed25519:${sig.slice(0, 32)}…`);

function makeBanner(name, cycle) {
  const date = new Date().toISOString().slice(0, 10);
  const empire = name.charAt(0).toUpperCase() + name.slice(1);
  return [
    '# ═══════════════════════════════════════════════════════════',
    `#  DÉCRET IMPÉRIAL · Empire de ${empire}`,
    `#  Cycle ${cycle} · scellé le ${date}`,
    '#  Toute modification post-scellement invalide le sceau.',
    '# ═══════════════════════════════════════════════════════════',
    '',
  ].join('\n');
}

function stripSignature(text) {
  // Retire toute ligne commençant par "signature:" (et les blancs en fin de fichier)
  return text
    .split('\n')
    .filter(l => !/^signature:\s*/.test(l))
    .join('\n');
}

function stripBanner(text) {
  // Retire le bloc de commentaires en tête (ligne par ligne tant que ça
  // commence par '#' ou que c'est une ligne vide intercalée).
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '')) i++;
  return lines.slice(i).join('\n');
}
