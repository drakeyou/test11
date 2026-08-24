// Change-log tests: synthetic pairs for the edge cases, then a replay of the
// real captures in samples/ to prove the stream is produced end to end.
//   node src/changes.test.mjs
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { diffMatch } from './changes.mjs';
import { MatchStore, parseFrame } from './parse.mjs';
import { resolveSports, sportName } from './sports.mjs';

const view = (over = {}) => ({
  id: 'm1', resolved: true, title: 'A vs B', sport: 'esports_counter_strike',
  score: '0:0', segmentKind: 'map', segmentNo: 1, segmentName: 'DE_NUKE',
  segmentScore: '5:3', round: 3, state: 'live_time', betStop: false, extra: [],
  markets: [{ id: '1', name: 'Победитель', odds: [
    { id: '1', name: 'A', price: 1.8, isActive: true },
    { id: '2', name: 'B', price: 2.0, isActive: true },
  ] }],
  ...over,
});

const kinds = (before, after) => diffMatch(before, after).map((c) => c.kind);

assert.deepEqual(kinds(null, view()), ['match_start'], 'a new match starts once');
assert.deepEqual(kinds({ resolved: false }, view()), ['match_start'], 'naming a match starts it');
assert.deepEqual(kinds(view(), view()), [], 'an identical frame is silent');
assert.deepEqual(kinds(view(), view({ score: '1:0' })), ['score']);
assert.deepEqual(kinds(view(), view({ round: 4 })), ['round']);
assert.deepEqual(kinds(view(), view({ betStop: true })), ['bet_stop']);
assert.deepEqual(kinds(view(), view({ segmentNo: 2, segmentName: 'DE_DUST2' })),
  ['segment', 'segment_name']);
assert.deepEqual(kinds(view(), view({ segmentScore: '6:3' })), ['segment_score']);

// An unresolved match must never reach the log, however much it changes.
assert.deepEqual(diffMatch(view(), { ...view(), resolved: false }), []);

// A missing field must not be logged as a change to null.
assert.deepEqual(kinds(view(), view({ segmentName: null, round: null })), []);

const moved = diffMatch(view(), view({
  markets: [{ id: '1', name: 'Победитель', odds: [
    { id: '1', name: 'A', price: 1.7, isActive: true },
    { id: '2', name: 'B', price: 2.0, isActive: false },
  ] }],
}));
assert.deepEqual(moved.map((c) => c.kind), ['price', 'odd_suspended']);
assert.equal(moved[0].from, 1.8);
assert.equal(moved[0].to, 1.7);
assert.equal(moved[0].target, 'Победитель / A');

assert.deepEqual(kinds(view({ markets: [] }), view()), ['market_open', 'market_open']);
assert.deepEqual(kinds(view(), view({ markets: [] })), ['market_closed', 'market_closed']);

// Sport registry: ids are gg.bet's own, so a typo must fail loudly.
assert.equal(resolveSports('cs')[0].id, 'esports_counter_strike');
assert.equal(resolveSports('lol,dota').map((s) => s.id).join(','),
  'esports_league_of_legends,esports_dota_2');
assert.equal(resolveSports('tennis')[0].id, 'tennis');
assert.equal(resolveSports('all').length, 6);
assert.throws(() => resolveSports('quidditch'), /unknown sport/);
assert.equal(sportName('esports_valorant'), 'Valorant');

// Replay the real captures and check the stream that comes out.
const store = new MatchStore();
const log = [];
for (const name of (await readdir('samples')).filter((n) => n.endsWith('.json')).sort()) {
  const { payload } = JSON.parse(await readFile(`samples/${name}`, 'utf8'));
  log.push(...store.apply(parseFrame(payload), 'esports_counter_strike'));
}

assert.ok(log.length > 0, 'the captures produce a change stream');
assert.equal(log.filter((c) => c.kind === 'match_start').length, 3, 'each match starts once');
assert.ok(log.every((c) => c.matchId && c.title && c.sport), 'every entry is attributed');
assert.ok(log.every((c) => !/^[0-9a-f-]{36}$/.test(c.title)), 'no uuid titles reach the log');

const counts = log.reduce((acc, c) => ({ ...acc, [c.kind]: (acc[c.kind] ?? 0) + 1 }), {});
console.log('replayed change log:', counts);
console.log('all change-log tests passed');
