// What the book did after a sweep, filled from the snapshots already arriving.
//   node src/pm/followups.test.mjs
import assert from 'node:assert/strict';
import { FollowupTracker, sweepIdOf } from './followups.mjs';

const MINUTE = 60 * 1000;
const t0 = Date.parse('2026-08-29T20:15:00Z');

const tracker = new FollowupTracker({ horizons: [1, 5, 15] });
const id = sweepIdOf('asset-1', '2026-08-29T20:15:00.000Z');
assert.equal(id, 'asset-1:2026-08-29T20:15:00.000Z', 'the id is derivable from the sweep row');

// The bid the sweep left behind is the first sample, so a horizon that sees no
// further update still reports a number rather than a null.
tracker.open(id, 'asset-1', 'cond-1', t0, 0.01);
assert.equal(tracker.size, 1);
assert.deepEqual(tracker.due(t0 + 30 * 1000), [], 'nothing is due yet');

// A running maximum, not the last value: the point is what it reached.
tracker.observe('asset-1', 0.04);
tracker.observe('asset-1', 0.02);
tracker.observe('other', 0.99); // a different asset must not leak in

const oneMinute = tracker.due(t0 + MINUTE);
assert.equal(oneMinute.length, 1);
assert.deepEqual(oneMinute[0].slice(0, 5), [id, 'asset-1', 'cond-1', 1, 0.04]);
assert.equal(oneMinute[0][6], 0, 'not resolved before the horizon');
assert.equal(tracker.size, 1, 'the 5 and 15 minute horizons are still open');

// Later highs belong to the later horizons only.
tracker.observe('asset-1', 0.09);
const fiveMinutes = tracker.due(t0 + 5 * MINUTE);
assert.deepEqual(fiveMinutes.map((row) => [row[3], row[4]]), [[5, 0.09]]);

// A market that resolves before the horizon is not a missing measurement.
const resolved = tracker.resolved('cond-1', (assetId) => (assetId === 'asset-1' ? 1 : 0),
  t0 + 6 * MINUTE);
assert.deepEqual(resolved.map((row) => [row[3], row[4], row[6]]), [[15, 1, 1]]);
assert.equal(tracker.size, 0);
assert.deepEqual(tracker.due(t0 + 20 * MINUTE), [], 'a closed sweep is not written twice');

// Dropping a subscription mid-horizon writes what was seen, flagged as its own
// measurement rather than left as a hole.
const cut = new FollowupTracker({ horizons: [5] });
cut.open('s2', 'asset-2', 'cond-2', t0, 0.02);
cut.observe('asset-2', 0.03);
const truncated = cut.forget('asset-2', t0 + 2 * MINUTE);
assert.deepEqual(truncated.map((row) => [row[3], row[4]]), [[5, 0.03]]);
assert.equal(cut.size, 0);
assert.deepEqual(cut.forget('asset-2'), [], 'forgetting twice is not an error');

// A sweep on a book with no bid left starts from null and stays null until the
// book comes back, which is a real answer: nothing bid for fifteen minutes.
const empty = new FollowupTracker({ horizons: [1] });
empty.open('s3', 'asset-3', 'cond-3', t0, null);
assert.equal(empty.due(t0 + MINUTE)[0][4], null);

console.log('all follow-up tests passed');
