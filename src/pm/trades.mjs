// Maker/taker role, which is the ground truth the whole study rests on.
//
// Trade records carry no role flag. The only way to recover it through the API
// is that `takerOnly=true` returns a strict subset of `takerOnly=false`: what is
// in the second and not the first was filled passively. Verified live on
// condition 0x3c9b7d57 — 124 taker records inside 367 total, and the target
// wallet appears only among the 243 maker-side fills, buying 200 at 0.02.
//
// That matters because a passive fill at one or two cents is the strategy, while
// the same trade taken aggressively is the opposite of it, and the two are
// indistinguishable in the activity feed.

const TRADES = 'https://data-api.polymarket.com/trades';

/** Identity of a fill, since the records have no id of their own. */
export const tradeKey = (row) =>
  [row.transactionHash, row.proxyWallet, row.asset, row.side, row.size, row.price].join('|');

async function fetchPage(conditionId, takerOnly, limit, fetchImpl) {
  const response = await fetchImpl(
    `${TRADES}?market=${conditionId}&limit=${limit}&takerOnly=${takerOnly}`);
  if (!response.ok) throw new Error(`trades ${response.status} for ${conditionId}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

/**
 * Every recorded fill on a market, tagged maker or taker.
 * @param {string} conditionId
 * @param {{limit?: number}} [options]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array>} rows for the `trades` table
 */
export async function fetchTrades(conditionId, { limit = 500 } = {}, fetchImpl = fetch) {
  const [takers, all] = await Promise.all([
    fetchPage(conditionId, true, limit, fetchImpl),
    fetchPage(conditionId, false, limit, fetchImpl),
  ]);
  const takerKeys = new Set(takers.map(tradeKey));

  return all.map((row) => [
    new Date((Number(row.timestamp) || 0) * 1000).toISOString(),
    row.conditionId ?? conditionId,
    row.asset ?? null,
    (row.proxyWallet ?? '').toLowerCase(),
    row.side ?? null,
    Number(row.price),
    Number(row.size),
    takerKeys.has(tradeKey(row)) ? 'taker' : 'maker',
    row.transactionHash ?? null,
  ]);
}
