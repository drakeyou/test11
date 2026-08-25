// Discovery tests with an injected fetch, so pagination and the subscription
// diff are checked without touching the network.
//   node src/pm/gamma.test.mjs
import assert from 'node:assert/strict';
import { fetchActiveMarkets, MarketRegistry } from './gamma.mjs';
import { DEFAULTS } from './config.mjs';

const market = (id, question, eventSlug) => ({
  conditionId: id,
  question,
  slug: id,
  events: [{ slug: eventSlug, title: `Counter-Strike: A vs B (BO3) - Cup` }],
  outcomes: '["A","B"]',
  clobTokenIds: `["${id}-a","${id}-b"]`,
  orderPriceMinTickSize: 0.001,
  orderMinSize: 5,
  enableOrderBook: true,
});

/** Serve `total` markets through pages of `pageSize`, recording the offsets asked for. */
function pagedFetch(total, pageSize, offsets = []) {
  return async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    offsets.push(offset);
    const rows = Array.from({ length: Math.max(0, Math.min(pageSize, total - offset)) },
      (_, i) => market(`c${offset + i}`, `Map 1 Winner ${offset + i}`, 'cs2-a-b-2026-08-25'));
    return { ok: true, json: async () => rows };
  };
}

// A short last page ends the walk; a full one does not.
const offsets = [];
const all = await fetchActiveMarkets({ pageSize: 100, maxPages: 12 }, pagedFetch(250, 100, offsets));
assert.equal(all.length, 250, 'every page is collected');
assert.deepEqual(offsets, [0, 100, 200], 'stops once a page comes back short');

// maxPages caps the walk even when the source keeps serving full pages.
const capped = [];
await fetchActiveMarkets({ pageSize: 100, maxPages: 3 }, pagedFetch(10000, 100, capped));
assert.equal(capped.length, 3, 'maxPages is respected');

// The same market on two pages must not be counted twice.
const dupes = async () => ({ ok: true, json: async () => [market('same', 'Map 1 Winner', 'cs2-a-b')] });
assert.equal((await fetchActiveMarkets({ pageSize: 1, maxPages: 3 }, dupes)).length, 1);

await assert.rejects(
  () => fetchActiveMarkets({ maxPages: 1 }, async () => ({ ok: false, status: 403 })),
  /gamma 403/, 'a refused page is reported, not silently dropped');

// Subscription diff: added and removed are what the book logger acts on.
const registry = new MarketRegistry();
const first = registry.update([
  market('c1', 'Map 1 Winner', 'cs2-a-b-2026-08-25'),
  market('c2', 'Map 2 Winner', 'cs2-a-b-2026-08-25'),
], DEFAULTS.disciplines);
assert.equal(first.added.length, 2);
assert.equal(first.removed.length, 0);
assert.equal(registry.assetIds().length, 4, 'two asset ids per market');

const second = registry.update([
  market('c2', 'Map 2 Winner', 'cs2-a-b-2026-08-25'),
  market('c3', 'Map 3 Winner', 'cs2-a-b-2026-08-25'),
], DEFAULTS.disciplines);
assert.deepEqual(second.added.map((r) => r.conditionId), ['c3'], 'only the new market is added');
assert.deepEqual(second.removed.map((r) => r.conditionId), ['c1'], 'the closed market is removed');
assert.equal(registry.size, 2);
assert.equal(registry.conditionOf('c3-b'), 'c3', 'asset id maps back to its market');
assert.equal(registry.conditionOf('gone'), null);

// A market off our disciplines is skipped, but its prefix is recorded so a new
// sport showing up on Polymarket is visible instead of silently ignored.
registry.update([market('c9', 'Will the Fed cut rates?', 'fed-decision-2026')], DEFAULTS.disciplines);
assert.equal(registry.size, 0);
assert.equal(registry.unknownPrefixes.get('fed'), 1);

console.log('all discovery tests passed');
