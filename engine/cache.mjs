// Abstraction storage isomorphique.
// Interface : get(key), set(key, val), clear(), appendOrders(tick, orders), getOrders(tick)
// Injecter un adaptateur via initCache(adapter) avant tout appel.
// Node → cache-node.mjs / Navigateur → adaptateur IndexedDB à fournir.

let _adapter = null;

export function initCache(adapter) {
  _adapter = adapter;
}

export async function get(key) {
  _assert();
  return _adapter.get(key);
}

export async function set(key, value) {
  _assert();
  return _adapter.set(key, value);
}

export async function clear() {
  _assert();
  return _adapter.clear();
}

// Accumule des ordres pour un tick donné (n'écrase pas).
export async function appendOrders(tick, orders) {
  _assert();
  const key = `orders-${tick}`;
  const existing = (await _adapter.get(key)) ?? [];
  await _adapter.set(key, [...existing, ...orders]);
}

export async function getOrders(tick) {
  _assert();
  return (await _adapter.get(`orders-${tick}`)) ?? [];
}

function _assert() {
  if (!_adapter) throw new Error('cache: appelle initCache(adapter) avant utilisation');
}
