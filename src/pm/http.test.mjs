// Polite fetching, including the failure that takes a laptop's network with it.
//   node src/pm/http.test.mjs
import assert from 'node:assert/strict';
import { politeFetch, throttle } from './http.mjs';

const reply = (status) => ({ ok: status >= 200 && status < 300, status });

// A rate limit is retried and eventually succeeds.
let calls = 0;
const limited = async () => (++calls < 3 ? reply(429) : reply(200));
assert.equal((await politeFetch('u', { backoffMs: 1, fetchImpl: limited })).ok, true);
assert.equal(calls, 3);

// A refusal that is not the server's fault is returned at once, not retried.
calls = 0;
const forbidden = async () => { calls++; return reply(403); };
assert.equal((await politeFetch('u', { backoffMs: 1, fetchImpl: forbidden })).status, 403);
assert.equal(calls, 1, '403 is an answer, not a hiccup');

// A lost network does not answer with a status: fetch rejects outright. Before
// this was handled, a laptop going to sleep took the collector down with it.
calls = 0;
const asleep = async () => {
  if (++calls < 3) throw new TypeError('fetch failed');
  return reply(200);
};
assert.equal((await politeFetch('u', { backoffMs: 1, fetchImpl: asleep })).ok, true,
  'the connection coming back is enough to recover');
assert.equal(calls, 3);

// If it never comes back, the error surfaces rather than a null response.
calls = 0;
const gone = async () => { calls++; throw new TypeError('fetch failed'); };
await assert.rejects(() => politeFetch('u', { retries: 2, backoffMs: 1, fetchImpl: gone }),
  /fetch failed/);
assert.equal(calls, 3, 'every attempt is spent before giving up');

// Backoff is capped, so a long outage does not schedule an absurd wait.
const started = Date.now();
await assert.rejects(() => politeFetch('u',
  { retries: 3, backoffMs: 1000, maxBackoffMs: 5, fetchImpl: gone }), /fetch failed/);
assert.ok(Date.now() - started < 500, 'the cap is honoured');

// The pacer spaces calls without blocking the first one.
const pace = throttle(40);
const first = Date.now();
await pace();
assert.ok(Date.now() - first < 20, 'the first call does not wait');
await pace();
assert.ok(Date.now() - first >= 35, 'the second waits its turn');

console.log('all http tests passed');
