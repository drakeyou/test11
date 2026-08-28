// Tests run against the real captures in samples/, so a change in the parser
// is checked against payloads gg.bet actually sent.
//   node src/parse.test.mjs
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { MatchStore, normalizeId, parseFrame } from './parse.mjs';
import { renderMatches } from './render.mjs';

const DIR = 'samples';

assert.equal(normalizeId('5:dbe576ca-3605'), 'dbe576ca-3605', 'strips provider prefix');
assert.equal(normalizeId('dbe576ca-3605'), 'dbe576ca-3605', 'leaves bare ids alone');

const names = (await readdir(DIR)).filter((n) => n.endsWith('.json')).sort();
assert.ok(names.length > 0, 'samples/ must contain captures');

const store = new MatchStore();
let opCount = 0;
for (const name of names) {
  const { payload } = JSON.parse(await readFile(`${DIR}/${name}`, 'utf8'));
  const ops = parseFrame(payload);
  opCount += ops.length;
  store.apply(ops);
}

assert.ok(opCount > 0, 'frames produced operations');
assert.equal(store.size, 3, 'three live matches in this capture set');

const matches = store.list();

// Names come from the snapshot; the patches that follow carry ids only, so a
// title still resolving proves the merge kept earlier data.
for (const m of matches) {
  assert.ok(!/^[0-9a-f-]{36}$/.test(m.title), `title resolved, got ${m.title}`);
  assert.match(m.title, / vs /, 'title names both teams');
}

const withOdds = matches.filter((m) => m.markets.some((mk) => mk.odds.length));
assert.ok(withOdds.length > 0, 'at least one match carries odds');

for (const m of withOdds) {
  for (const market of m.markets) {
    for (const odd of market.odds) {
      assert.ok(Number.isFinite(odd.price), `price is numeric for ${odd.name}`);
      assert.ok(odd.price >= 1, `price is a decimal odd, got ${odd.price}`);
    }
  }
}

// The databet stream must have merged onto the same match objects.
const live = matches.filter((m) => m.segmentNo !== null);
assert.equal(live.length, 3, 'overview merged into every match by stripped id');
for (const m of live) {
  assert.equal(m.overviewType, 'CSGOOverview');
  assert.equal(m.segmentKind, 'map');
  assert.match(m.segmentScore ?? '', /^\d+:\d+$/, 'round score formatted');
  assert.ok(Number.isInteger(m.round), 'CS carries a round number');
}

// Noise must decode to nothing.
assert.deepEqual(parseFrame({ type: 'ka' }), []);
assert.deepEqual(parseFrame({ type: 'data', payload: { data: { banners: [] } } }), []);
assert.deepEqual(parseFrame(null), []);

// The site reports how many live matches it has and delivers the first page of
// them. Ignoring that made the shortfall invisible: 28 live tennis matches
// arrived as 12 events and nothing said so.
const partial = new MatchStore();
partial.apply(parseFrame({
  type: 'data',
  payload: { data: { matches: { count: 28, sportEvents: [
    { id: '5:a', fixture: { title: 'A vs B', score: '0:0', sportId: 'tennis',
      competitors: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }] }, markets: [] },
  ] } } },
}), 'tennis');
const [tennisCoverage] = partial.coverage();
assert.equal(tennisCoverage.expected, 28, 'the reported total is kept');
assert.equal(tennisCoverage.have, 1, 'against what actually arrived');
assert.ok(tennisCoverage.have < tennisCoverage.expected, 'a shortfall is visible');

// A later page reports the same total; it must not be double counted or lost.
partial.apply(parseFrame({
  type: 'data',
  payload: { data: { matches: { count: 28, sportEvents: [
    { id: '5:b', fixture: { title: 'C vs D', score: '0:0', sportId: 'tennis',
      competitors: [{ id: 'c3', name: 'C' }, { id: 'c4', name: 'D' }] }, markets: [] },
  ] } } },
}), 'tennis');
assert.deepEqual(partial.coverage(), [{ sport: 'tennis', expected: 28, have: 2 }]);

// A count with no shortfall reports as complete.
const whole = new MatchStore();
whole.apply(parseFrame({
  type: 'data',
  payload: { data: { matches: { count: 1, sportEvents: [
    { id: '5:x', fixture: { title: 'E vs F', score: '0:0', sportId: 'esports_dota_2',
      competitors: [{ id: 'c5', name: 'E' }, { id: 'c6', name: 'F' }] }, markets: [] },
  ] } } },
}), 'esports_dota_2');
assert.deepEqual(whole.coverage(), [{ sport: 'esports_dota_2', expected: 1, have: 1 }]);

// An expected marker must not be mistaken for a match.
assert.equal(whole.size, 1);

// A patch on its own names nobody, so it must not pass as a usable match.
const orphan = new MatchStore();
orphan.apply(parseFrame({
  type: 'data',
  payload: { data: { onUpdateSportEvent: { id: '5:abc', fixture: { score: '1:0' }, markets: [] } } },
}));
assert.equal(orphan.list()[0].resolved, false, 'unnamed match is flagged unresolved');
assert.ok(matches.every((m) => m.resolved), 'every match in samples/ resolved');

// Arrows compare against what was last shown, so a stale price must move them.
const sample = matches.find((m) => m.markets.some((mk) => mk.odds.length));
const market = sample.markets.find((mk) => mk.odds.length);
const odd = market.odds[0];
const stale = new Map([[`${sample.id}|${market.id}|${odd.id}`, odd.price - 0.5]]);
const moved = renderMatches([sample], stale, { clear: false });
assert.match(moved, /\^ /, 'a risen price renders an up arrow');
assert.ok(!/\^ |v /.test(renderMatches([sample], new Map(), { clear: false })),
  'an unchanged price renders no arrow');

// The shortfall has to reach the screen, or it goes back to being silent.
const shortView = renderMatches(matches, new Map(), { clear: false,
  coverage: [{ sport: 'tennis', expected: 28, have: 12 }] });
assert.match(shortView, /missing: .*12\/28/, 'an incomplete list is announced');
assert.match(shortView, /not fully loaded/);
const wholeView = renderMatches(matches, new Map(), { clear: false,
  coverage: [{ sport: 'tennis', expected: 12, have: 12 }] });
assert.ok(!wholeView.includes('missing:'), 'a complete list says nothing');

// Rendering must survive the real data, including fields the capture lacks.
const view = renderMatches(matches, new Map(), { clear: false });
for (const m of matches) assert.ok(view.includes(m.title), `view lists ${m.title}`);
assert.ok(view.includes('Победитель'), 'market name rendered');
assert.equal(renderMatches([], new Map(), { clear: false }).includes('waiting'), true);

console.log(`parsed ${opCount} operations from ${names.length} captures`);
for (const m of matches) {
  console.log(`  ${m.title.padEnd(34)} maps ${m.score ?? '-'}  ` +
    `map${m.segmentNo} ${m.segmentName ?? '-'} ${m.segmentScore ?? '-'} r${m.round ?? '-'}  ` +
    `odds:${m.markets.reduce((n, mk) => n + mk.odds.length, 0)}`);
}
console.log('all parser tests passed');
