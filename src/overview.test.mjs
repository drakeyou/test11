// Per-sport overview tests, run against the captures in samples2/ which cover
// League of Legends, Dota 2 and tennis, plus samples/ for Counter-Strike.
//   node src/overview.test.mjs
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { summarizeOverview } from './overview.mjs';

/** Collect one overview of each __typename across both capture sets. */
async function collectOverviews() {
  const found = new Map();
  for (const dir of ['samples', 'samples2']) {
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
      const { payload } = JSON.parse(await readFile(`${dir}/${name}`, 'utf8'));
      const rows = payload?.payload?.data?.onUpdateSportEventOverviews?.replace ?? [];
      for (const row of rows) {
        const type = row.overview?.__typename;
        if (type && !found.has(type)) found.set(type, row.overview);
      }
    }
  }
  return found;
}

const overviews = await collectOverviews();
for (const type of ['CSGOOverview', 'LOLOverview', 'Dota2Overview', 'TennisOverview']) {
  assert.ok(overviews.has(type), `captures contain a ${type}`);
}

const scorePattern = /^\d+:\d+$/;
for (const [type, raw] of overviews) {
  const s = summarizeOverview(raw);
  assert.equal(s.type, type);
  assert.ok(['map', 'set'].includes(s.segmentKind), `${type} has a segment kind`);
  assert.ok(Number.isInteger(s.segmentNo), `${type} reports which segment is in play`);
  assert.match(s.segmentScore ?? '', scorePattern, `${type} scores the current segment`);
  assert.ok(Array.isArray(s.extra), `${type} extras are a list`);
  assert.ok(s.extra.every((x) => typeof x === 'string' && x.length), `${type} extras are strings`);
}

// Counter-Strike is the only sport with rounds; the others must not invent them.
assert.ok(Number.isInteger(summarizeOverview(overviews.get('CSGOOverview')).round));
for (const type of ['LOLOverview', 'Dota2Overview', 'TennisOverview']) {
  assert.equal(summarizeOverview(overviews.get(type)).round, null, `${type} has no rounds`);
}

assert.equal(summarizeOverview(overviews.get('TennisOverview')).segmentKind, 'set');
assert.equal(summarizeOverview(overviews.get('CSGOOverview')).segmentKind, 'map');

// Tennis points: POINT_ABOVE is advantage, and COMMON is not a state worth showing.
const tennis = summarizeOverview({
  __typename: 'TennisOverview', currentSet: 1, server: 'HOME', pause: false,
  teams: {
    home: { gamePoint: { gamePoint: 'POINT40' }, tieBreak: { score: 0 } },
    away: { gamePoint: { gamePoint: 'POINT_ABOVE' }, tieBreak: { score: 0 } },
  },
  sets: [{ number: 1, state: 'COMMON', gameScore: { home: 5, away: 6 }, tieBreakScore: { home: 0, away: 0 } }],
});
assert.equal(tennis.segmentScore, '5:6');
assert.equal(tennis.state, null, 'COMMON play prints no state');
assert.ok(tennis.extra.includes('40:AD'), `advantage rendered, got ${tennis.extra.join()}`);
assert.ok(tennis.extra.includes('serve home'));

// An unseen sport must degrade instead of throwing.
const unknown = summarizeOverview({ __typename: 'SnookerOverview', currentMap: 3, bestOf: 9,
  teams: { home: { score: 2 }, away: { score: 1 } } });
assert.equal(unknown.type, 'SnookerOverview');
assert.equal(unknown.segmentNo, 3);
assert.equal(unknown.segmentScore, '2:1');
assert.equal(summarizeOverview(null), null);

console.log('overview types checked:', [...overviews.keys()].join(', '));
console.log('all overview tests passed');
