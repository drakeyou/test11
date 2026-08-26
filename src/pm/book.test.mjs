// Book state and sweep detection.
// Replays the recorded frames for invariants, then builds collapses by hand,
// because a liquid book over a 45-second capture never actually collapses.
//   node src/pm/book.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BookState, SweepDetector } from './book.mjs';
import { DEFAULTS } from './config.mjs';

const sweepConfig = DEFAULTS.sweep;

// --- price_change semantics -------------------------------------------------
const book = new BookState('a1', { conditionId: 'c1', tickSize: 0.01 });
book.applyBook({
  market: 'c1', timestamp: '1',
  bids: [{ price: '0.01', size: '3000' }, { price: '0.05', size: '400' }, { price: '0.30', size: '50' }],
  asks: [{ price: '0.40', size: '20' }],
  tick_size: '0.01',
});
assert.equal(book.bestBid, 0.3);
assert.equal(book.bestAsk, 0.4);
assert.equal(book.sizeAt(0.01), 3000);
assert.equal(book.sizeAt(0.02), 0, 'an empty level is zero, not undefined');

// size is the new resting amount at that price, not a delta
book.applyPriceChange({ asset_id: 'a1', price: '0.01', size: '1500', side: 'BUY' }, '2');
assert.equal(book.sizeAt(0.01), 1500, 'the level is replaced, not decremented');
book.applyPriceChange({ asset_id: 'a1', price: '0.30', size: '0', side: 'BUY' }, '3');
assert.equal(book.bestBid, 0.05, 'a zero size removes the level');
book.applyPriceChange({ asset_id: 'a1', price: '0.45', size: '10', side: 'SELL' }, '4');
assert.equal(book.bestAsk, 0.4, 'a worse ask does not become the best');

// "0.1" and "0.10" are the same level
const canonical = new BookState('a2');
canonical.applyBook({ bids: [{ price: '0.1', size: '10' }], asks: [] });
canonical.applyPriceChange({ price: '0.10', size: '25', side: 'BUY' }, '1');
assert.equal(canonical.sizeAt(0.1), 25, 'price keys are canonical');

// Fresh markets are seeded with an identical bootstrap ladder, so two books
// legitimately read the same. Prove that is the data and not shared state.
const one = new BookState('one');
const two = new BookState('two');
one.applyBook({ bids: [{ price: '0.01', size: '3000' }], asks: [] });
two.applyBook({ bids: [{ price: '0.01', size: '3000' }], asks: [] });
assert.equal(one.sizeAt(0.01), two.sizeAt(0.01), 'seeded books match');
one.applyPriceChange({ price: '0.01', size: '10', side: 'BUY' }, '1');
assert.equal(one.sizeAt(0.01), 10);
assert.equal(two.sizeAt(0.01), 3000, 'the books hold separate state');

// --- sweep rules ------------------------------------------------------------
/** Book with bids at the given [price, size] pairs. */
function bookWith(levels, tickSize = 0.01) {
  const state = new BookState('s1', { conditionId: 'c1', tickSize });
  state.applyBook({
    bids: levels.map(([price, size]) => ({ price: String(price), size: String(size) })),
    asks: [{ price: '0.9', size: '100' }],
  });
  return state;
}

/** Apply `mutate` and ask the detector what it saw. */
function collapse(detector, state, mutate, ts = '2026-08-25T12:00:00.000Z') {
  const before = SweepDetector.snapshot(state, sweepConfig.depthAbovePrice);
  mutate(state);
  return detector.observe(state, before, ts);
}

// A quiet book produces nothing.
const quiet = new SweepDetector(sweepConfig);
assert.equal(collapse(quiet, bookWith([[0.3, 100], [0.2, 100], [0.1, 100]]), () => {}), null);

// One tick down is not a sweep.
const oneTick = new SweepDetector(sweepConfig);
assert.equal(collapse(oneTick, bookWith([[0.3, 100], [0.29, 100]]),
  (s) => s.applyPriceChange({ price: '0.30', size: '0', side: 'BUY' }, '1')), null,
  'a single tick is noise, not a collapse');

// The book eaten down to a cent fires both rules.
const detector = new SweepDetector(sweepConfig);
const swept = collapse(detector, bookWith([[0.3, 100], [0.25, 80], [0.2, 60], [0.02, 500], [0.01, 900]]),
  (s) => {
    for (const price of ['0.30', '0.25', '0.20']) {
      s.applyPriceChange({ price, size: '0', side: 'BUY' }, '1');
    }
  });
assert.ok(swept, 'a collapse to 2 cents is detected');
const [, assetId, conditionId, rule, bidBefore, bidAfter, consumed, levels] = swept;
assert.equal(assetId, 's1');
assert.equal(conditionId, 'c1');
assert.equal(bidBefore, 0.3);
assert.equal(bidAfter, 0.02, 'the surviving best bid is recorded');
assert.equal(levels, 3, 'three levels stood above the new best bid');
assert.equal(consumed, 240, 'consumed size is the sum of what stood there');
assert.match(rule, /bid_drop/);
assert.match(rule, /levels/, 'both rules fired and both are recorded');

// The tick is per-market: on a 0.001 book three ticks is 0.003, under the floor.
const fine = new SweepDetector(sweepConfig);
assert.equal(collapse(fine, bookWith([[0.3, 100], [0.297, 100]], 0.001),
  (s) => s.applyPriceChange({ price: '0.300', size: '0', side: 'BUY' }, '1')), null,
  'three ticks of a 0.001 book stays below the absolute floor');

// Same drop on a 0.01 book is a real move.
const coarse = new SweepDetector(sweepConfig);
assert.ok(collapse(coarse, bookWith([[0.3, 100], [0.27, 100]], 0.01),
  (s) => s.applyPriceChange({ price: '0.30', size: '0', side: 'BUY' }, '1')),
  'the same absolute drop on a 0.01 book is a sweep');

// Depth collapse fires even when the best bid barely moves — the sweep that
// stops short of a cent is exactly the denominator of the fill rate.
const depth = new SweepDetector(sweepConfig);
const thinned = collapse(depth, bookWith([[0.3, 1000], [0.2, 1000], [0.06, 1000]]),
  (s) => {
    s.applyPriceChange({ price: '0.20', size: '0', side: 'BUY' }, '1');
    s.applyPriceChange({ price: '0.06', size: '0', side: 'BUY' }, '1');
  });
assert.ok(thinned, 'losing most of the depth above 5c is a sweep');
assert.match(thinned[3], /depth_collapse/);

// --- what a first day of real collection actually logged --------------------
// 617k "sweeps" over one day, from three causes. Each is pinned here.

// 1. Thin books blink empty as the maker repositions. Every level counts as
//    eaten, but there was nothing there to eat.
const blink = new SweepDetector(sweepConfig);
assert.equal(collapse(blink, bookWith([[0.30, 5], [0.20, 3], [0.10, 2]]),
  (s) => {
    for (const price of ['0.30', '0.20', '0.10']) {
      s.applyPriceChange({ price, size: '0', side: 'BUY' }, '1');
    }
  }), null, 'an empty book with no size behind it is not a collapse');

// 2. A book already at a cent has nothing left to collapse.
const alreadyLow = new SweepDetector(sweepConfig);
assert.equal(collapse(alreadyLow, bookWith([[0.03, 5000], [0.02, 5000], [0.01, 5000]]),
  (s) => {
    s.applyPriceChange({ price: '0.03', size: '0', side: 'BUY' }, '1');
    s.applyPriceChange({ price: '0.02', size: '0', side: 'BUY' }, '1');
  }), null, 'a move from three cents to one is not the event under study');

// 3. One collapse arrives as a burst of updates, and was logged on each.
const burst = new SweepDetector(sweepConfig);
const first = collapse(burst, bookWith([[0.30, 500], [0.25, 500], [0.20, 500], [0.01, 900]]),
  (s) => {
    for (const price of ['0.30', '0.25', '0.20']) {
      s.applyPriceChange({ price, size: '0', side: 'BUY' }, '1');
    }
  }, '2026-08-25T12:00:00.000Z');
assert.ok(first, 'the collapse itself is logged');

const echo = bookWith([[0.10, 400], [0.05, 400], [0.01, 900]]);
assert.equal(collapse(burst, echo, (s) => {
  s.applyPriceChange({ price: '0.10', size: '0', side: 'BUY' }, '1');
  s.applyPriceChange({ price: '0.05', size: '0', side: 'BUY' }, '1');
}, '2026-08-25T12:00:05.000Z'), null, 'the same event seconds later is not a second event');

// Once the cooldown has passed, a genuine second collapse is logged again.
const later = bookWith([[0.30, 500], [0.25, 500], [0.20, 500], [0.01, 900]]);
assert.ok(collapse(burst, later, (s) => {
  for (const price of ['0.30', '0.25', '0.20']) {
    s.applyPriceChange({ price, size: '0', side: 'BUY' }, '1');
  }
}, '2026-08-25T12:01:00.000Z'), 'a later collapse is a separate event');

// Depth collapse needs depth worth collapsing.
const trivial = new SweepDetector(sweepConfig);
assert.equal(collapse(trivial, bookWith([[0.30, 6], [0.20, 5], [0.06, 4]]),
  (s) => {
    s.applyPriceChange({ price: '0.20', size: '0', side: 'BUY' }, '1');
    s.applyPriceChange({ price: '0.06', size: '0', side: 'BUY' }, '1');
  }), null, 'losing half of nothing is not a depth collapse');

// --- replay of the recorded frames -----------------------------------------
const frames = JSON.parse(readFileSync('samples-pm/ws-frames.json', 'utf8'));
assert.ok(frames.length > 100, 'fixture has frames to replay');
const live = new BookState(frames[0].msg.asset_id, {});
for (const { msg } of frames) {
  if (msg.event_type === 'book') live.applyBook(msg);
  else if (msg.event_type === 'price_change') {
    for (const entry of msg.price_changes) live.applyPriceChange(entry, msg.timestamp);
  }
}
const row = live.metrics('2026-08-25T12:00:00Z', 'heartbeat');
assert.equal(row.length, 15, 'a metrics row matches the book table');
assert.equal(row[1], frames[0].msg.asset_id);
assert.ok(row[4] > 0 && row[5] > row[4], `bid ${row[4]} below ask ${row[5]}`);
assert.ok(row[13] > 1, 'the replayed book has depth');
assert.ok(row[11] > 0, 'total bid depth is positive');
assert.equal(row[14], row[5] - row[4], 'spread is ask minus bid');
assert.equal(live.tickSize, 0.01, 'tick size is taken from the book message');

console.log(`replayed ${frames.length} frames: bid ${row[4]} / ask ${row[5]}, ${row[13]} bid levels`);
console.log('all book tests passed');
