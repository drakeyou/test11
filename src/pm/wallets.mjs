// Module D — target wallet activity.
//
// Optional, but it is the only source of labelled examples: a fill can be lined
// up against the book snapshot from the second before it, which turns the book
// log from a description into ground truth.
//
// The endpoint pages out at roughly 5500 records, so for a busy wallet this is
// still not a full history — but it is paginated to that limit rather than
// stopping at the first page, and it says so when it hits the wall. There is no
// id on a record, so one is composed from the fields that identify a fill.

import { politeFetch, throttle } from './http.mjs';

const ACTIVITY = 'https://data-api.polymarket.com/activity';

const pace = throttle(350);

/** Records carry no id, so build one that is stable across re-polls. */
export const activityId = (row) =>
  [row.transactionHash, row.asset, row.side, row.size, row.price].join('|');

/**
 * Walk a wallet's activity.
 *
 * One page is not the history. A burst of esports fills pushes older markets
 * out of a short window, and the markets that fall out are exactly the ones
 * that make the sample look narrower than the wallet's actual behaviour.
 *
 * The endpoint stops paginating somewhere near 5500 records, so a wallet busier
 * than that cannot be read to the end here — `ceiling` says when that happened
 * rather than letting a partial history pass as a whole one.
 *
 * @param {string} address
 * @param {{limit?: number, maxRecords?: number}} [options]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{rows: Array, types: object, ceiling: boolean, pages: number}>}
 */
export async function fetchActivity(address, { limit = 500, maxRecords = 5500 } = {}, fetchImpl = fetch) {
  const seen = new Set();
  const raw = [];
  const types = {};
  let pages = 0;
  let ceiling = false;

  while (raw.length < maxRecords) {
    await pace();
    const response = await politeFetch(
      `${ACTIVITY}?user=${address}&limit=${limit}&offset=${pages * limit}`, { fetchImpl });
    if (!response.ok) throw new Error(`activity ${response.status} for ${address}`);
    const page = await response.json();
    pages++;
    if (!Array.isArray(page) || page.length === 0) break;

    let added = 0;
    for (const row of page) {
      const id = activityId(row);
      if (seen.has(id)) continue;
      seen.add(id);
      raw.push(row);
      types[row.type ?? 'unknown'] = (types[row.type ?? 'unknown'] ?? 0) + 1;
      added++;
    }
    // An ignored offset would return the same page indefinitely.
    if (added === 0) break;
    if (page.length < limit) break;
    if (raw.length >= maxRecords) ceiling = true;
  }

  const rows = raw.map((row) => [
    new Date((Number(row.timestamp) || 0) * 1000).toISOString(),
    address,
    activityId(row),
    row.type ?? null,
    row.side ?? null,
    row.asset ?? null,
    row.conditionId ?? null,
    Number(row.price),
    Number(row.size),
    row.transactionHash ?? null,
  ]);

  return { rows, types, ceiling, pages };
}
