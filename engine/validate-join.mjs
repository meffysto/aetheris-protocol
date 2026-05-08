#!/usr/bin/env node
// AETHERIS // PROTOCOL — Validateur de PR d'inscription.
//
// Lance par .github/workflows/validate-join.yml sur les PRs `join/<nom>`.
// Verifie que la PR ne fait que ce qu'elle pretend faire, puis sort 0 (auto-merge OK)
// ou non-zero (merge bloque, commentaire pose sur la PR).
//
// Usage : node engine/validate-join.mjs <pr_number>
// Env requis : GH_TOKEN, PR_HEAD_SHA, PR_BASE_SHA, GITHUB_REPOSITORY
//              API_BASE (optionnel, défaut https://api.github.com)

import fs from 'node:fs';
import { execSync } from 'node:child_process';

const PR_NUM = process.argv[2];
const { GH_TOKEN, PR_HEAD_SHA, PR_BASE_SHA, GITHUB_REPOSITORY } = process.env;
const API_BASE = process.env.API_BASE || 'https://api.github.com';
if (!PR_NUM || !GH_TOKEN || !PR_HEAD_SHA || !PR_BASE_SHA || !GITHUB_REPOSITORY) {
  console.error('manque env : GH_TOKEN, PR_HEAD_SHA, PR_BASE_SHA, GITHUB_REPOSITORY, ou pr_number');
  process.exit(2);
}

const errors = [];
const fail = (msg) => errors.push(msg);

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function showAt(sha, path) {
  try { return execSync(`git show ${sha}:${path}`, { encoding: 'utf8' }); }
  catch { return null; }
}

// Mini-yaml (sous-ensemble suffisant pour identite/empire/ordres)
function yparse(text) {
  const lines = text.split('\n').filter(l => !/^\s*#/.test(l)).map(l => l.replace(/\s+#.*$/, ''));
  let i = 0;
  function readBlock(indent) {
    const out = {};
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const ind = line.match(/^ */)[0].length;
      if (ind < indent) return out;
      const m = line.slice(ind).match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const [, k, rest] = m; i++;
      if (rest === '') {
        if (i < lines.length && /^\s*-\s/.test(lines[i])) out[k] = readList(ind + 2);
        else out[k] = readBlock(ind + 2);
      } else if (rest.startsWith('[') || rest.startsWith('{')) out[k] = readInline(rest);
      else out[k] = scalar(rest);
    }
    return out;
  }
  function readList(indent) {
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const ind = line.match(/^ */)[0].length;
      if (ind < indent || !line.slice(ind).startsWith('- ')) return out;
      const rest = line.slice(ind + 2); i++;
      if (rest.includes(':')) {
        const m = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
        const item = {};
        item[m[1]] = m[2] === '' ? readBlock(ind + 4) : scalar(m[2]);
        Object.assign(item, readBlock(ind + 2));
        out.push(item);
      } else out.push(scalar(rest));
    }
    return out;
  }
  function split(s, sep) {
    const out = []; let d = 0, start = 0;
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === '{' || c === '[') d++;
      else if (c === '}' || c === ']') d--;
      else if (c === sep && d === 0) { out.push(s.slice(start, j).trim()); start = j + 1; }
    }
    const last = s.slice(start).trim(); if (last) out.push(last);
    return out;
  }
  function readInline(s) {
    s = s.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      return inner ? split(inner, ',').map(scalar) : [];
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1).trim();
      const out = {};
      for (const part of split(inner, ',')) {
        const c = part.indexOf(':'); if (c < 0) continue;
        out[part.slice(0, c).trim().replace(/^["']|["']$/g, '')] = scalar(part.slice(c + 1).trim());
      }
      return out;
    }
    return s;
  }
  function scalar(s) {
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

// 1. Liste des fichiers changes
const filesRaw = sh(`git diff --name-status ${PR_BASE_SHA} ${PR_HEAD_SHA}`);
const changes = filesRaw.split('\n').filter(Boolean).map(l => {
  const [status, ...rest] = l.split(/\s+/);
  return { status: status[0], path: rest.join(' ') };
});

// 2. Extraire le nom revendique a partir des fichiers ajoutes
const playerFiles = changes.filter(c => c.path.startsWith('joueurs/'));
const newPlayerDirs = new Set(playerFiles.map(c => c.path.split('/')[1]).filter(Boolean));
if (newPlayerDirs.size === 0) fail('aucun fichier dans joueurs/<nom>/ — ce n\'est pas une PR d\'inscription');
if (newPlayerDirs.size > 1) fail(`la PR touche plusieurs joueurs : ${[...newPlayerDirs].join(', ')}`);

const NAME = [...newPlayerDirs][0] || '';
if (!/^[a-z][a-z0-9-]{1,15}$/.test(NAME)) fail(`nom invalide : "${NAME}" (regex /^[a-z][a-z0-9-]{1,15}$/)`);

// 3. Set de fichiers attendu — strict
const expected = new Set([
  `joueurs/${NAME}/identite.yaml`,
  `joueurs/${NAME}/empire.yaml`,
  `joueurs/${NAME}/empire.md`,
  `joueurs/${NAME}/ordres.yaml`,
  'world/galaxie.yaml',
]);
const allowedExtra = new Set(['joueurs/.gitignore']); // tolere si modifie (ajout regle .key.pem)

for (const c of changes) {
  if (expected.has(c.path)) continue;
  if (allowedExtra.has(c.path)) continue;
  fail(`fichier hors-perimetre : ${c.path} (${c.status})`);
}
for (const p of expected) {
  if (!changes.find(c => c.path === p)) fail(`fichier manquant : ${p}`);
}

// 4. joueur ne doit pas exister dans la base
const baseExists = showAt(PR_BASE_SHA, `joueurs/${NAME}/identite.yaml`);
if (baseExists !== null) fail(`le joueur "${NAME}" existe deja dans la base`);

// 5. Aucun .key.pem ne doit apparaitre dans le diff
if (changes.find(c => c.path.endsWith('.key.pem'))) fail('cle privee detectee dans la PR — abort');

// Si erreurs deja, court-circuit (les checks suivants supposent les fichiers presents)
if (errors.length === 0) {
  // 6. identite.yaml
  const idTxt = showAt(PR_HEAD_SHA, `joueurs/${NAME}/identite.yaml`) || '';
  const id = yparse(idTxt);
  if (id.nom !== NAME) fail(`identite.nom (${id.nom}) ne correspond pas au dossier (${NAME})`);
  if (id.version !== 1) fail('identite.version != 1');
  if (typeof id.cle_publique !== 'string' || !/^ed25519:[A-Za-z0-9+/=]{40,}$/.test(id.cle_publique))
    fail('identite.cle_publique invalide (attendu ed25519:<base64>)');
  if (id.alliance !== null) fail('identite.alliance doit etre ~ a l\'inscription');
  const inscMs = Date.parse(id.date_inscription || '');
  if (!inscMs || Math.abs(Date.now() - inscMs) > 3600 * 1000)
    fail('identite.date_inscription invalide ou trop ancienne (>1h)');

  // 7. empire.yaml
  const empTxt = showAt(PR_HEAD_SHA, `joueurs/${NAME}/empire.yaml`) || '';
  const emp = yparse(empTxt);
  if (emp.joueur !== NAME) fail(`empire.joueur (${emp.joueur}) != ${NAME}`);
  // empire.tick doit etre <= au tick courant + 1 (le user a pu generer juste apres un tick).
  // On lit le manifest a la base de la PR (etat connu au moment de la validation).
  const manTxt = showAt(PR_BASE_SHA, 'world/manifest.yaml') || '';
  const tickCur = parseInt((manTxt.match(/^tick:\s*(\d+)/m) || [, '0'])[1], 10);
  if (typeof emp.tick !== 'number' || emp.tick < tickCur - 1 || emp.tick > tickCur + 1)
    fail(`empire.tick (${emp.tick}) hors fenetre [${tickCur - 1}, ${tickCur + 1}] — re-genere ton inscription`);
  if (emp.score_total !== 0) fail('empire.score_total doit etre 0 a l\'inscription');
  if (emp.points_militaires !== 0) fail('empire.points_militaires doit etre 0');
  if (!Array.isArray(emp.planetes) || emp.planetes.length !== 1) fail('empire.planetes doit contenir exactement 1 planete');
  if (!Array.isArray(emp.flottes_en_vol) || emp.flottes_en_vol.length !== 0) fail('empire.flottes_en_vol doit etre vide');
  if (!Array.isArray(emp.file_recherche) || emp.file_recherche.length !== 0) fail('empire.file_recherche doit etre vide');

  const planet = emp.planetes && emp.planetes[0];
  let claimed = null;
  if (planet) {
    if (planet.nom !== `${NAME}-prima`) fail(`planet.nom doit etre ${NAME}-prima (recu : ${planet.nom})`);
    if (!Array.isArray(planet.coordonnees) || planet.coordonnees.length !== 3) fail('planet.coordonnees [galaxie, systeme, position] requis');
    else claimed = planet.coordonnees;
    // Pas de batiments construits
    const bats = planet.batiments || {};
    for (const [k, v] of Object.entries(bats)) if (v !== 0) fail(`planet.batiments.${k} doit etre 0 (recu ${v})`);
    if ((planet.file_chantier || []).length !== 0) fail('planet.file_chantier doit etre vide');
  }

  // 8. ordres.yaml — vide
  const ordTxt = showAt(PR_HEAD_SHA, `joueurs/${NAME}/ordres.yaml`) || '';
  const ord = yparse(ordTxt);
  if (ord.joueur !== NAME) fail(`ordres.joueur != ${NAME}`);
  if (!Array.isArray(ord.ordres) || ord.ordres.length !== 0) fail('ordres.ordres doit etre vide a l\'inscription');

  // 9. galaxie.yaml — exactement 1 ligne change, claim coherent
  const galDiff = sh(`git diff --unified=0 ${PR_BASE_SHA} ${PR_HEAD_SHA} -- world/galaxie.yaml`);
  const added = galDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const removed = galDiff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
  if (added.length !== 1 || removed.length !== 1) fail(`galaxie.yaml : doit modifier exactement 1 ligne (recu +${added.length}/-${removed.length})`);
  else {
    const before = removed[0].slice(1);
    const after = added[0].slice(1);
    const beforeMatch = before.match(/^(\s+)(\d+):\s*\{\s*type:\s*planete,\s*proprietaire:\s*null,\s*classe:\s*(\w+)\s*\}$/);
    const afterMatch = after.match(/^(\s+)(\d+):\s*\{\s*type:\s*planete,\s*proprietaire:\s*([\w-]+),\s*nom:\s*([\w-]+),\s*classe:\s*(\w+)\s*\}$/);
    if (!beforeMatch) fail('galaxie : ligne avant doit etre une planete libre (proprietaire: null)');
    if (!afterMatch) fail('galaxie : ligne apres mal formee');
    if (beforeMatch && afterMatch) {
      if (afterMatch[3] !== NAME) fail(`galaxie : proprietaire revendique (${afterMatch[3]}) != ${NAME}`);
      if (afterMatch[4] !== `${NAME}-prima`) fail(`galaxie : nom planete (${afterMatch[4]}) != ${NAME}-prima`);
      if (beforeMatch[2] !== afterMatch[2]) fail('galaxie : position de planete modifiee');
      if (beforeMatch[3] !== afterMatch[5]) fail('galaxie : classe de planete modifiee');
      // Verifier que la position correspond aux coords declarees dans empire.yaml
      if (claimed) {
        const pos = parseInt(afterMatch[2], 10);
        if (claimed[2] !== pos) fail(`galaxie : position (${pos}) != empire.planetes[0].coordonnees[2] (${claimed[2]})`);
      }
    }
  }

  // 10. Anti-race : la planete revendiquee doit toujours etre libre sur le tip de main
  // au moment ou le validator tourne. Si une autre PR a merge entre-temps, on rejette
  // avec un message explicite (le user re-run join.html, qui re-pickera une autre planete).
  if (claimed) {
    try {
      try { sh('git fetch origin main --quiet'); } catch { /* deja a jour */ }
      const galLatest = sh('git show origin/main:world/galaxie.yaml');
      const slot = getPlanetAt(galLatest, claimed[0], claimed[1], claimed[2]);
      if (!slot) fail(`anti-race : planete ${claimed.join(':')} introuvable sur origin/main`);
      else if (slot.proprietaire !== null && slot.proprietaire !== NAME)
        fail(`anti-race : la planete ${claimed.join(':')} a ete claim par "${slot.proprietaire}" entre-temps. Re-genere ton inscription via join.html (la prochaine planete libre sera selectionnee automatiquement).`);
    } catch (e) {
      fail(`anti-race : check impossible (${e.message})`);
    }
  }
}

function getPlanetAt(galaxieText, g, s, pos) {
  const lines = galaxieText.split('\n');
  let inSys = false;
  for (const line of lines) {
    const sm = line.match(/^\s+"(\d+):(\d+)":/);
    if (sm) { inSys = parseInt(sm[1]) === g && parseInt(sm[2]) === s; continue; }
    if (!inSys) continue;
    const pm = line.match(/^\s+(\d+):\s*\{\s*type:\s*planete,\s*proprietaire:\s*([\w-]+|null)(?:,\s*nom:\s*[\w-]+)?,\s*classe:\s*(\w+)\s*\}/);
    if (pm && parseInt(pm[1]) === pos) {
      return { proprietaire: pm[2] === 'null' ? null : pm[2], classe: pm[3] };
    }
  }
  return null;
}

// 10. Verdict
async function comment(body) {
  await fetch(`${API_BASE}/repos/${GITHUB_REPOSITORY}/issues/${PR_NUM}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ body }),
  });
}

if (errors.length > 0) {
  const body = `## ❌ Inscription refusee\n\n${errors.map(e => `- ${e}`).join('\n')}\n\nCorrige et push, le check repassera.`;
  await comment(body);
  console.error(body);
  process.exit(1);
}

console.log(`✓ Inscription "${NAME}" validee.`);
await comment(`## ✓ Inscription "${NAME}" validee\n\nAuto-merge active. Bienvenue dans Aetheris.`);
