// A tiny store written through the collector's own Store, for the export tests.
//
//     node fixture.mjs <directory>
//
// Hand-writing the schema in the test would defeat the point: the bug being
// guarded against is a column list drifting from the thing it describes, and a
// second copy of the schema is one more list to drift.

import { Store } from './src/pm/store.mjs';
import { FILL_CONTEXT_COLUMNS } from './src/pm/fill-context.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node fixture.mjs <directory>');

const DAY = '2026-09-03';
const store = new Store(dir, { flushMs: 1e9, now: () => new Date(`${DAY}T12:00:00Z`) });
const at = (seconds) => new Date(Date.parse(`${DAY}T12:00:00Z`) + seconds * 1000).toISOString();

const market = {
  conditionId: 'cond-1', tokens: ['tok-a', 'tok-b'],
  question: 'Will Team A win map 2?', slug: 'a-b-map-2', eventSlug: 'csgo-a-b',
  eventTitle: 'A vs B', sport: 'esports_counter_strike', level: 'segment', kind: 'winner',
  segmentKind: 'map', segmentNo: 2, line: null, teams: ['A', 'B'],
  outcomes: ['Yes', 'No'], endDate: `${DAY}T18:00:00Z`, tickSize: 0.01, minSize: 5,
};
store.upsertMarket(market, at(0), {
  gameStart: Date.parse(`${DAY}T11:30:00Z`), subscribedAt: at(-3600),
  releasedAt: null, releaseReason: null, observedDuringGame: 1,
});

// Two snapshots before the sweep and three after, on both tokens. The twin is
// what makes fair_lower_bound answerable, so it has to be here.
for (const [offset, bid, pairedAsk] of [[-30, 0.07, 0.84], [-5, 0.06, 0.85],
                                        [30, 0.02, 0.85], [90, 0.04, 0.86],
                                        [600, 0.05, 0.86]]) {
  store.add('book', [at(offset), 'tok-a', 'cond-1', 'heartbeat', bid, bid + 0.01,
    bid + 0.005, 400, 250, 120, 60, 900, 800, 4, 0.01,
    1 - pairedAsk - 0.02, pairedAsk, (1 - pairedAsk + bid) / 2, bid + (1 - pairedAsk - 0.02),
    3.5]);
  store.add('book', [at(offset), 'tok-b', 'cond-1', 'heartbeat', 1 - pairedAsk - 0.02,
    pairedAsk, pairedAsk - 0.01, 100, 100, 100, 100, 500, 500, 3, 0.02,
    bid, bid + 0.01, 0.5, 1, 3.5]);
}

const sweepId = 'tok-a:' + at(0);
store.add('sweeps', [
  at(0), 'tok-a', 'cond-1', 'bid_drop', 0.06, 0.02, 640, 3, 900, 260,
  5, 180, 6,
  sweepId, null, null, null, null,
  'tok-b', 0.13, 0.85, 320, 0.15, 0.87, 0.51, 0.15, 7.5, 4.2,
]);
for (const [horizon, high, frozen] of [[1, 0.02, 1], [5, 0.04, 0], [15, 0.05, 0]]) {
  store.add('sweep_followups', [sweepId, 'tok-a', 'cond-1', horizon, high, at(900), 0, frozen]);
}

// A sweep the significance filter must drop, so the test can tell the filter
// from an empty export.
store.add('sweeps', [at(120), 'tok-a', 'cond-1', 'bid_drop', 0.02, 0.01, 10, 1, 40, 30,
  1, 0, 2, 'tok-a:' + at(120), null, null, null, null,
  'tok-b', 0.13, 0.85, 320, 0.15, 0.87, 0.51, 0.15, 7.5, 4.2]);

const wallet = '0xd403596d8690210994e7f4bae6b9dac1b7e4a817';
store.add('trades', [at(45), 'cond-1', 'tok-a', wallet, 'BUY', 0.02, 500, 'maker', '0xtx1']);
store.add('trades', [at(700), 'cond-1', 'tok-a', wallet, 'SELL', 0.05, 500, 'taker', '0xtx2']);

const context = {
  fill_ts: at(45), asset_id: 'tok-a', condition_id: 'cond-1', wallet, side: 'BUY',
  price: 0.02, size: 500, fill_index: 1,
  bid_t_minus_60: null, bid_t_minus_10: null, bid_t_minus_1: 0.02, ask_t_minus_1: 0.03,
  size_at_002_before: 250, depth_before: 260,
  paired_bid_before: 0.13, fair_lower_bound_before: 0.15, book_sum_before: 0.15,
  bid_plus_60: 0.04, bid_plus_300: 0.05, bid_plus_900: 0.05,
  matched_sweep_id: sweepId, snapshot_available: 1, filled_at: at(950),
};
store.add('fill_context', FILL_CONTEXT_COLUMNS.map((name) => context[name]));

store.add('universe', [at(0), 'cond-1', 'gamma', 1, null, null, market.question,
  'esports_counter_strike',
  'segment', 'winner']);
store.add('gaps', [at(300), at(310), 10_000, 'socket closed', 2]);

store.flush();
store.close();
process.stdout.write(`${dir}/pm-${DAY}.sqlite\n`);
