// AETHERIS // PROTOCOL — Loader de stratégies pluggables
// ───────────────────────────────────────────────────────
// Lit `joueurs/<player>/agent.yaml` (optionnel) et charge la stratégie
// correspondante depuis `agents/strategies/<nom>.mjs`. Si le fichier n'existe
// pas, retombe sur la stratégie `eco` (= comportement historique d'Aurora).
//
// Chaque module stratégie exporte :
//   export const name = '<id>';
//   export function decide({ empire, config, ctx }) → ordres[]
//
// Le loader est appelé à CHAQUE cycle pour permettre le hot-reload : commit
// modifié de agent.yaml → le prochain tour applique. Aucune restart requise.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { yparse } from '../../engine/tick-core.mjs';

const STRATEGIES_DIR = path.dirname(new URL(import.meta.url).pathname);
const ALLOWED = /^[a-z][a-z0-9_-]*$/;

export const DEFAULT_STRATEGY = 'eco';

async function readAgentYaml(playerDir) {
  const file = path.join(playerDir, 'agent.yaml');
  try {
    const text = await fs.readFile(file, 'utf8');
    return { file, parsed: yparse(text) ?? {} };
  } catch {
    return { file: null, parsed: {} };
  }
}

async function importStrategy(stratName) {
  if (!ALLOWED.test(stratName)) {
    throw new Error(`Nom de stratégie invalide: "${stratName}" (regex ${ALLOWED}).`);
  }
  const modPath = path.join(STRATEGIES_DIR, `${stratName}.mjs`);
  try { await fs.access(modPath); }
  catch { throw new Error(`Stratégie "${stratName}" introuvable: ${modPath}`); }
  const mod = await import(pathToFileURL(modPath).href);
  if (typeof mod.decide !== 'function') {
    throw new Error(`Stratégie "${stratName}" n'exporte pas decide().`);
  }
  return mod;
}

/**
 * @param {object} args
 * @param {string} args.playerDir   chemin absolu joueurs/<player>
 * @returns {Promise<{ name: string, config: object, source: string|null, decide: Function }>}
 */
export async function loadStrategy({ playerDir }) {
  const { file, parsed } = await readAgentYaml(playerDir);
  const stratName = parsed.strategie ?? DEFAULT_STRATEGY;
  const mod = await importStrategy(stratName);
  return {
    name: mod.name ?? stratName,
    config: parsed,
    source: file,
    decide: (input) => mod.decide({ ...input, config: parsed }),
  };
}
