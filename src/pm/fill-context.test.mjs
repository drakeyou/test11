// The book around a wallet fill, assembled from stored snapshots.
//   node src/pm/fill-context.test.mjs
import assert from 'node:assert/strict';
import { FILL_CONTEXT_COLUMNS, FillContextQueue, contextRow } from './fill-context.mjs';

const t0 = Date.parse('2026-09-02T12:00:00.000Z');
const iso = (at) => new Date(at).toISOString();
const fill = {
  ts: iso(t0), assetId: 'tok', conditionId: 'cond', wallet: '0xw',
  side: 'BUY', price: 0.02, size: 500,
};

// --- the queue ---------------------------------------------------------------
// A fill is found by polling, tens of seconds after it happened, and the
// fifteen minutes after it have not happened yet. So it waits.
// The clock is passed in everywhere: `add` refuses fills older than a day, and
// a fixture dated in the past would start failing the moment the calendar moved
// past it.
const queue = new FillContextQueue();
assert.equal(queue.add(fill, t0), true);
assert.equal(queue.add({ ...fill }, t0), false, 'the same fill is queued once');
assert.equal(queue.size, 1);
assert.deepEqual(queue.due(t0 + 14 * 60_000), [], 'not before its horizons have passed');
assert.equal(queue.due(t0 + 15 * 60_000).length, 1);
assert.equal(queue.size, 0, 'and it leaves the queue when written');
assert.equal(queue.add({ ...fill, ts: 'not a date' }, t0), false,
  'an undated fill is not queued');

// The trade log answers with history, not with news: a first poll returns days
// of fills. Writing those up gives a row per fill saying nobody was watching,
// which is true because the collector did not exist yet, and buries the fills
// that can be answered.
const recent = new FillContextQueue({ maxAgeHours: 24 });
assert.equal(recent.add({ ...fill, ts: iso(t0 - 3 * 3600_000) }, t0), true, 'three hours back');
assert.equal(recent.add({ ...fill, ts: iso(t0 - 30 * 3600_000) }, t0), false, 'thirty is history');

const held = new FillContextQueue();
held.add(fill, t0);
assert.equal(held.drain().length, 1, 'shutdown writes up what it can');
assert.equal(held.size, 0);

// --- the row -----------------------------------------------------------------
// A watched book is heartbeated every five seconds, so the snapshots are a
// dense series. This one holds at 30 cents, is swept to 2 just before the fill,
// and recovers over the quarter hour after it.
const bidAt = (offset) => {
  if (offset < -6) return 0.30;
  if (offset < 30) return 0.02;
  if (offset < 120) return 0.05;
  if (offset < 600) return 0.12;
  return 0.18;
};
const snapshots = [];
for (let offset = -120; offset <= 900; offset += 5) {
  snapshots.push({
    ts: iso(t0 + offset * 1000),
    best_bid: bidAt(offset),
    best_ask: 0.33,
    size_at_002: offset < -6 ? 120 : 1500,
    depth_bid_total: offset < -6 ? 3800 : 1500,
    paired_bid: 0.66,
    paired_ask: 0.70,
    book_sum: Math.round((bidAt(offset) + 0.66) * 100) / 100,
  });
}

const store = {
  bookAt(assetId, ts) {
    if (assetId !== 'tok') return null;
    return [...snapshots].reverse().find((row) => row.ts <= ts) ?? null;
  },
  sweepBefore: (assetId, ts, since) => (assetId === 'tok' ? 'tok:swept' : null),
  sawBook: (assetId) => assetId === 'tok',
  fillOrdinal: () => 3,
};

const row = contextRow({ ...fill, at: t0 }, store, t0 + 15 * 60_000);
const named = Object.fromEntries(FILL_CONTEXT_COLUMNS.map((name, i) => [name, row[i]]));
assert.equal(row.length, FILL_CONTEXT_COLUMNS.length, 'the row matches the table');
assert.equal(named.fill_ts, fill.ts);
assert.equal(named.fill_index, 3, 'read back from what is stored, not counted in memory');
assert.equal(named.bid_t_minus_60, 0.30, 'the book a minute before the fill');
assert.equal(named.bid_t_minus_10, 0.30, 'still there ten seconds before');
assert.equal(named.bid_t_minus_1, 0.02, 'swept to two cents just before being filled');
assert.equal(named.size_at_002_before, 1500);
assert.equal(named.depth_before, 1500);
// The twin token says the market still prices this at 0.30 while the fill went
// off at 0.02 — the whole point of recording the pair.
assert.equal(named.paired_bid_before, 0.66);
assert.equal(named.fair_lower_bound_before, 0.30);
assert.equal(named.book_sum_before, 0.68);
assert.equal(named.bid_plus_60, 0.05, 'and what it recovered to');
assert.equal(named.bid_plus_300, 0.12);
assert.equal(named.bid_plus_900, 0.18);
assert.equal(named.matched_sweep_id, 'tok:swept');
assert.equal(named.snapshot_available, 1);

// A market nobody was watching: every measurement is empty, and the flag is
// what tells that apart from a market that was watched and simply had no book.
const blind = contextRow({ ...fill, assetId: 'unwatched', at: t0 }, {
  bookAt: () => null, sweepBefore: () => null, sawBook: () => false, fillOrdinal: () => 1,
}, t0);
const dark = Object.fromEntries(FILL_CONTEXT_COLUMNS.map((name, i) => [name, blind[i]]));
assert.equal(dark.snapshot_available, 0);
assert.equal(dark.bid_t_minus_1, null);
assert.equal(dark.fair_lower_bound_before, null);
assert.equal(dark.matched_sweep_id, null);

// A stale snapshot is not a sample. The newest row at or before t-60 on an
// unwatched market can be hours old and would read as a live quote.
const stale = contextRow({ ...fill, at: t0 }, {
  ...store,
  bookAt: (assetId, ts) => ({ ts: iso(t0 - 6 * 3600_000), best_bid: 0.5, best_ask: 0.6,
    size_at_002: 1, depth_bid_total: 1, paired_bid: null, paired_ask: null, book_sum: null }),
}, t0);
const old = Object.fromEntries(FILL_CONTEXT_COLUMNS.map((name, i) => [name, stale[i]]));
assert.equal(old.bid_t_minus_60, null, 'six hours old is not "a minute before"');
assert.equal(old.bid_t_minus_1, null);
assert.equal(old.bid_plus_60, null, 'and a row predating the fill is not "after" it');

console.log('all fill-context tests passed');
