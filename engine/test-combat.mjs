#!/usr/bin/env node
// CITADEL // PROTOCOL — Test du résolveur de combat
// Simule la Bataille de Pyra II avec les flottes actuelles de KAEL et VEXOR.
//
// Usage : node engine/test-combat.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveCombat, computeDebris, computePillage } from './combat.mjs';

const ROOT = path.resolve('.');

function rd(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

// Mini-parseur YAML aligné sur celui de tick.mjs
function yparse(text) {
  const lines = text.split('\n')
    .filter(l => !/^\s*#/.test(l))
    .map(l => l.replace(/\s+#.*$/, ''));
  let i = 0;
  function readBlock(indent) {
    const out = {};
    let firstKey = true;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const ind = line.match(/^ */)[0].length;
      if (ind < indent) return out;
      if (ind > indent && firstKey) return readBlock(ind);
      const m = line.slice(ind).match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const [, k, rest] = m;
      i++;
      if (rest === '') {
        if (i < lines.length && /^\s*-\s/.test(lines[i])) out[k] = readList(ind + 2);
        else out[k] = readBlock(ind + 2);
      } else if (rest.startsWith('[') || rest.startsWith('{')) {
        out[k] = readInline(rest);
      } else {
        out[k] = parseScalar(rest);
      }
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
      const rest = line.slice(ind + 2);
      i++;
      if (rest.includes(':')) {
        const m = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
        const item = {};
        if (m[2] === '') item[m[1]] = readBlock(ind + 4);
        else item[m[1]] = parseScalar(m[2]);
        Object.assign(item, readBlock(ind + 2));
        out.push(item);
      } else {
        out.push(parseScalar(rest));
      }
    }
    return out;
  }
  function splitTopLevel(s, sep) {
    const out = []; let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === sep && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    const last = s.slice(start).trim();
    if (last) out.push(last);
    return out;
  }
  function readInline(s) {
    s = s.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      return splitTopLevel(inner, ',').map(t => parseScalar(t));
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return {};
      const out = {};
      for (const part of splitTopLevel(inner, ',')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
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

function rngFromSeed(seedStr) {
  const h = crypto.createHash('sha256').update(seedStr).digest();
  let s0 = h.readUInt32LE(0), s1 = h.readUInt32LE(4),
      s2 = h.readUInt32LE(8), s3 = h.readUInt32LE(12);
  function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
  return function rng() {
    const result = (rotl(Math.imul(s1, 5), 7) * 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t; s3 = rotl(s3, 11);
    return result / 0x100000000;
  };
}

const fmt = n => Math.round(n).toLocaleString('fr-FR');
const bar = (n, max, w = 30) => {
  const filled = max > 0 ? Math.round((n / max) * w) : 0;
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, w - filled));
};

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  CITADEL // BATAILLE DE PYRA II — simulation');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const rules = yparse(rd('engine/rules.yaml'));
const manifest = yparse(rd('world/manifest.yaml'));
const kael = yparse(rd('joueurs/kael/empire.yaml'));
const vexor = yparse(rd('joueurs/vexor/empire.yaml'));

// La flotte d'attaque scellée par KAEL (cf PROTOCOL.md §4.3)
const attaquantFlotte = {
  chasseur_leger: 4631,
  chasseur_lourd: 682,
  croiseur: 86,
  cuirasse: 46,
};

// Défense de Pyra II
const pyra2 = vexor.planetes.find(p => p.nom === 'pyra-ii');
const defenseurFlotte = pyra2.flotte_au_sol;

console.log('▸ ATTAQUANT — KAEL (depuis aetheris-prima)');
for (const [t, n] of Object.entries(attaquantFlotte)) console.log(`  · ${t.padEnd(20)} ${fmt(n)}`);
console.log(`\n▸ DÉFENSEUR — VEXOR (sur pyra-ii)`);
for (const [t, n] of Object.entries(defenseurFlotte)) console.log(`  · ${t.padEnd(20)} ${fmt(n)}`);

console.log(`\n▸ Tech KAEL: armement ${kael.recherche.armement}, bouclier_graviton ${kael.recherche.bouclier_graviton}`);
console.log(`▸ Tech VEXOR: armement ${vexor.recherche.armement}, drives_impulsion ${vexor.recherche.drives_impulsion}`);

const rng = rngFromSeed(`${manifest.seed}:${manifest.tick + 1}:bataille-pyra-ii`);

const result = resolveCombat({
  attacker: { ships: attaquantFlotte, tech: kael.recherche },
  defender: { ships: defenseurFlotte, tech: vexor.recherche },
  rules,
  rng,
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  DÉROULÉ');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const maxTir = Math.max(...result.rondes.map(r => Math.max(r.tir_attaquant, r.tir_defenseur)));

for (const r of result.rondes) {
  console.log(`  Ronde ${r.ronde}`);
  console.log(`    A: ${bar(r.tir_attaquant, maxTir, 25)} ${fmt(r.tir_attaquant)} dmg`);
  console.log(`    D: ${bar(r.tir_defenseur, maxTir, 25)} ${fmt(r.tir_defenseur)} dmg`);
  const pa = Object.entries(r.pertes_attaquant).map(([t, n]) => `${t} -${n}`).join(', ') || '—';
  const pd = Object.entries(r.pertes_defenseur).map(([t, n]) => `${t} -${n}`).join(', ') || '—';
  console.log(`    pertes A : ${pa}`);
  console.log(`    pertes D : ${pd}\n`);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  ISSUE : ${result.issue.toUpperCase()}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('▸ FLOTTE ATTAQUANT survivante');
for (const [t, n0] of Object.entries(attaquantFlotte)) {
  const n1 = result.attaquant_restant[t] || 0;
  const lost = n0 - n1;
  console.log(`  · ${t.padEnd(20)} ${fmt(n1).padStart(6)} / ${fmt(n0)} (perte: ${fmt(lost)})`);
}

console.log('\n▸ FLOTTE DÉFENSEUR survivante');
for (const [t, n0] of Object.entries(defenseurFlotte)) {
  const n1 = result.defenseur_restant[t] || 0;
  const lost = n0 - n1;
  console.log(`  · ${t.padEnd(20)} ${fmt(n1).padStart(6)} / ${fmt(n0)} (perte: ${fmt(lost)})`);
}

const debrisAtt = computeDebris(attaquantFlotte, result.attaquant_restant, rules);
const debrisDef = computeDebris(defenseurFlotte, result.defenseur_restant, rules);
const debris = {
  ferrum: debrisAtt.ferrum + debrisDef.ferrum,
  lumen: debrisAtt.lumen + debrisDef.lumen,
};

console.log(`\n▸ CHAMP DE DÉBRIS sur pyra-ii`);
console.log(`  · ferrum   : ${fmt(debris.ferrum)}`);
console.log(`  · lumen    : ${fmt(debris.lumen)}`);

if (result.issue === 'victoire-attaquant') {
  const totalCargo = Object.entries(result.attaquant_restant).reduce((a, [t, n]) => {
    return a + n * (rules.vaisseaux[t]?.cargo || 0);
  }, 0);
  const pillage = computePillage(pyra2.ressources, totalCargo, rules);
  console.log(`\n▸ PILLAGE (cargo dispo: ${fmt(totalCargo)})`);
  console.log(`  · ferrum   : ${fmt(pillage.ferrum)}`);
  console.log(`  · lumen    : ${fmt(pillage.lumen)}`);
  console.log(`  · plasmide : ${fmt(pillage.plasmide)}`);
}

console.log('\n');
