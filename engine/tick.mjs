#!/usr/bin/env node
// CITADEL // PROTOCOL — Wrapper CLI du résolveur de tick.
// La logique iso est dans engine/tick-core.mjs.
//
// Usage:
//   node engine/tick.mjs --dry-run
//   node engine/tick.mjs --apply
//   node engine/tick.mjs --apply --strict
//   AETH_ORDER_SOURCE=bitcoin node engine/tick.mjs --apply

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { runTick, yparse, ystringify } from './tick-core.mjs';
import { resolveCombat, computeDebris, computePillage } from './combat.mjs';

const ROOT = path.resolve(process.argv[2] === '--root' ? process.argv[3] : '.');
const DRY = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');
const STRICT = process.argv.includes('--strict');

if (!DRY && !APPLY) {
  console.error('Usage: tick.mjs [--root <path>] (--dry-run | --apply) [--strict]');
  process.exit(2);
}

function rd(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function wr(p, content) {
  if (DRY) { console.log(`  [DRY] would write ${p} (${content.length} bytes)`); return; }
  const full = path.join(ROOT, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function ls(p) {
  const full = path.join(ROOT, p);
  return fs.existsSync(full) ? fs.readdirSync(full) : [];
}
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }

console.log('━━━ CITADEL // tick resolver ━━━');
console.log(`root = ${ROOT}`);
console.log(`mode = ${DRY ? 'DRY-RUN' : 'APPLY'}`);

const manifest = yparse(rd('world/manifest.yaml'));
const rules = yparse(rd('engine/rules.yaml'));
const galaxie = yparse(rd('world/galaxie.yaml'));

console.log(`tick courant = ${manifest.tick}`);
console.log(`seed = ${manifest.seed}`);

const players = ls('joueurs').filter(n => exists(`joueurs/${n}/empire.yaml`)).sort();
console.log(`joueurs = ${players.length} (${players.join(', ')})`);

const empires = {};
const identites = {};
for (const p of players) {
  empires[p] = yparse(rd(`joueurs/${p}/empire.yaml`));
  if (exists(`joueurs/${p}/identite.yaml`)) identites[p] = yparse(rd(`joueurs/${p}/identite.yaml`));
}

const ORDER_SOURCE = process.env.AETH_ORDER_SOURCE ?? 'filesystem';
const orders = {};
const ordersRawText = {};

if (ORDER_SOURCE === 'bitcoin') {
  const cacheFile = path.join(ROOT, `.cache/orders-${manifest.tick + 1}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    for (const entry of cached) {
      const parsed = yparse(entry.yaml);
      if (parsed && parsed.joueur) {
        orders[parsed.joueur] = parsed;
        ordersRawText[parsed.joueur] = entry.yaml;
      }
    }
    console.log(`  source: bitcoin cache (${cached.length} ordres)`);
  } catch (e) {
    console.warn(`  ! cache bitcoin introuvable (${cacheFile}): ${e.message}`);
  }
} else {
  for (const p of players) {
    if (exists(`joueurs/${p}/ordres.yaml`)) {
      try {
        const yaml = rd(`joueurs/${p}/ordres.yaml`);
        orders[p] = yparse(yaml);
        ordersRawText[p] = yaml;
      } catch (e) { console.warn(`  ! ordres.yaml invalide pour ${p}: ${e.message}`); }
    }
  }
}

// Vérification sig Ed25519 via node:crypto
async function verifySignature(rawContent, pubB64, sigB64) {
  try {
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(pubB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const sig = Buffer.from(sigB64, 'base64');
    const canonical = rawContent.split('\n').filter(l => !/^signature:\s*/.test(l)).join('\n').trimEnd() + '\n';
    return crypto.verify(null, Buffer.from(canonical, 'utf8'), pubKey, sig);
  } catch { return false; }
}

const result = await runTick({
  manifest, rules, galaxie,
  empires, orders, ordersRawText, identites,
  combat: { resolveCombat, computeDebris, computePillage },
  verifySignature,
  opts: { strict: STRICT, log: (m) => console.log(m) },
});

// ─── Écriture ────────────────────────────────────────────────────────────

console.log(`\n▸ Écriture des fichiers`);
wr('world/manifest.yaml', '# Généré par engine/tick.mjs — ne pas éditer.\n' + ystringify(result.newManifest));
for (const f of result.empireFiles) {
  wr(`joueurs/${f.player}/empire.yaml`, f.yaml);
  wr(`joueurs/${f.player}/empire.md`, f.md);
}
if (result.eventsLog) wr(result.eventsLog.filename, result.eventsLog.content);
for (const r of result.reports.intel) wr(r.filename, r.content);
for (const r of result.reports.alerts) wr(r.filename, r.content);
for (const r of result.reports.battles) wr(r.filename, r.content);

console.log(`\n✓ Tick ${result.newManifest.tick} ${DRY ? 'simulé' : 'écrit'}.`);
console.log(`  ${result.events.length} événement(s).`);
console.log(`  ${result.empireFiles.length} empire(s) mis à jour.`);
