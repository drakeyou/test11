// Module A — market discovery.
//
// Gamma caps a page at 100 regardless of the limit asked for, so a single
// limit=500 call silently returns a quarter of what it looks like it returns.
// Everything here pages explicitly.
//
// Ordering by startDate descending is deliberate: in-match sub-markets are
// created shortly before the match and closed after it, so the newest markets
// are exactly the live ones. Ordering by id or volume buries them under
// long-running politics and crypto markets.

import { classifyMarket, isTracked } from './classify.mjs';

const GAMMA = 'https://gamma-api.polymarket.com/markets';

/**
 * Page through active markets.
 * @param {object} gamma  config.gamma
 * @param {typeof fetch} [fetchImpl]  injectable for tests
 * @returns {Promise<object[]>} raw Gamma market objects
 */
export async function fetchActiveMarkets(gamma, fetchImpl = fetch) {
  const { pageSize = 100, maxPages = 12, order = 'startDate' } = gamma ?? {};
  const seen = new Map();

  for (let page = 0; page < maxPages; page++) {
    const url = `${GAMMA}?active=true&closed=false&order=${order}` +
      `&ascending=false&limit=${pageSize}&offset=${page * pageSize}`;
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`gamma ${response.status} on page ${page}`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) if (row?.conditionId) seen.set(row.conditionId, row);
    if (rows.length < pageSize) break;
  }
  return [...seen.values()];
}

/**
 * Tracks which markets are live and reports what changed since the last poll,
 * so the book logger can subscribe and unsubscribe instead of resubscribing to
 * everything each round.
 */
export class MarketRegistry {
  #byCondition = new Map();
  /** Event-slug prefixes seen with no discipline mapping, for diagnostics. */
  unknownPrefixes = new Map();

  /**
   * @param {object[]} raw  Gamma market objects
   * @param {Record<string,string>} disciplines
   * @returns {{added: object[], removed: object[], tracked: object[]}}
   */
  update(raw, disciplines) {
    const next = new Map();
    for (const market of raw) {
      const record = classifyMarket(market, disciplines);
      if (!record.sport && record.prefix) {
        this.unknownPrefixes.set(record.prefix, (this.unknownPrefixes.get(record.prefix) ?? 0) + 1);
      }
      if (isTracked(record)) next.set(record.conditionId, record);
    }

    const added = [...next.values()].filter((r) => !this.#byCondition.has(r.conditionId));
    const removed = [...this.#byCondition.values()].filter((r) => !next.has(r.conditionId));
    this.#byCondition = next;
    return { added, removed, tracked: [...next.values()] };
  }

  get size() {
    return this.#byCondition.size;
  }

  tracked() {
    return [...this.#byCondition.values()];
  }

  /** Every asset id under subscription, two per market. */
  assetIds() {
    return [...this.#byCondition.values()].flatMap((r) => r.tokens);
  }

  conditionOf(assetId) {
    for (const record of this.#byCondition.values()) {
      if (record.tokens.includes(assetId)) return record.conditionId;
    }
    return null;
  }
}
