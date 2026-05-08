// Scanne des blocs Bitcoin et extrait les ordres Citadel depuis les witnesses tapscript.
// Isomorphique : fetch() uniquement, pas de fs, pas de child_process.
//
// Export principal :
//   scanRange(fromBlock, toBlock, opts) → AsyncGenerator<ParsedInscription>
//
// ParsedInscription = { txid, blockHeight, blockHash, opType, yaml, valid }

import { gunzipSync } from 'fflate';

// ─── constantes ──────────────────────────────────────────────────────────────

const AETH_TAG = new TextEncoder().encode('aeth'); // [97, 101, 116, 104]
const TAG_HEX = '61657468';

const OP_TYPES_REV = { 0x01: 'join', 0x02: 'order', 0x03: 'sealed', 0x04: 'reveal' };

// ─── Esplora API ─────────────────────────────────────────────────────────────

const FETCH_OPTS = { cache: 'no-store' };

async function esploraGet(url) {
  const res = await fetch(url, FETCH_OPTS);
  if (!res.ok) throw new Error(`Esplora ${res.status}: ${url}`);
  return res.json();
}

export async function fetchBlockHash(height, api) {
  const res = await fetch(`${api}/block-height/${height}`, FETCH_OPTS);
  if (!res.ok) throw new Error(`fetchBlockHash ${height}: ${res.status}`);
  return (await res.text()).trim();
}

export async function fetchBlockTxids(blockHash, api) {
  return esploraGet(`${api}/block/${blockHash}/txids`);
}

export async function fetchTx(txid, api) {
  return esploraGet(`${api}/tx/${txid}`);
}

export async function fetchTipHeight(api) {
  const res = await fetch(`${api}/blocks/tip/height`, FETCH_OPTS);
  if (!res.ok) throw new Error(`fetchTipHeight: ${res.status}`);
  return parseInt(await res.text(), 10);
}

// ─── parsing de l'envelope ───────────────────────────────────────────────────

/**
 * Recherche le pattern Citadel dans un witness stack tapscript.
 * Retourne { opType, payload } ou null si pas trouvé.
 *
 * Le witness d'un script-path spend taproot = [...args, script, controlBlock]
 * Le script contient notre envelope sous forme de bytes bruts.
 */
export function parseWitness(witnessStack) {
  if (!witnessStack || witnessStack.length < 2) return null;

  // Le script est l'avant-dernier élément du witness (le dernier = control block)
  // On cherche le pattern dans tous les éléments (pour robustesse)
  for (const item of witnessStack) {
    const bytes = hexToBytes(item);
    const result = extractEnvelope(bytes);
    if (result) return result;
  }
  return null;
}

/**
 * Cherche l'envelope Citadel dans une séquence de bytes (le script du witness).
 * Pattern : 20 <pubkey:32> ac 00 63 04 61657468 [version:01] [opType:01] [payload...] 68(ENDIF)
 *
 * Si le script commence par 0x20 (push 32 bytes) suivi de OP_CHECKSIG (0xac),
 * on extrait la pubkey Schnorr de l'inscripteur — c'est l'identité Bitcoin-native.
 */
function extractEnvelope(bytes) {
  // Pubkey de l'inscripteur : premier push de 32 bytes (Schnorr) suivi de OP_CHECKSIG.
  let inscriberPubKey = null;
  if (bytes.length >= 34 && bytes[0] === 0x20 && bytes[33] === 0xac) {
    inscriberPubKey = bytesToHex(bytes.slice(1, 33));
  }

  // Cherche "aeth" (0x04 61 65 74 68) dans les bytes du script
  // 0x04 = push de 4 bytes
  const marker = new Uint8Array([0x04, 0x61, 0x65, 0x74, 0x68]);

  outer: for (let i = 0; i <= bytes.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) continue outer;
    }

    // Trouvé le tag "aeth" à la position i
    let pos = i + marker.length;

    // version byte (0x01 = push 1 byte, puis le byte de version)
    if (pos + 2 > bytes.length) continue;
    if (bytes[pos] !== 0x01) continue; // push 1 byte
    const versionByte = bytes[pos + 1];
    if (versionByte !== 0x01) continue; // version 1 uniquement
    pos += 2;

    // op_type byte (0x01 = push 1 byte, puis le byte d'optype)
    if (pos + 2 > bytes.length) continue;
    if (bytes[pos] !== 0x01) continue;
    const opTypeByte = bytes[pos + 1];
    if (!(opTypeByte in OP_TYPES_REV)) continue;
    pos += 2;

    // Payload : un ou plusieurs push d'au plus 520 bytes, jusqu'au OP_ENDIF (0x68)
    const payloadChunks = [];
    while (pos < bytes.length) {
      const b = bytes[pos];
      if (b === 0x68) break; // OP_ENDIF

      // Push data opcode
      if (b >= 0x01 && b <= 0x4b) {
        // OP_DATA_N : push N bytes
        const len = b;
        pos++;
        if (pos + len > bytes.length) break;
        payloadChunks.push(bytes.slice(pos, pos + len));
        pos += len;
      } else if (b === 0x4c) {
        // OP_PUSHDATA1
        pos++;
        if (pos + 1 > bytes.length) break;
        const len = bytes[pos++];
        if (pos + len > bytes.length) break;
        payloadChunks.push(bytes.slice(pos, pos + len));
        pos += len;
      } else if (b === 0x4d) {
        // OP_PUSHDATA2
        pos++;
        if (pos + 2 > bytes.length) break;
        const len = bytes[pos] | (bytes[pos + 1] << 8);
        pos += 2;
        if (pos + len > bytes.length) break;
        payloadChunks.push(bytes.slice(pos, pos + len));
        pos += len;
      } else {
        // Opcode inconnu — stop
        break;
      }
    }

    if (payloadChunks.length === 0) continue;

    // Reconstituer le payload
    const totalLen = payloadChunks.reduce((s, c) => s + c.length, 0);
    const payload = new Uint8Array(totalLen);
    let off = 0;
    for (const c of payloadChunks) {
      payload.set(c, off);
      off += c.length;
    }

    // Décompresser le YAML
    try {
      const yamlBytes = gunzipSync(payload);
      const yaml = new TextDecoder().decode(yamlBytes);
      return { opType: OP_TYPES_REV[opTypeByte], opTypeByte, yaml, inscriberPubKey };
    } catch {
      continue; // pas du gzip valide, continuer la recherche
    }
  }

  return null;
}

// ─── scan d'une transaction ───────────────────────────────────────────────────

/**
 * Cherche des inscriptions Citadel dans toutes les TX d'un bloc.
 * @param {string} blockHash
 * @param {number} blockHeight
 * @param {string} api  URL base Esplora
 * @returns {AsyncGenerator<ParsedInscription>}
 */
export async function* scanBlock(blockHash, blockHeight, api) {
  const txids = await fetchBlockTxids(blockHash, api);

  for (const txid of txids) {
    // Fetch la TX complète pour ses witnesses
    let tx;
    try {
      tx = await fetchTx(txid, api);
    } catch (e) {
      console.warn(`scanBlock: skip ${txid}: ${e.message}`);
      continue;
    }

    // Cherche dans tous les inputs
    for (const vin of tx.vin ?? []) {
      const witness = vin.witness;
      if (!witness || witness.length < 2) continue;

      const result = parseWitness(witness);
      if (!result) continue;

      yield {
        txid,
        blockHeight,
        blockHash,
        opType: result.opType,
        opTypeByte: result.opTypeByte,
        yaml: result.yaml,
        inscriberPubKey: result.inscriberPubKey,  // pubkey Schnorr (hex 64) ou null
        valid: true,
      };
    }
  }
}

/**
 * Scanne une plage de blocs et retourne toutes les inscriptions Citadel.
 * @param {number} fromBlock
 * @param {number} toBlock
 * @param {{ api: string, onBlock?: (h: number) => void }} opts
 * @returns {AsyncGenerator<ParsedInscription>}
 */
export async function* scanRange(fromBlock, toBlock, opts = {}) {
  const api = opts.api ?? 'https://mutinynet.com/api';

  for (let height = fromBlock; height <= toBlock; height++) {
    if (opts.onBlock) opts.onBlock(height);
    try {
      const blockHash = await fetchBlockHash(height, api);
      yield* scanBlock(blockHash, height, api);
    } catch (e) {
      console.warn(`scanRange: erreur bloc ${height}: ${e.message}`);
    }
  }
}

// ─── utilitaires ─────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  if (hex instanceof Uint8Array) return hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  let h = '';
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0');
  return h;
}

// ─── CLI standalone (Node uniquement) ────────────────────────────────────────

const isMain = typeof process !== 'undefined' && process.argv?.[1] &&
  new URL(import.meta.url).pathname === new URL(process.argv[1], import.meta.url).pathname;

if (isMain) {
  const args = process.argv.slice(2);
  const fromBlock = parseInt(args[0] ?? '0', 10);
  const toBlock = parseInt(args[1] ?? String(fromBlock), 10);
  const api = process.env.AETH_API ?? 'https://mutinynet.com/api';

  console.log(`Scan blocs ${fromBlock}..${toBlock} sur ${api}`);

  (async () => {
    let count = 0;
    for await (const ins of scanRange(fromBlock, toBlock, {
      api,
      onBlock: h => process.stdout.write(`\rbloc ${h}...`),
    })) {
      process.stdout.write('\n');
      console.log(`  txid     : ${ins.txid}`);
      console.log(`  bloc     : ${ins.blockHeight}`);
      console.log(`  op_type  : ${ins.opType} (0x${ins.opTypeByte.toString(16)})`);
      console.log(`  yaml     :\n${ins.yaml.slice(0, 200)}`);
      console.log('');
      count++;
    }
    process.stdout.write('\n');
    console.log(`${count} inscription(s) trouvée(s)`);
  })().catch(e => { console.error(e); process.exit(1); });
}
