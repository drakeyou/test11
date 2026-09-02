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

import { gameStartOf } from './schedule.mjs';

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

/** Word tokens of a name, org noise removed. */
export function nameTokens(name) {
  return String(name ?? '')
    .replace(NOISE, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * One name is the other with its given name left off.
 *
 * Polymarket writes the competitors of a winner market into its outcomes, and
 * those are surnames: "Set 2 Winner: Yamaguchi vs Back" against gg.bet's "Mei
 * Yamaguchi vs Dayeon Back". On bigrams alone that pair scores 0.67 and falls
 * under the 0.7 threshold, which is why not one segment-winner market was ever
 * matched while the totals of the same match — whose competitors come from the
 * full event title — matched at 1.0.
 *
 * The last token has to be the shared one. Otherwise "MOUZ" and "MOUZ NXT",
 * which are different teams, would be read as the same one.
 */
export function sharedSurname(a, b) {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length) return false;
  if (left.at(-1) !== right.at(-1)) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length === longer.length) return false; // same shape: bigrams already judge it
  return shorter.every((token) => longer.includes(token));
}

/**
 * A short name built from the front of each word of a long one.
 *
 * "NAVI" is Natus Vincere and scores 0.29 on bigrams; no threshold rescues that
 * without admitting nonsense elsewhere. Every word must be used and must
 * contribute at least one letter, which is what keeps it from matching
 * arbitrary short strings.
 */
export function isPrefixAcronym(shortName, longName) {
  const short = normalizeTeam(shortName);
  const words = nameTokens(longName);
  if (short.length < 3 || words.length < 2) return false;
  let reachable = new Set([0]);
  for (const word of words) {
    const next = new Set();
    for (const at of reachable) {
      for (let take = 1; take <= word.length && at + take <= short.length; take++) {
        if (short[at + take - 1] !== word[take - 1]) break;
        next.add(at + take);
      }
    }
    if (!next.size) return false;
    reachable = next;
  }
  return reachable.has(short.length);
}

/**
 * How much two names look like the same competitor.
 *
 * Either argument may be a list of aliases for one competitor, in which case
 * the best pairing wins.
 */
export function nameScore(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [a];
    const right = Array.isArray(b) ? b : [b];
    let best = 0;
    for (const one of left) for (const other of right) best = Math.max(best, nameScore(one, other));
    return best;
  }
  const direct = similarity(a, b);
  // Deliberately below an exact match and above the 0.7 admission threshold:
  // these are strong evidence, but bigram agreement on the whole name is
  // stronger still.
  if (sharedSurname(a, b)) return Math.max(direct, 0.92);
  if (isPrefixAcronym(a, b) || isPrefixAcronym(b, a)) return Math.max(direct, 0.88);
  return direct;
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
// Same axis as the Polymarket classifier: what is being counted. "Карта 1 -
// тотал раундов" names the map and counts rounds, so the later noun wins.
const GGBET_UNITS = [[/убийств|килл/i, 'kill'], [/раунд/i, 'round'], [/гейм/i, 'game'],
  [/сет/i, 'set'], [/карт/i, 'map']];

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
    unit: kind === 'winner' || kind === 'game_winner'
      ? null
      : (GGBET_UNITS.find(([pattern]) => pattern.test(text))?.[1] ?? null),
  };
}

/**
 * Do a Polymarket record and a gg.bet market ask the same question?
 *
 * Level and kind are not enough. "Set Handicap: A (-1.5) vs B (+1.5)" and
 * gg.bet's "Фора по Геймам" are both a match-level handicap, and pairing them
 * compares a handicap in sets against one in games; the same collapse pairs a
 * total of kills with a total of rounds. The dislocation that comes out of it
 * is not wrong by a little, it is an answer to a different question — which is
 * exactly the failure the segment check exists to prevent, one axis over.
 *
 * A unit is only demanded when both sides state one: Polymarket's "Match O/U
 * 23.5" names no unit at all and is still the games total it pairs with.
 */
export function sameQuestion(pmRecord, ggbetMarket) {
  if (pmRecord.level !== ggbetMarket.level) return false;
  if (pmRecord.kind !== ggbetMarket.kind) return false;
  if (pmRecord.unit && ggbetMarket.unit && pmRecord.unit !== ggbetMarket.unit) return false;
  return pmRecord.level === 'match' || pmRecord.segmentNo === ggbetMarket.segmentNo;
}

/**
 * Score one candidate pairing on team names alone, trying both orderings.
 * Either side may give a list of aliases per competitor.
 * @returns {{confidence: number, swapped: boolean}}
 */
export function scoreTeams(pmTeams, ggbetTeams) {
  if (!pmTeams?.length || !ggbetTeams?.length) return { confidence: 0, swapped: false };
  const direct = (nameScore(pmTeams[0], ggbetTeams[0]) + nameScore(pmTeams[1], ggbetTeams[1])) / 2;
  const swapped = (nameScore(pmTeams[0], ggbetTeams[1]) + nameScore(pmTeams[1], ggbetTeams[0])) / 2;
  return swapped > direct
    ? { confidence: swapped, swapped: true }
    : { confidence: direct, swapped: false };
}

const VERSUS_PAIR = /^(.*?)\s+vs\.?\s+(.*?)$/i;
const stripPrefix = (text) => String(text ?? '').replace(/^[^:]*:\s*/, '');
const cleanName = (name) =>
  String(name ?? '').replace(/\s+-\s+.*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();

/** The competitor pair a piece of text names, or null. */
function pairIn(text) {
  const found = VERSUS_PAIR.exec(stripPrefix(text));
  return found ? [cleanName(found[1]), cleanName(found[2])] : null;
}

/**
 * Every name Polymarket uses for each competitor of a market.
 *
 * The classifier picks one pair, preferring the outcomes because they carry the
 * side. But the outcomes of a winner market are surnames while the event title
 * spells the competitors out, and the two disagree about order as often as not
 * ("Astakhova vs Naito" in the question against "Yuki Naito vs Darya Astakhova"
 * in the title). So each further pair is oriented against the first by name
 * before it is merged, and an orientation that is not clearly one way or the
 * other is dropped rather than guessed.
 *
 * @returns {[string[], string[]]|null} aliases per competitor, in record order
 */
export function aliasesOf(record) {
  const primary = record?.teams;
  if (!primary?.length) return null;
  const aliases = [[primary[0]], [primary[1]]];

  for (const text of [record.question, record.eventTitle]) {
    const pair = pairIn(text);
    if (!pair) continue;
    const direct = nameScore(primary[0], pair[0]) + nameScore(primary[1], pair[1]);
    const crossed = nameScore(primary[0], pair[1]) + nameScore(primary[1], pair[0]);
    if (direct === crossed) continue; // unrelated, or symmetric: no evidence either way
    const [first, second] = direct > crossed ? pair : [pair[1], pair[0]];
    if (!aliases[0].includes(first)) aliases[0].push(first);
    if (!aliases[1].includes(second)) aliases[1].push(second);
  }
  return aliases;
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
  // When the match is played, not when the market resolves. endDate is a
  // resolution deadline — game + 6h for CS2, game + a week for tennis — so
  // comparing a live gg.bet quote against it put every candidate at or beyond
  // the edge of a six-hour window and threw away correct pairings.
  const startsAt = gameStartOf(pmRecord, {}, now)?.at ?? now;
  const window = windowHours * 3600 * 1000;
  const aliases = aliasesOf(pmRecord) ?? pmRecord.teams;

  let best = null;
  for (const candidate of candidates) {
    const ggbetMarket = classifyGgbetMarket(candidate.market);
    if (!sameQuestion(pmRecord, ggbetMarket)) continue;
    // gg.bet only carries live matches, so its own timestamp stands in for the
    // match time.
    if (candidate.updatedAt && Math.abs(candidate.updatedAt - startsAt) > window) continue;

    const { confidence, swapped } = scoreTeams(aliases, candidate.teams);
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

  const direct = nameScore(pmOutcomes[0], ggbetSelections[0].name) +
    nameScore(pmOutcomes[1], ggbetSelections[1].name);
  const crossed = nameScore(pmOutcomes[0], ggbetSelections[1].name) +
    nameScore(pmOutcomes[1], ggbetSelections[0].name);
  if (direct === 0 && crossed === 0) return null;
  return crossed > direct ? [1, 0] : [0, 1];
}

/** De-vigged probability of the first outcome from a pair of decimal odds. */
export function devig(oddsA, oddsB) {
  if (!(oddsA > 1) || !(oddsB > 1)) return null;
  const a = 1 / oddsA;
  return a / (a + 1 / oddsB);
}
