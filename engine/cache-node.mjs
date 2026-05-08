// Adaptateur cache pour Node.js — filesystem sous .cache/
// Usage : import { makeNodeAdapter } from './cache-node.mjs';
//         initCache(makeNodeAdapter('.cache'));

import fs from 'node:fs/promises';
import path from 'node:path';

export function makeNodeAdapter(cacheDir) {
  async function ensureDir() {
    await fs.mkdir(cacheDir, { recursive: true });
  }

  function keyPath(key) {
    const safe = key.replace(/[^a-z0-9_-]/gi, '_');
    return path.join(cacheDir, safe + '.json');
  }

  return {
    async get(key) {
      try {
        const raw = await fs.readFile(keyPath(key), 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await ensureDir();
      await fs.writeFile(keyPath(key), JSON.stringify(value, null, 2), 'utf8');
    },
    async clear() {
      try {
        const files = await fs.readdir(cacheDir);
        await Promise.all(files.map(f => fs.unlink(path.join(cacheDir, f))));
      } catch { /* dossier inexistant, ok */ }
    },
  };
}
