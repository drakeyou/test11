// Sanity checks for the heuristic extractor, run with: node src/extract.test.mjs
import assert from 'node:assert/strict';
import { extractMatches } from './extract.mjs';

// Shape A: paired home/away objects, odds nested under markets.
const paired = {
  data: {
    events: [{
      id: 'evt-991',
      tournament: { name: 'ESL Pro League' },
      home: { name: 'NAVI' },
      away: { name: 'FaZe' },
      score: [13, 9],
      markets: [{ name: 'Winner', outcomes: [
        { title: 'NAVI', odd: 1.72 },
        { title: 'FaZe', odd: 2.05 },
      ] }],
    }],
  },
};

// Shape B: competitors as a two-item array, price as a string.
const arrayed = {
  matches: [{
    matchId: 4412,
    competitors: [{ title: 'Vitality' }, { title: 'Spirit' }],
    result: { home: 1, away: 0 },
    bets: [{ name: 'Map 2 winner', price: '1,95' }],
  }],
};

const a = extractMatches(paired);
assert.equal(a.length, 1, 'one match from shape A');
assert.deepEqual(a[0].teams, ['NAVI', 'FaZe']);
assert.equal(a[0].score, '13:9');
assert.equal(a[0].tournament, 'ESL Pro League');
assert.ok(a[0].odds.some((o) => o.price === 1.72), 'picks up decimal odds');

const b = extractMatches(arrayed);
assert.equal(b.length, 1, 'one match from shape B');
assert.deepEqual(b[0].teams, ['Vitality', 'Spirit']);
assert.equal(b[0].score, '1:0');
assert.ok(b[0].odds.some((o) => o.price === 1.95), 'coerces comma decimals');

// Noise must not produce phantom matches.
assert.equal(extractMatches({ banners: [{ id: 1, title: 'promo' }] }).length, 0);
assert.equal(extractMatches({ home: { name: 'A' }, away: { name: 'B' } }).length, 0, 'no odds, no match');

console.log('all extractor tests passed');
