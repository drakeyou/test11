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

import { politeFetch, throttle } from './http.mjs';

const TRADES = 'https://data-api.polymarket.com/trades';

// Two paginated walks per market across dozens of markets is a burst the data
// API answers with 429. One shared pacer covers every call this module makes.
const pace = throttle(350);

/** Identity of a fill, since the records have no id of their own. */
export const tradeKey = (row) =>
  [row.transactionHash, row.proxyWallet, row.asset, row.side, row.size, row.price].join('|');

/**
 * Walk every page of one side of the trade log.
 *
 * Taking only the first page silently truncates any market busier than the
 * limit, and a truncated log reads as a complete one. The walk stops on a short
 * page, and also when a page adds nothing new: an ignored `offset` would
 * otherwise return the same page forever — the same failure that makes Gamma's
 * condition_id filter dangerous.
 *
 * @returns {Promise<{rows: object[], pages: number, truncated: boolean, repeated: boolean}>}
 */
async function fetchAll(conditionId, takerOnly, limit, maxPages, fetchImpl) {
  const seen = new Set();
  const rows = [];
  let pages = 0;
  let repeated = false;

  for (; pages < maxPages; pages++) {
    await pace();
    const response = await politeFetch(
      `${TRADES}?market=${conditionId}&limit=${limit}&offset=${pages * limit}` +
      `&takerOnly=${takerOnly}`, { fetchImpl });
    if (!response.ok) throw new Error(`trades ${response.status} for ${conditionId}`);
    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) {
      pages++;
      break;
    }

    let added = 0;
    for (const row of page) {
      const key = tradeKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      added++;
    }
    if (added === 0) {
      repeated = true;
      pages++;
      break;
    }
    if (page.length < limit) {
      pages++;
      break;
    }
  }
  return { rows, pages, truncated: pages >= maxPages, repeated };
}

/**
 * Every recorded fill on a market, tagged maker or taker.
 * @param {string} conditionId
 * @param {{limit?: number, maxPages?: number}} [options]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{rows: Array, pages: number, truncated: boolean, takerShare: number}>}
 */
export async function fetchTrades(conditionId, { limit = 500, maxPages = 40 } = {}, fetchImpl = fetch) {
  // Sequential, not parallel: running both walks at once doubles the burst the
  // rate limiter sees for no gain, since the pacer serialises them anyway.
  const takers = await fetchAll(conditionId, true, limit, maxPages, fetchImpl);
  const all = await fetchAll(conditionId, false, limit, maxPages, fetchImpl);
  const takerKeys = new Set(takers.rows.map(tradeKey));

  const rows = all.rows.map((row) => [
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

  return {
    rows,
    pages: all.pages,
    // Both conditions mean the same thing for the data: what came back is not
    // the whole log, and any rate computed from it has a short denominator.
    truncated: all.truncated || all.repeated || takers.truncated || takers.repeated,
    // Reported rather than inferred from an absence of rows: "no taker fills
    // here" and "we never looked" are different claims.
    takerShare: rows.length ? takerKeys.size / rows.length : 0,
  };
}
