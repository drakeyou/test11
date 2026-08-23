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
const live = matches.filter((m) => m.currentMap !== null);
assert.equal(live.length, 3, 'overview merged into every match by stripped id');
for (const m of live) {
  assert.ok(m.mapName, `map name present for ${m.title}`);
  assert.match(m.roundScore ?? '', /^\d+:\d+$/, 'round score formatted');
}

// Noise must decode to nothing.
assert.deepEqual(parseFrame({ type: 'ka' }), []);
assert.deepEqual(parseFrame({ type: 'data', payload: { data: { banners: [] } } }), []);
assert.deepEqual(parseFrame(null), []);

// A patch on its own names nobody, so it must not pass as a usable match.
const orphan = new MatchStore().apply(parseFrame({
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

// Rendering must survive the real data, including fields the capture lacks.
const view = renderMatches(matches, new Map(), { clear: false });
for (const m of matches) assert.ok(view.includes(m.title), `view lists ${m.title}`);
assert.ok(view.includes('Победитель'), 'market name rendered');
assert.equal(renderMatches([], new Map(), { clear: false }).includes('waiting'), true);

console.log(`parsed ${opCount} operations from ${names.length} captures`);
for (const m of matches) {
  console.log(`  ${m.title.padEnd(34)} maps ${m.mapScore ?? '-'}  ` +
    `map${m.currentMap} ${m.mapName ?? '-'} ${m.roundScore ?? '-'} r${m.round ?? '-'}  ` +
    `odds:${m.markets.reduce((n, mk) => n + mk.odds.length, 0)}`);
}
console.log('all parser tests passed');
