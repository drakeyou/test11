// Wallet tests with an injected fetch, shaped on a real activity record.
//   node src/pm/wallets.test.mjs
import assert from 'node:assert/strict';
import { activityId, fetchActivity } from './wallets.mjs';

// A real record, as returned for one of the target wallets.
const sample = {
  proxyWallet: '0xd403596d8690210994e7f4bae6b9dac1b7e4a817',
  timestamp: 1787672125, type: 'TRADE', size: 200, usdcSize: 4, price: 0.02,
  conditionId: '0x3c9b7d57', asset: '68432673', side: 'BUY', outcomeIndex: 1,
  transactionHash: '0xa28c24ce',
  title: 'Counter-Strike: Color vs Butterfly - Map 2 Winner',
};

const ok = (rows) => async () => ({ ok: true, json: async () => rows });

const { rows, types, ceiling } = await fetchActivity('0xabc', {}, ok([sample]));
const [row] = rows;
assert.equal(ceiling, false, 'a short page is the end, not the ceiling');
assert.deepEqual(types, { TRADE: 1 }, 'event types are tallied, REDEEM included');
assert.equal(row[0], new Date(1787672125000).toISOString(), 'the fill is dated by its own timestamp, not by the poll');
assert.equal(row[1], '0xabc');
assert.equal(row[3], 'TRADE');
assert.equal(row[4], 'BUY');
assert.equal(row[5], '68432673');
assert.equal(row[6], '0x3c9b7d57');
assert.equal(row[7], 0.02);
assert.equal(row[8], 200);
assert.equal(row[9], '0xa28c24ce');

// The id has to survive re-polling and still separate two fills in one
// transaction, which is why it is composed rather than the hash alone.
assert.equal(activityId(sample), activityId({ ...sample }), 'the same fill yields the same id');
assert.notEqual(activityId(sample), activityId({ ...sample, price: 0.03 }));
assert.notEqual(activityId(sample), activityId({ ...sample, side: 'SELL' }));

assert.deepEqual((await fetchActivity('0xabc', {}, ok({ error: 'nope' }))).rows, [],
  'an unexpected body is empty, not a crash');

// One page is not a history: a burst of fills pushes older markets out of it,
// and those are exactly the ones missing from the sample.
const many = [...Array(1200)].map((_, i) => ({ ...sample, transactionHash: `0x${i}`, asset: `a${i}` }));
const offsets = [];
const paged = async (url) => {
  const offset = Number(new URL(url).searchParams.get('offset'));
  offsets.push(offset);
  return { ok: true, json: async () => many.slice(offset, offset + 500) };
};
const walked = await fetchActivity('0xabc', { limit: 500 }, paged);
assert.equal(walked.rows.length, 1200, 'every page is collected');
assert.deepEqual(offsets, [0, 500, 1000], 'offset advances by the page size');
assert.equal(walked.ceiling, false);

// The endpoint stops somewhere near 5500 records; say so rather than passing a
// partial history off as a whole one.
const endless = async () => ({ ok: true, json: async () => [...Array(500)].map((_, i) =>
  ({ ...sample, transactionHash: `0x${Math.random()}`, asset: `a${i}` })) });
const capped = await fetchActivity('0xabc', { limit: 500, maxRecords: 1000 }, endless);
assert.equal(capped.ceiling, true, 'hitting the wall is reported');
assert.ok(capped.rows.length >= 1000);

// An ignored offset would otherwise loop forever on the same page.
const stuck = async () => ({ ok: true, json: async () => [sample] });
const looped = await fetchActivity('0xabc', { limit: 1 }, stuck);
assert.equal(looped.rows.length, 1, 'a repeating page ends the walk');
await assert.rejects(() => fetchActivity('0xabc', {}, async () => ({ ok: false, status: 429 })),
  /activity 429/, 'a refused poll is reported');

console.log('all wallet tests passed');
