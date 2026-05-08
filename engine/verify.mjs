#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
//  CITADEL // verify.mjs
//  Vérifie la chaîne de hashes des manifests à travers l'historique git.
//
//  Usage:
//    node engine/verify.mjs              # vérifie depuis genesis
//    node engine/verify.mjs --from N     # vérifie à partir du tick N
//
//  Pour chaque commit qui touche world/manifest.yaml :
//    1. recharge le manifest à ce commit
//    2. vérifie que previous_tick_hash == tick_hash du tick précédent
//    3. recalcule tick_hash et vérifie qu'il correspond
// ════════════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import crypto from 'crypto';

const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from');
const fromTick = fromIdx >= 0 ? parseInt(args[fromIdx + 1], 10) : 0;

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

// Parser YAML minimal pour le manifest (clés plates + parametres simple).
function yparseManifest(src) {
  const out = {};
  const stack = [{ obj: out, indent: -1 }];
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^ */)[0].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    if (val === '') {
      const child = {};
      stack[stack.length - 1].obj[key] = child;
      stack.push({ obj: child, indent });
    } else {
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
      else if (/^-?\d+\.\d+$/.test(val)) val = parseFloat(val);
      else if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (val === 'null') val = null;
      stack[stack.length - 1].obj[key] = val;
    }
  }
  return out;
}

function manifestAtCommit(sha) {
  try {
    const src = execSync(`git show ${sha}:world/manifest.yaml`, { encoding: 'utf8' });
    return yparseManifest(src);
  } catch {
    return null;
  }
}

console.log('━━━ CITADEL // verify chain ━━━');

const log = execSync(
  `git log --reverse --format=%H -- world/manifest.yaml`,
  { encoding: 'utf8' }
).trim().split('\n').filter(Boolean);

console.log(`commits touchant manifest = ${log.length}`);

let prevTickHash = 'genesis';
let prevTick = -1;
let checked = 0, skipped = 0, errors = 0;

for (const sha of log) {
  const m = manifestAtCommit(sha);
  if (!m || typeof m.tick !== 'number') { skipped++; continue; }
  if (m.tick < fromTick) { prevTickHash = m.tick_hash || prevTickHash; prevTick = m.tick; continue; }

  const expectedPrev = prevTickHash;
  const claimedPrev = m.previous_tick_hash;

  // Recalcul du tick_hash : on retire le champ et on canonicalise.
  const claimedHash = m.tick_hash;
  if (!claimedHash) {
    console.log(`  tick ${m.tick} (${sha.slice(0, 7)}) — pas de tick_hash (pré-chaîne)`);
    skipped++;
    continue;
  }
  const copy = { ...m };
  delete copy.tick_hash;
  const recomputed = 'sha256:' + crypto.createHash('sha256')
    .update(canonicalJSON(copy))
    .digest('hex');

  const linkOK = claimedPrev === expectedPrev || prevTick === -1;
  const hashOK = recomputed === claimedHash;

  if (linkOK && hashOK) {
    console.log(`  ✓ tick ${m.tick} ${claimedHash.slice(0, 20)}…`);
    checked++;
  } else {
    console.log(`  ✗ tick ${m.tick} (${sha.slice(0, 7)})`);
    if (!linkOK) console.log(`    chaîne brisée : previous_tick_hash=${claimedPrev} attendu=${expectedPrev}`);
    if (!hashOK) console.log(`    hash invalide : ${claimedHash} recalculé=${recomputed}`);
    errors++;
  }

  prevTickHash = claimedHash;
  prevTick = m.tick;
}

console.log(`\nvérifiés=${checked} ignorés=${skipped} erreurs=${errors}`);
process.exit(errors > 0 ? 1 : 0);
