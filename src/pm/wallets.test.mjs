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

const [row] = await fetchActivity('0xabc', {}, ok([sample]));
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

assert.deepEqual(await fetchActivity('0xabc', {}, ok({ error: 'nope' })), [],
  'an unexpected body is empty, not a crash');
await assert.rejects(() => fetchActivity('0xabc', {}, async () => ({ ok: false, status: 429 })),
  /activity 429/, 'a refused poll is reported');

console.log('all wallet tests passed');
