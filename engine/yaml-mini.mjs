// YAML mini — sous-ensemble suffisant pour les schémas CITADEL.
// Parser/serializer isomorphes (Node + navigateur), sans dépendance.
// Choix documenté dans docs/adr/0002-yaml-canonique-maison.md.
//
// Limitations volontaires :
//   - pas d'ancres/aliases, pas de tags YAML
//   - pas de flow style multi-ligne
//   - indentation 2 espaces uniquement
//   - scalaires : string, int, float, bool, null
//
// `yparse(text) → object` et `ystringify(obj) → string` sont mutuellement
// inverses sur l'ensemble des formes générées par ystringify lui-même.

export function yparse(text) {
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
      const m = line.slice(ind).match(/^(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const k = m[1] ?? m[2] ?? m[3];
      const rest = m[4];
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
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === sep && depth === 0) {
        out.push(s.slice(start, i).trim());
        start = i + 1;
      }
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
        const v = part.slice(colon + 1).trim();
        out[k] = parseScalar(v);
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

export function ystringify(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return /[:#\[\]{}]|^\s|\s$/.test(obj) ? JSON.stringify(obj) : obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      if (typeof item === 'object' && item !== null) {
        const lines = Object.entries(item).map(([k, v], i) => {
          const prefix = i === 0 ? `${pad}- ` : `${pad}  `;
          if (typeof v === 'object' && v !== null) {
            if (Array.isArray(v) && v.length === 0) return `${prefix}${k}: []`;
            if (!Array.isArray(v) && Object.keys(v).length === 0) return `${prefix}${k}: {}`;
            return `${prefix}${k}:\n${ystringify(v, indent + 4)}`;
          }
          return `${prefix}${k}: ${ystringify(v)}`;
        });
        return lines.join('\n');
      }
      return `${pad}- ${ystringify(item)}`;
    }).join('\n');
  }
  return Object.entries(obj).map(([k, v]) => {
    if (typeof v === 'object' && v !== null) {
      if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []`;
      if (!Array.isArray(v) && Object.keys(v).length === 0) return `${pad}${k}: {}`;
      const inner = ystringify(v, indent + 2);
      return `${pad}${k}:\n${inner}`;
    }
    return `${pad}${k}: ${ystringify(v)}`;
  }).join('\n');
}
