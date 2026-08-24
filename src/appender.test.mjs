// Proves the append queue keeps frame order even when writes finish out of order.
//   node src/appender.test.mjs
import assert from 'node:assert/strict';
import { appender } from './appender.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Writes deliberately take longer the earlier they are enqueued: unqueued, the
// last would land first.
const written = [];
const delays = [40, 30, 20, 10, 0];
const slowWrite = async (text) => {
  await delay(delays[Number(text)]);
  written.push(text);
};

const append = appender('test.csv', slowWrite);
const pending = delays.map((_, i) => append(String(i)));
await Promise.all(pending);

assert.deepEqual(written, ['0', '1', '2', '3', '4'], 'writes land in the order enqueued');

// Without the queue the same writes would come back reversed — check the fixture
// really is adversarial, otherwise the test above proves nothing.
const raced = [];
await Promise.all(delays.map(async (ms, i) => {
  await delay(ms);
  raced.push(String(i));
}));
assert.deepEqual(raced, ['4', '3', '2', '1', '0'], 'unqueued writes do reorder');

// A failing write must not wedge the queue or reject into the frame handler.
const flaky = [];
const failOnce = async (text) => {
  if (text === 'boom') throw new Error('disk full');
  flaky.push(text);
};
const guarded = appender('test.csv', failOnce);
await Promise.all([guarded('a'), guarded('boom'), guarded('b')]);
assert.deepEqual(flaky, ['a', 'b'], 'the queue survives a failed write');

console.log('all appender tests passed');
