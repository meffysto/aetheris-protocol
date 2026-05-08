#!/usr/bin/env node
// Orchestre : scan Bitcoin → met à jour le cache local → (optionnel) lance tick.
//
// Usage:
//   node engine/sync.mjs                     → scan depuis lastBlock, met à jour cache
//   node engine/sync.mjs --from <height>     → force le bloc de départ
//   node engine/sync.mjs --tick              → lance tick.mjs après le scan
//   node engine/sync.mjs --dry-tick          → lance tick.mjs --dry-run après le scan
//   AETH_NETWORK=mutinynet node engine/sync.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { initCache } from './cache.mjs';
import { makeNodeAdapter } from './cache-node.mjs';
import { scanRange, fetchTipHeight } from './scan-bitcoin.mjs';

// ─── config ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const API_URLS = {
  mainnet:   'https://blockstream.info/api',
  signet:    'https://mutinynet.com/api',
  mutinynet: 'https://mutinynet.com/api',
};

const networkName = process.env.AETH_NETWORK ?? 'mutinynet';
const api = API_URLS[networkName] ?? API_URLS.mutinynet;

const args = process.argv.slice(2);
const fromArg = args[args.indexOf('--from') + 1];
const doTick = args.includes('--tick');
const doDryTick = args.includes('--dry-tick');

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  initCache(makeNodeAdapter(CACHE_DIR));
  const { get, set, appendOrders } = await import('./cache.mjs');

  const tip = await fetchTipHeight(api);
  console.log(`tip courant: bloc ${tip}`);

  const lastScanned = (await get('lastBlock')) ?? -1;
  const fromBlock = fromArg ? parseInt(fromArg, 10) : Math.max(0, lastScanned + 1);

  if (fromBlock > tip) {
    console.log('Aucun nouveau bloc à scanner.');
    return;
  }

  console.log(`Scan des blocs ${fromBlock}..${tip}...`);
  let inscriptionCount = 0;

  for await (const ins of scanRange(fromBlock, tip, {
    api,
    onBlock: h => process.stdout.write(`\r  bloc ${h}/${tip}...`),
  })) {
    process.stdout.write('\n');
    console.log(`  ✓ ${ins.opType} depuis ${ins.txid.slice(0, 16)}...`);

    // Parse le YAML pour extraire le tick_cible
    const yaml = ins.yaml;
    const tickMatch = yaml.match(/^tick_cible:\s*(\d+)/m);
    const tick = tickMatch ? parseInt(tickMatch[1], 10) : null;

    if (tick !== null) {
      await appendOrders(tick, [{ txid: ins.txid, blockHeight: ins.blockHeight, opType: ins.opType, yaml }]);
    }
    inscriptionCount++;
  }

  process.stdout.write('\n');
  await set('lastBlock', tip);
  console.log(`\n✓ Scan terminé : ${inscriptionCount} inscription(s) trouvée(s), cache mis à jour`);

  if (doTick || doDryTick) {
    const tickArg = doDryTick ? '--dry-run' : '--apply';
    console.log(`\nLancement tick.mjs ${tickArg}...`);
    const result = spawnSync('node', [path.join(ROOT, 'engine/tick.mjs'), tickArg], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, AETH_ORDER_SOURCE: 'bitcoin' },
    });
    if (result.status !== 0) {
      console.error(`tick.mjs a échoué avec le code ${result.status}`);
      process.exit(result.status ?? 1);
    }
  }
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
