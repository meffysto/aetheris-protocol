#!/usr/bin/env node
// Kill switch pour aurora-autonomous.mjs.
//
// Usage :
//   node agents/aurora-killswitch.mjs on            # arme (touch sentinel)
//   node agents/aurora-killswitch.mjs off           # désarme (rm sentinel)
//   node agents/aurora-killswitch.mjs status        # état
//   node agents/aurora-killswitch.mjs on --player X # cible un autre agent
//
// Effet : la prochaine vérification du loop (cf. shouldStop) verra le fichier
// et sortira proprement. L'arrêt n'est PAS instantané — il attend la fin du
// cycle en cours (au pire ~POLL_SEC + durée d'une inscription).

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const cmd = args[0];
const playerIdx = args.indexOf('--player');
const player = playerIdx >= 0 ? args[playerIdx + 1] : 'aurora';
const sentinel = path.join(ROOT, 'agents', `.killswitch-${player}`);

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function main() {
  if (cmd === 'on') {
    await fs.writeFile(sentinel, `armé ${new Date().toISOString()}\n`, 'utf8');
    console.log(`✓ kill switch ARMÉ pour ${player} → ${path.relative(process.cwd(), sentinel)}`);
    console.log("  L'agent sortira au prochain cycle.");
  } else if (cmd === 'off') {
    if (await exists(sentinel)) {
      await fs.unlink(sentinel);
      console.log(`✓ kill switch désarmé pour ${player}`);
    } else {
      console.log(`(déjà désarmé pour ${player})`);
    }
  } else if (cmd === 'status' || !cmd) {
    const armed = await exists(sentinel);
    console.log(`kill switch ${player} : ${armed ? 'ARMÉ' : 'inactif'} (${path.relative(process.cwd(), sentinel)})`);
    if (process.env.AURORA_KILL === '1') console.log('  ⚠ env AURORA_KILL=1 aussi présent (override)');
  } else {
    console.error('Usage: aurora-killswitch.mjs on|off|status [--player <nom>]');
    process.exit(2);
  }
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
