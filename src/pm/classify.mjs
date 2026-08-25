// Turns a raw Gamma market into the fields the collector and the analyzer need.
//
// Two things make this less trivial than reading a field:
//
// 1. The discipline is only reliable in the event slug. "Map 1 Rounds Handicap:
//    A (-6.5) vs B (+6.5)" and "Games Total: O/U 2.5" name no sport at all.
// 2. Level and kind are independent axes. "Map 3 Total Rounds: O/U 24.5" is a
//    total inside a segment, while "Games Total: O/U 2.5" is a total over the
//    whole match. Collapsing them into one label loses the distinction the bot
//    study depends on, since it works segment-level and loses money match-level.

const SEGMENT = /\b(map|game|set)\s*(\d+)\b/i;
const HANDICAP = /handicap/i;
const TOTAL = /\btotal|\bo\/u\b|over\/under/i;
const WINNER = /winner/i;
const LINE = /([+-]?\d+(?:\.\d+)?)/;
const VERSUS = /^(.*?)\s+vs\.?\s+(.*?)$/i;

/** Gamma encodes these as JSON strings, not arrays. */
export function parseJsonField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const slugPrefix = (slug) => (typeof slug === 'string' ? (slug.split('-')[0] || null) : null);

/**
 * Strip a competitor name down to the team.
 * Order matters: an event title reads "A vs B (BO3) - Tournament", so the
 * tournament tail has to go before the trailing "(BO3)" is even at the end.
 */
const cleanTeam = (name) =>
  name.replace(/\s+-\s+.*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();

/**
 * Competitors, in outcome order where the outcomes name them. Totals answer
 * Over/Under, so their teams come from the question or the event title instead.
 */
function teamsOf(question, eventTitle, outcomes) {
  if (outcomes.length === 2 && !/^(over|under|yes|no)$/i.test(outcomes[0])) {
    return outcomes.map(cleanTeam);
  }
  for (const text of [question, eventTitle]) {
    const body = String(text ?? '').replace(/^[^:]*:\s*/, '');
    const match = VERSUS.exec(body);
    if (match) return [cleanTeam(match[1]), cleanTeam(match[2])];
  }
  return null;
}

function lineOf(question, kind) {
  if (kind === 'winner') return null;
  // For a handicap the sign matters and belongs to the first competitor; for a
  // total the number is the line itself.
  const tail = kind === 'handicap' ? /\(([+-]\d+(?:\.\d+)?)\)/.exec(question) : null;
  const match = tail ?? LINE.exec(question.replace(SEGMENT, ''));
  return match ? Number(match[1]) : null;
}

/**
 * @param {object} market  a Gamma /markets element
 * @param {Record<string,string>} disciplines  event-slug prefix -> gg.bet sportId
 * @returns {object} normalized market record
 */
export function classifyMarket(market, disciplines = {}) {
  const question = String(market.question ?? '');
  const event = (market.events ?? [])[0] ?? {};
  const prefix = slugPrefix(event.slug);
  const segment = SEGMENT.exec(question);

  const kind = HANDICAP.test(question) ? 'handicap'
    : TOTAL.test(question) ? 'total'
    : WINNER.test(question) ? 'winner'
    : 'winner'; // a bare "A vs B (BO3) - Tournament" is the match winner

  const outcomes = parseJsonField(market.outcomes);
  const tokens = parseJsonField(market.clobTokenIds);

  return {
    conditionId: market.conditionId ?? null,
    question,
    slug: market.slug ?? null,
    eventSlug: event.slug ?? null,
    eventTitle: event.title ?? null,
    endDate: market.endDate ?? null,
    startDate: market.startDate ?? null,
    prefix,
    sport: (prefix && disciplines[prefix]) ?? null,
    level: segment ? 'segment' : 'match',
    kind,
    segmentKind: segment ? segment[1].toLowerCase() : null,
    segmentNo: segment ? Number(segment[2]) : null,
    line: lineOf(question, kind),
    teams: teamsOf(question, event.title, outcomes),
    outcomes,
    tokens,
    tickSize: Number(market.orderPriceMinTickSize ?? 0.001),
    minSize: Number(market.orderMinSize ?? 0),
    enableOrderBook: market.enableOrderBook !== false,
  };
}

/** Markets worth subscribing to: a known discipline and a live order book. */
export function isTracked(record) {
  return Boolean(record.sport) && record.enableOrderBook && record.tokens.length === 2;
}
