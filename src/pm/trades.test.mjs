// Role recovery: the API exposes it only as the difference between two calls.
//   node src/pm/trades.test.mjs
import assert from 'node:assert/strict';
import { fetchTrades, tradeKey } from './trades.mjs';

const trade = (over = {}) => ({
  transactionHash: '0xtx1', proxyWallet: '0xWALLET', asset: 'a1', side: 'BUY',
  size: 200, price: 0.02, timestamp: 1787672125, conditionId: '0xc1', ...over,
});

const aggressive = trade({ transactionHash: '0xtx2', proxyWallet: '0xother', price: 0.5 });

/** Serve the two pages the role is derived from. */
const server = (takers, all) => async (url) =>
  ({ ok: true, json: async () => (url.includes('takerOnly=true') ? takers : all) });

const { rows, takerShare } = await fetchTrades('0xc1', {}, server([aggressive], [trade(), aggressive]));
assert.equal(takerShare, 0.5, 'the taker share is measured, not inferred from missing rows');
assert.equal(rows.length, 2, 'every fill is reported, not just the passive ones');

const [passive, taken] = rows;
assert.equal(passive[7], 'maker', 'a fill absent from the taker page was filled passively');
assert.equal(taken[7], 'taker');
assert.equal(passive[0], new Date(1787672125000).toISOString());
assert.equal(passive[2], 'a1');
assert.equal(passive[3], '0xwallet', 'wallets are lowercased so they can be compared');
assert.equal(passive[5], 0.02);
assert.equal(passive[6], 200);

// The two pages are fetched separately, so a fill differing only in size or
// price must not be mistaken for the same one.
assert.notEqual(tradeKey(trade()), tradeKey(trade({ size: 201 })));
assert.notEqual(tradeKey(trade()), tradeKey(trade({ price: 0.03 })));
assert.equal(tradeKey(trade()), tradeKey(trade()));

// One transaction can fill several orders; each keeps its own role.
const split = [trade({ asset: 'a1' }), trade({ asset: 'a2' })];
const mixed = await fetchTrades('0xc1', {}, server([split[1]], split));
assert.deepEqual(mixed.rows.map((r) => r[7]), ['maker', 'taker'],
  'roles are per fill, not per transaction');

// Everything passive is the expected shape for the wallet under study.
const allPassive = await fetchTrades('0xc1', {}, server([], [trade(), trade({ asset: 'a2' })]));
assert.ok(allPassive.rows.every((r) => r[7] === 'maker'));
assert.equal(allPassive.takerShare, 0, 'no taker fills is a measurement of zero, not an absence');

// A market busier than one page must not read as a complete log.
const busy = [...Array(5)].map((_, i) => trade({ transactionHash: `0x${i}` }));
const offsets = [];
const pagedServer = async (url) => {
  const offset = Number(new URL(url).searchParams.get('offset'));
  if (url.includes('takerOnly=true')) return { ok: true, json: async () => [] };
  offsets.push(offset);
  return { ok: true, json: async () => busy.slice(offset, offset + 2) };
};
const walked = await fetchTrades('0xc1', { limit: 2 }, pagedServer);
assert.equal(walked.rows.length, 5, 'every page of the log is read');
assert.deepEqual([...new Set(offsets)], [0, 2, 4]);
assert.equal(walked.truncated, false);

// An ignored offset returns the same page forever — the failure that makes
// Gamma's condition_id filter dangerous. Stop and flag it.
const ignoring = async () => ({ ok: true, json: async () => [trade(), trade({ asset: 'a2' })] });
const stuck = await fetchTrades('0xc1', { limit: 2, maxPages: 50 }, ignoring);
assert.ok(stuck.pages < 5, `stops instead of spinning, took ${stuck.pages} pages`);
assert.equal(stuck.truncated, true, 'a log that could not be walked is flagged short');

await assert.rejects(() => fetchTrades('0xc1', {}, async () => ({ ok: false, status: 403 })),
  /trades 403/, 'a refused page is reported rather than silently halving the data');

console.log('all trade tests passed');
