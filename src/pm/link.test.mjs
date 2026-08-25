// Join tests. The direction of the fair value is the dangerous part: getting it
// backwards is silent and inverts every dislocation figure, so it is checked
// from both sides.
//   node src/pm/link.test.mjs
import assert from 'node:assert/strict';
import { buildLinks, joinedRow } from './link.mjs';

const at = Date.parse('2026-08-25T18:00:00Z');

const pmMarket = {
  conditionId: '0xC1',
  teams: ['ex-Sangal ALTERS', 'Passion Academy'],
  outcomes: ['ex-Sangal ALTERS', 'Passion Academy'],
  tokens: ['tokenA', 'tokenB'],
  level: 'segment', kind: 'winner', segmentKind: 'map', segmentNo: 1,
  endDate: '2026-08-25T18:00:00Z',
};

const ggbetMarket = {
  matchId: 'gg1', market: 'Карта 1 - победитель', sport: 'esports_counter_strike',
  teams: ['ex-Sangal ALTERS', 'Passion Academy'], updatedAt: at,
  score: '1:0', segmentScore: '9:5', fair: 0.7, active: true,
  selections: [{ name: 'ex-Sangal ALTERS', price: 1.42 }, { name: 'Passion Academy', price: 3.3 }],
};

// --- linking ----------------------------------------------------------------
const links = buildLinks({ markets: [pmMarket], ggbetMarkets: [ggbetMarket], mapping: null, now: at });
assert.equal(links.size, 2, 'both tokens of a market are linked');
assert.equal(links.get('tokenA').complement, false, 'the first token follows the first selection');
assert.equal(links.get('tokenB').complement, true, 'the second token takes the complement');

// The same market with the competitors listed the other way round must still
// link, and the direction must flip with it.
const mirrored = buildLinks({
  markets: [{ ...pmMarket, outcomes: ['Passion Academy', 'ex-Sangal ALTERS'], teams: ['Passion Academy', 'ex-Sangal ALTERS'] }],
  ggbetMarkets: [ggbetMarket], mapping: null, now: at,
});
assert.equal(mirrored.get('tokenA').complement, true, 'a reversed listing reverses the side');

// A market at the wrong level must not link at all.
const wrongLevel = buildLinks({
  markets: [pmMarket],
  ggbetMarkets: [{ ...ggbetMarket, market: 'Победитель' }],
  mapping: null, now: at,
});
assert.equal(wrongLevel.size, 0, 'the match winner does not answer a map-1 question');

// --- the mapping table ------------------------------------------------------
const proposed = [];
const mapping = {
  get: () => null,
  propose: (row) => { proposed.push(row); return true; },
};
buildLinks({ markets: [pmMarket], ggbetMarkets: [ggbetMarket], mapping, now: at });
assert.equal(proposed.length, 1, 'an automatic match is offered for confirmation');
assert.equal(proposed[0].ggbetMatchId, 'gg1');
assert.equal(proposed[0].pmSegment, 'map1');

// A verified row wins even when the names would never have matched.
const stubborn = {
  get: () => ({ verified: true, ggbet_match_id: 'gg1', ggbet_segment: 'Карта 1 - победитель' }),
  propose: () => { throw new Error('a verified row must not be re-proposed'); },
};
const pinned = buildLinks({
  markets: [{ ...pmMarket, teams: ['NAVI', 'Spirit'], outcomes: ['ex-Sangal ALTERS', 'Passion Academy'] }],
  ggbetMarkets: [ggbetMarket], mapping: stubborn, now: at,
});
assert.equal(pinned.size, 2, 'the hand-verified pairing is honoured');
assert.equal(pinned.get('tokenA').confidence, 1);

// --- the joined row ---------------------------------------------------------
const book = { assetId: 'tokenA', bestBid: 0.02, bestAsk: 0.30 };
const row = joinedRow('2026-08-25T18:00:10Z', links.get('tokenA'), book, ggbetMarket, at + 20_000);
const [ts, conditionId, assetId, bid, ask, mid, fair, state, score, segmentScore, ratio, age] = row;
assert.equal(ts, '2026-08-25T18:00:10Z');
assert.equal(conditionId, '0xC1');
assert.equal(assetId, 'tokenA');
assert.equal(bid, 0.02);
assert.equal(ask, 0.3);
assert.equal(mid, 0.16);
assert.equal(fair, 0.7, 'the first token carries the fair value as given');
assert.equal(state, 'active');
assert.equal(score, '1:0');
assert.equal(segmentScore, '9:5');
assert.ok(Math.abs(ratio - 0.7 / 0.16) < 1e-9, 'dislocation is fair over mid');
assert.equal(age, 20, 'quote age is measured from the newest gg.bet row');

// The other token prices the other side.
const other = joinedRow('t', links.get('tokenB'), { assetId: 'tokenB', bestBid: 0.6, bestAsk: 0.8 }, ggbetMarket, at);
assert.ok(Math.abs(other[6] - 0.3) < 1e-9, 'the complement token gets 1 - fair');

// A one-sided book has no mid, so there is no ratio to report rather than a
// fabricated one.
const empty = joinedRow('t', links.get('tokenA'), { assetId: 'tokenA', bestBid: null, bestAsk: 0.3 }, ggbetMarket, at);
assert.equal(empty[5], null);
assert.equal(empty[10], null, 'no mid means no dislocation ratio');

const suspended = joinedRow('t', links.get('tokenA'), book, { ...ggbetMarket, active: false, fair: null }, at);
assert.equal(suspended[6], null);
assert.equal(suspended[7], 'suspended');
assert.equal(suspended[10], null);

console.log('all join tests passed');
