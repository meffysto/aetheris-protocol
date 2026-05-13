#!/usr/bin/env node
// Inscrit un joueur sur Bitcoin comme inscription op_type=join (0x01).
// Lit le fichier identite.yaml du joueur et l'inscrit sur la chaîne.
//
// Usage:
//   node engine/inscribe-join.mjs --player <nom> [--network mutinynet]

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const playerArg = args[args.indexOf('--player') + 1];
const keyIdx = args.indexOf('--key');
const keyArg = keyIdx >= 0 ? args[keyIdx + 1] : null;

if (!playerArg) {
  console.error('Usage: node engine/inscribe-join.mjs --player <nom> [--key <path>] [--network mutinynet]');
  process.exit(1);
}

async function main() {
  const idPath = path.join(ROOT, 'joueurs', playerArg, 'identite.yaml');
  const empPath = path.join(ROOT, 'joueurs', playerArg, 'empire.yaml');

  // Vérifie que le joueur existe
  try {
    await fs.access(idPath);
  } catch {
    console.error(`Joueur ${playerArg} introuvable : ${idPath}`);
    process.exit(1);
  }

  const identiteText = await fs.readFile(idPath, 'utf8');
  // En mode Bitcoin-native, la pubkey Schnorr du witness authentifie l'inscripteur.
  // Plus besoin d'embarquer cle_publique/signature dans le YAML.
  const allMatch = identiteText.match(/^alliance:\s*(\S+)/m);

  const joinYaml = [
    '# Citadel Protocol — Join inscription',
    'version: 1',
    'type: join',
    `joueur: ${playerArg}`,
    `alliance: ${allMatch ? allMatch[1] : '~'}`,
    `date_inscription: ${new Date().toISOString()}`,
  ].join('\n');

  // Écrit dans un fichier temporaire pour le passer à inscribe.mjs
  const tmpPath = path.join(ROOT, `.cache/.join-${playerArg}-tmp.yaml`);
  await fs.mkdir(path.join(ROOT, '.cache'), { recursive: true });
  await fs.writeFile(tmpPath, joinYaml, 'utf8');

  console.log(`Inscription join pour ${playerArg}...`);
  console.log('YAML à inscrire :');
  console.log(joinYaml);
  console.log('');

  // Lance inscribe.mjs
  const inscribeArgs = [path.join(ROOT, 'engine/inscribe.mjs')];
  if (keyArg) inscribeArgs.push('--key', keyArg);
  inscribeArgs.push(tmpPath);
  const result = spawnSync('node', inscribeArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });

  // Nettoie le fichier temporaire
  await fs.unlink(tmpPath).catch(() => {});

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
