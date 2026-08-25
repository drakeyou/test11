// Module C — matching Polymarket markets to gg.bet ones.
//
// There is no shared identifier, so a match is (fuzzy team pair) + (time window)
// + (same market at the same segment). The last part is not optional: pairing
// Polymarket's "Map 2 Winner" with gg.bet's match winner would silently compare
// two different questions and poison every dislocation figure downstream.
//
// The two sides name segments differently. Polymarket counts ("Map 2 Winner"),
// gg.bet uses Russian ordinals ("2-й Сет Победитель") or a cardinal after the
// noun ("Карта 1 - тотал раундов"), so both forms are parsed.

const NOISE = /\b(team|esports|esport|gaming|academy|club|gg|e-?sports)\b/gi;

/** Lowercase, drop org noise words, keep only letters and digits. */
export function normalizeTeam(name) {
  const stripped = String(name ?? '').replace(NOISE, ' ');
  const cleaned = stripped.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  // Dropping every word would make two unrelated teams identical, so fall back
  // to the original when the noise words were the whole name.
  return cleaned || String(name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const bigrams = (text) => {
  const set = new Map();
  for (let i = 0; i < text.length - 1; i++) {
    const pair = text.slice(i, i + 2);
    set.set(pair, (set.get(pair) ?? 0) + 1);
  }
  return set;
};

/** Dice coefficient over character bigrams: 1 identical, 0 nothing in common. */
export function similarity(a, b) {
  const left = normalizeTeam(a);
  const right = normalizeTeam(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;

  const first = bigrams(left);
  const second = bigrams(right);
  let shared = 0;
  for (const [pair, count] of first) shared += Math.min(count, second.get(pair) ?? 0);
  return (2 * shared) / (left.length - 1 + right.length - 1);
}

const SEGMENT_ORDINAL = /(\d+)\s*-?\s*(?:й|я|го|е|st|nd|rd|th)?\s*(сет|карт|гейм|map|set|game)/i;
const SEGMENT_CARDINAL = /(карт[аеы]|сет|гейм|map|set|game)\s*(\d+)/i;
const KIND = [
  [/победител[ья]\s+гейма|game\s+winner/i, 'game_winner'],
  [/тотал|total|over\/under|o\/u/i, 'total'],
  [/фора|handicap|hcp/i, 'handicap'],
  [/победител|winner|исход/i, 'winner'],
];
const SEGMENT_WORD = { карт: 'map', сет: 'set', гейм: 'game', map: 'map', set: 'set', game: 'game' };

/**
 * Read a gg.bet market name into the same shape the Polymarket classifier
 * produces, so the two can be compared field by field.
 * @param {string} name  e.g. "Карта 1 - тотал раундов", "2-й Сет Победитель"
 */
export function classifyGgbetMarket(name) {
  const text = String(name ?? '');
  const ordinal = SEGMENT_ORDINAL.exec(text);
  const cardinal = SEGMENT_CARDINAL.exec(text);
  const segmentNo = ordinal ? Number(ordinal[1]) : cardinal ? Number(cardinal[2]) : null;
  const word = (ordinal?.[2] ?? cardinal?.[1] ?? '').toLowerCase().slice(0, 4);

  // A "winner of the game" market inside a set is not the set winner, and must
  // never match Polymarket's "Set N Winner".
  const kind = KIND.find(([pattern]) => pattern.test(text))?.[1] ?? 'winner';

  return {
    name: text,
    level: segmentNo === null ? 'match' : 'segment',
    kind,
    segmentKind: segmentNo === null ? null : (SEGMENT_WORD[word.replace(/[аеы]$/, '')] ?? null),
    segmentNo,
  };
}

/** Do a Polymarket record and a gg.bet market ask the same question? */
export function sameQuestion(pmRecord, ggbetMarket) {
  if (pmRecord.level !== ggbetMarket.level) return false;
  if (pmRecord.kind !== ggbetMarket.kind) return false;
  return pmRecord.level === 'match' || pmRecord.segmentNo === ggbetMarket.segmentNo;
}

/**
 * Score one candidate pairing on team names alone, trying both orderings.
 * @returns {{confidence: number, swapped: boolean}}
 */
export function scoreTeams(pmTeams, ggbetTeams) {
  if (!pmTeams?.length || !ggbetTeams?.length) return { confidence: 0, swapped: false };
  const direct = (similarity(pmTeams[0], ggbetTeams[0]) + similarity(pmTeams[1], ggbetTeams[1])) / 2;
  const swapped = (similarity(pmTeams[0], ggbetTeams[1]) + similarity(pmTeams[1], ggbetTeams[0])) / 2;
  return swapped > direct
    ? { confidence: swapped, swapped: true }
    : { confidence: direct, swapped: false };
}

/**
 * Best gg.bet market for a Polymarket record.
 * @param {object} pmRecord  a classified Polymarket market
 * @param {object[]} candidates  gg.bet markets: {matchId, teams, market, updatedAt, ...}
 * @param {{minConfidence?: number, windowHours?: number, now?: number}} [options]
 * @returns {object|null} the winning candidate with its confidence
 */
export function findMatch(pmRecord, candidates, options = {}) {
  const { minConfidence = 0.7, windowHours = 6, now = Date.now() } = options;
  const startsAt = pmRecord.endDate ? Date.parse(pmRecord.endDate) : now;
  const window = windowHours * 3600 * 1000;

  let best = null;
  for (const candidate of candidates) {
    const ggbetMarket = classifyGgbetMarket(candidate.market);
    if (!sameQuestion(pmRecord, ggbetMarket)) continue;
    // gg.bet only carries live matches, so its own timestamp stands in for the
    // match time; Polymarket's endDate is when the market resolves.
    if (candidate.updatedAt && Math.abs(candidate.updatedAt - startsAt) > window) continue;

    const { confidence, swapped } = scoreTeams(pmRecord.teams, candidate.teams);
    if (confidence < minConfidence) continue;
    if (!best || confidence > best.confidence) {
      best = { ...candidate, ggbetMarket, confidence, swapped };
    }
  }
  return best;
}

// Over/Under is not a team name, so outcome alignment needs the words too.
// Matched on the first token rather than by regex: \b is ASCII-only in
// JavaScript, so it finds no boundary at the end of "Больше" and quietly fails.
const WORDS = new Map([
  ['over', 'over'], ['больше', 'over'], ['б', 'over'], ['тб', 'over'],
  ['under', 'under'], ['меньше', 'under'], ['м', 'under'], ['тм', 'under'],
  ['yes', 'yes'], ['да', 'yes'], ['no', 'no'], ['нет', 'no'],
]);

const canonical = (name) =>
  WORDS.get(String(name ?? '').trim().split(/\s+/)[0].toLowerCase()) ?? null;

/**
 * Which gg.bet selection answers each Polymarket outcome.
 *
 * Aligning by position would invert the fair value whenever the two sites list
 * the competitors in a different order, which is silent and ruins every
 * dislocation figure. Aligning by name survives that, and handles Over/Under,
 * where team similarity means nothing.
 *
 * @returns {number[]|null} index into selections per Polymarket outcome
 */
export function alignOutcomes(pmOutcomes, ggbetSelections) {
  if (pmOutcomes?.length !== 2 || ggbetSelections?.length !== 2) return null;

  const byWord = pmOutcomes.map((outcome) => {
    const word = canonical(outcome);
    return word === null ? -1 : ggbetSelections.findIndex((s) => canonical(s.name) === word);
  });
  if (byWord.every((i) => i >= 0) && byWord[0] !== byWord[1]) return byWord;

  const direct = similarity(pmOutcomes[0], ggbetSelections[0].name) +
    similarity(pmOutcomes[1], ggbetSelections[1].name);
  const crossed = similarity(pmOutcomes[0], ggbetSelections[1].name) +
    similarity(pmOutcomes[1], ggbetSelections[0].name);
  if (direct === 0 && crossed === 0) return null;
  return crossed > direct ? [1, 0] : [0, 1];
}

/** De-vigged probability of the first outcome from a pair of decimal odds. */
export function devig(oddsA, oddsB) {
  if (!(oddsA > 1) || !(oddsB > 1)) return null;
  const a = 1 / oddsA;
  return a / (a + 1 / oddsB);
}
