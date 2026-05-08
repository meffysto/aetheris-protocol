// Helpers iso pour les tests Node — chargement fixtures, hash, deep clone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { yparse, canonicalJSON } from '../engine/tick-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export function readYaml(rel) {
  return yparse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

export function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Deep clone via JSON (suffisant — l'état du jeu est sérialisable).
export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function hashState(empires) {
  return sha256(canonicalJSON(empires));
}

// Charge les fixtures réelles (manifest, rules, galaxie, empires).
export function loadFixtures() {
  const manifest = readYaml('world/manifest.yaml');
  const rules = readYaml('engine/rules.yaml');
  const galaxie = readYaml('world/galaxie.yaml');

  const empires = {};
  const identites = {};
  const joueursDir = path.join(ROOT, 'joueurs');
  if (fs.existsSync(joueursDir)) {
    for (const name of fs.readdirSync(joueursDir)) {
      const empPath = path.join(joueursDir, name, 'empire.yaml');
      const idPath = path.join(joueursDir, name, 'identite.yaml');
      if (fs.existsSync(empPath)) empires[name] = yparse(fs.readFileSync(empPath, 'utf8'));
      if (fs.existsSync(idPath)) identites[name] = yparse(fs.readFileSync(idPath, 'utf8'));
    }
  }
  return { manifest, rules, galaxie, empires, identites };
}
