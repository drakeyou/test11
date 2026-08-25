// Classifier tests against real Gamma markets recorded in samples-pm/.
//   node src/pm/classify.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyMarket, isTracked, parseJsonField } from './classify.mjs';
import { DEFAULTS } from './config.mjs';

// Gamma hands these over as JSON strings; treating them as arrays yields nothing.
assert.deepEqual(parseJsonField('["a","b"]'), ['a', 'b']);
assert.deepEqual(parseJsonField(['a']), ['a']);
assert.deepEqual(parseJsonField('not json'), []);
assert.deepEqual(parseJsonField(undefined), []);

const raw = JSON.parse(readFileSync('samples-pm/gamma-markets.json', 'utf8'));
const records = raw.map((m) => classifyMarket(m, DEFAULTS.disciplines));
const tracked = records.filter(isTracked);

assert.ok(tracked.length > 40, `fixture carries tracked markets, got ${tracked.length}`);
assert.ok(tracked.every((r) => r.tokens.length === 2), 'two asset ids per market');
assert.ok(tracked.every((r) => r.sport), 'a tracked market always has a discipline');
assert.ok(records.some((r) => !r.sport), 'fixture also holds markets we ignore');

const find = (fragment) => tracked.find((r) => r.question.includes(fragment));

// Level and kind are independent: a total inside a map is not a match total.
const mapWinner = find('Map 1 Winner');
assert.equal(mapWinner.level, 'segment');
assert.equal(mapWinner.kind, 'winner');
assert.equal(mapWinner.segmentKind, 'map');
assert.equal(mapWinner.segmentNo, 1);

const mapHandicap = find('Map 3 Rounds Handicap');
assert.equal(mapHandicap.level, 'segment');
assert.equal(mapHandicap.kind, 'handicap');
assert.equal(mapHandicap.segmentNo, 3);
assert.ok(Number.isFinite(mapHandicap.line), 'handicap carries its line');

const mapTotal = find('Map 2 Total Rounds');
assert.equal(mapTotal.level, 'segment');
assert.equal(mapTotal.kind, 'total');

const matchTotal = find('Games Total');
assert.equal(matchTotal.level, 'match', 'a games total spans the whole match');
assert.equal(matchTotal.kind, 'total');
assert.equal(matchTotal.segmentNo, null);

const matchHandicap = find('Map Handicap:');
assert.equal(matchHandicap.level, 'match', 'a map handicap with no number is match level');
assert.equal(matchHandicap.kind, 'handicap');

// The discipline lives in the event slug: these questions name no sport.
assert.equal(matchTotal.sport, 'esports_counter_strike');
assert.equal(mapHandicap.sport, 'esports_counter_strike');

// Team names feed the gg.bet fuzzy match, so no tournament tails or "(BO3)".
const dirty = tracked.filter((r) => r.teams?.some((t) => /[()]|\s-\s|^\s*$/.test(t)));
assert.equal(dirty.length, 0, `team names are clean, got ${JSON.stringify(dirty[0]?.teams)}`);
assert.ok(tracked.every((r) => r.teams?.length === 2), 'both competitors resolved');

// Totals answer Over/Under, so their teams must come from the event title.
assert.deepEqual(mapTotal.outcomes, ['Over', 'Under']);
assert.ok(mapTotal.teams.every((t) => !/over|under/i.test(t)), 'totals still name the teams');

const counts = tracked.reduce((acc, r) => {
  const key = `${r.level}/${r.kind}`;
  return { ...acc, [key]: (acc[key] ?? 0) + 1 };
}, {});
console.log('classified:', counts);
console.log('all classifier tests passed');
