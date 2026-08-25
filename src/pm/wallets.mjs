// Module D — target wallet activity.
//
// Optional, but it is the only source of labelled examples: a fill can be lined
// up against the book snapshot from the second before it, which turns the book
// log from a description into ground truth.
//
// The activity endpoint pages out at roughly 5500 records, so this is a forward
// recorder only — it is not a backfill and must not be relied on as history.
// There is also no id on a record, so one is composed from the fields that
// together identify a fill.

const ACTIVITY = 'https://data-api.polymarket.com/activity';

/** Records carry no id, so build one that is stable across re-polls. */
export const activityId = (row) =>
  [row.transactionHash, row.asset, row.side, row.size, row.price].join('|');

/**
 * @param {string} address
 * @param {{limit?: number}} [options]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object[]>} rows for the `wallets` table
 */
export async function fetchActivity(address, { limit = 100 } = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${ACTIVITY}?user=${address}&limit=${limit}`);
  if (!response.ok) throw new Error(`activity ${response.status} for ${address}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) return [];

  return rows.map((row) => [
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
}
