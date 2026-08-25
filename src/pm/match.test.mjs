// Matching tests: normalization, gg.bet market naming, and outcome direction.
//   node src/pm/match.test.mjs
import assert from 'node:assert/strict';
import {
  alignOutcomes, classifyGgbetMarket, devig, findMatch, normalizeTeam, sameQuestion, scoreTeams, similarity,
} from './match.mjs';

// --- normalization ----------------------------------------------------------
assert.equal(normalizeTeam('Team Spirit'), 'spirit');
assert.equal(normalizeTeam('Hanwha Life Esports'), 'hanwhalife');
assert.equal(normalizeTeam('ex-Zero Tenacity'), 'exzerotenacity');
assert.equal(normalizeTeam('BNK FearX Youth'), 'bnkfearxyouth');
// Stripping every word would make unrelated clubs identical, so it falls back.
assert.equal(normalizeTeam('Team Esports'), 'teamesports');
assert.equal(normalizeTeam('Gaming'), 'gaming');

assert.equal(similarity('NAVI', 'NAVI'), 1);
assert.equal(similarity('Team Spirit', 'Spirit'), 1, 'noise words do not change identity');
assert.ok(similarity('G2 Ares', 'FaZe') < 0.2);
assert.equal(similarity('', 'x'), 0);
// Abbreviations are exactly what the manual mapping table exists for.
assert.ok(similarity('NAVI', 'Natus Vincere') < 0.5, 'an abbreviation will not match itself');

// --- gg.bet market names ----------------------------------------------------
const cases = [
  ['Победитель', { level: 'match', kind: 'winner', segmentNo: null }],
  ['Тотал карт', { level: 'match', kind: 'total', segmentNo: null }],
  ['Тотал геймов', { level: 'match', kind: 'total', segmentNo: null }],
  ['Фора по картам', { level: 'match', kind: 'handicap', segmentNo: null }],
  ['Фора по Геймам', { level: 'match', kind: 'handicap', segmentNo: null }],
  ['Карта 1 - тотал раундов', { level: 'segment', kind: 'total', segmentNo: 1, segmentKind: 'map' }],
  ['2-й Сет Победитель', { level: 'segment', kind: 'winner', segmentNo: 2, segmentKind: 'set' }],
];
for (const [name, expected] of cases) {
  const got = classifyGgbetMarket(name);
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(got[field], value, `${name} -> ${field}`);
  }
}

// The winner of a game inside a set is not the winner of the set.
const nested = classifyGgbetMarket('2-й Сет - Победитель гейма');
assert.equal(nested.kind, 'game_winner');
assert.equal(nested.segmentNo, 2);
assert.equal(sameQuestion({ level: 'segment', kind: 'winner', segmentNo: 2 }, nested), false,
  'a game winner must never satisfy a set winner');

// --- question equality ------------------------------------------------------
const pmMapWinner = { level: 'segment', kind: 'winner', segmentNo: 2 };
assert.ok(sameQuestion(pmMapWinner, classifyGgbetMarket('2-й Сет Победитель')));
assert.equal(sameQuestion(pmMapWinner, classifyGgbetMarket('Победитель')), false,
  'a map winner is not the match winner');
assert.equal(sameQuestion(pmMapWinner, classifyGgbetMarket('Карта 3 - тотал раундов')), false);
assert.ok(sameQuestion({ level: 'match', kind: 'total' }, classifyGgbetMarket('Тотал карт')));

// --- team pair scoring ------------------------------------------------------
assert.equal(scoreTeams(['A', 'B'], ['A', 'B']).swapped, false);
const flipped = scoreTeams(['FaZe', 'NAVI'], ['NAVI', 'FaZe']);
assert.equal(flipped.swapped, true, 'the sites may list competitors either way round');
assert.equal(flipped.confidence, 1);
assert.equal(scoreTeams(null, ['A', 'B']).confidence, 0);

// --- outcome alignment ------------------------------------------------------
const sel = (name) => ({ name });
assert.deepEqual(alignOutcomes(['NAVI', 'FaZe'], [sel('NAVI'), sel('FaZe')]), [0, 1]);
assert.deepEqual(alignOutcomes(['FaZe', 'NAVI'], [sel('NAVI'), sel('FaZe')]), [1, 0]);
// \b is ASCII-only in JavaScript, so Cyrillic words are matched by token.
assert.deepEqual(alignOutcomes(['Over', 'Under'], [sel('Больше 22.5'), sel('Меньше 22.5')]), [0, 1]);
assert.deepEqual(alignOutcomes(['Under', 'Over'], [sel('Больше 22.5'), sel('Меньше 22.5')]), [1, 0]);
assert.equal(alignOutcomes(['Over', 'Under'], [sel('X'), sel('Y')]), null, 'unrelated names do not align');
assert.equal(alignOutcomes(['A'], [sel('A'), sel('B')]), null, 'two outcomes are required');

// --- candidate search -------------------------------------------------------
const start = Date.parse('2026-08-25T18:00:00Z');
const pmRecord = {
  conditionId: '0x1', teams: ['ex-Sangal ALTERS', 'Passion Academy'],
  level: 'segment', kind: 'winner', segmentKind: 'map', segmentNo: 1,
  endDate: '2026-08-25T18:00:00Z', outcomes: ['ex-Sangal ALTERS', 'Passion Academy'],
};
const candidates = [
  { matchId: 'm1', market: 'Победитель', teams: ['ex-Sangal ALTERS', 'Passion Academy'], updatedAt: start },
  { matchId: 'm1', market: 'Карта 1 - победитель', teams: ['ex-Sangal', 'Passion'], updatedAt: start },
  { matchId: 'm2', market: 'Карта 1 - победитель', teams: ['G2 Ares', 'ex-RUSTEC'], updatedAt: start },
];
const found = findMatch(pmRecord, candidates, { now: start });
assert.equal(found.matchId, 'm1');
assert.equal(found.market, 'Карта 1 - победитель', 'the segment-level market wins over the match winner');
assert.ok(found.confidence > 0.7);

// Outside the time window there is no match, however well the names score.
const stale = candidates.map((c) => ({ ...c, updatedAt: start - 9 * 3600 * 1000 }));
assert.equal(findMatch(pmRecord, stale, { now: start, windowHours: 6 }), null,
  'a match half a day away is a different match');

// --- de-vig -----------------------------------------------------------------
assert.equal(devig(2, 2), 0.5);
assert.ok(Math.abs(devig(1.44, 2.59) - 0.6427) < 0.001);
assert.equal(devig(1, 2), null, 'a suspended 1.00 quote is not a price');
assert.equal(devig(2, null), null);

console.log('all matching tests passed');
