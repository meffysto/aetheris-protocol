#!/usr/bin/env node
// Affiche l'état d'un joueur depuis le cache local ou les fichiers du repo.
//
// Usage:
//   node engine/show.mjs --player <nom>
//   node engine/show.mjs --player meff --source cache   # lit .cache/
//   node engine/show.mjs --player meff --source files   # lit joueurs/ (défaut)
//   node engine/show.mjs --cache-info                   # infos générales sur le cache

import fs from 'node:fs';
import path from 'node:path';
import { initCache } from './cache.mjs';
import { makeNodeAdapter } from './cache-node.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');

const args = process.argv.slice(2);
const playerArg = args[args.indexOf('--player') + 1];
const sourceArg = args[args.indexOf('--source') + 1] ?? 'files';
const cacheInfo = args.includes('--cache-info');

// ─── YAML mini (copié depuis tick.mjs pour éviter la dépendance) ──────────────

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
        out[k] = rest;
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
        if (m[2] === '') { item[m[1]] = readBlock(ind + 4); }
        else { item[m[1]] = parseScalar(m[2]); }
        Object.assign(item, readBlock(ind + 2));
        out.push(item);
      } else {
        out.push(parseScalar(rest));
      }
    }
    return out;
  }
  function parseScalar(s) {
    s = s.trim();
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~' || s === '') return null;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
    if (/^["'].*["']$/.test(s)) return s.slice(1, -1);
    return s;
  }
  return readBlock(0);
}

// ─── affichage ───────────────────────────────────────────────────────────────

function fmt(n) {
  return String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function showEmpire(emp, source) {
  const sep = '─'.repeat(60);
  console.log(sep);
  console.log(`  EMPIRE DE ${(emp.joueur ?? '?').toUpperCase()}  ·  Tick ${emp.tick ?? '?'}  ·  Rang ${emp.rang ?? '?'}`);
  console.log(`  Score : ${fmt(emp.score_total)}  ·  Militaire : ${fmt(emp.points_militaires)}`);
  if (emp.alliance) console.log(`  Alliance : ${emp.alliance}`);
  console.log(sep);

  for (const p of emp.planetes ?? []) {
    console.log(`\n  ▸ ${p.nom}  [${(p.coordonnees ?? []).join(':')}]  ${p.type ?? ''}`);
    console.log(`    Champs : ${p.champs?.utilises ?? '?'}/${p.champs?.total ?? '?'}`);

    for (const [res, info] of Object.entries(p.ressources ?? {})) {
      const stock = fmt(info.stock);
      const prod = fmt(info.production_par_utj);
      const cap = fmt(info.capacite);
      console.log(`    ${res.padEnd(12)} : ${stock.padStart(10)} / ${cap}  (+${prod}/utj)`);
    }

    if (Object.keys(p.batiments ?? {}).length > 0) {
      const bats = Object.entries(p.batiments)
        .map(([k, v]) => `${k}:${v}`)
        .join('  ');
      console.log(`    Bâtiments : ${bats}`);
    }

    const fileChantier = Array.isArray(p.file_chantier) ? p.file_chantier : [];
    if (fileChantier.length > 0) {
      const file = fileChantier.map(f => `${f.batiment}→${f.niveau_cible}(${f.fin_utj}utj)`).join(', ');
      console.log(`    En cours  : ${file}`);
    }
  }

  const recherche = emp.recherche;
  const rechercheEntries = typeof recherche === 'object' && recherche !== null && !Array.isArray(recherche)
    ? Object.entries(recherche).filter(([k]) => k !== '0' && k !== '1')
    : [];
  if (rechercheEntries.length > 0) {
    console.log('\n  Recherches :');
    for (const [tech, niv] of rechercheEntries) {
      console.log(`    ${tech.padEnd(30)} niv ${niv}`);
    }
  }

  console.log(sep);
  console.log(`  Source : ${source}`);
}

async function showCacheInfo() {
  initCache(makeNodeAdapter(CACHE_DIR));
  const { get } = await import('./cache.mjs');
  const lastBlock = await get('lastBlock');
  console.log(`Cache : ${CACHE_DIR}`);
  console.log(`Dernier bloc scanné : ${lastBlock ?? '(aucun)'}`);

  // Lister les fichiers de cache
  try {
    const files = fs.readdirSync(CACHE_DIR);
    const orderFiles = files.filter(f => f.startsWith('orders_'));
    console.log(`Fichiers d'ordres en cache : ${orderFiles.length}`);
    for (const f of orderFiles) {
      const content = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
      const tick = f.replace('orders_', '').replace('.json', '');
      console.log(`  tick ${tick} : ${content.length} ordre(s)`);
    }
  } catch { /* cache vide */ }
}

async function main() {
  if (cacheInfo) {
    await showCacheInfo();
    return;
  }

  if (!playerArg) {
    console.error('Usage: node engine/show.mjs --player <nom> [--source cache|files]');
    console.error('       node engine/show.mjs --cache-info');
    process.exit(1);
  }

  if (sourceArg === 'cache') {
    initCache(makeNodeAdapter(CACHE_DIR));
    const { get } = await import('./cache.mjs');
    const state = await get(`empire-${playerArg}`);
    if (!state) {
      console.error(`Aucun état en cache pour ${playerArg}. Lance d'abord sync.mjs.`);
      process.exit(1);
    }
    showEmpire(state, `.cache/empire-${playerArg}.json`);
  } else {
    const empPath = path.join(ROOT, 'joueurs', playerArg, 'empire.yaml');
    if (!fs.existsSync(empPath)) {
      console.error(`Fichier introuvable : ${empPath}`);
      process.exit(1);
    }
    const emp = yparse(fs.readFileSync(empPath, 'utf8'));
    showEmpire(emp, empPath);
  }
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
