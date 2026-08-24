// Turns two consecutive views of a match into a list of what changed.
//
// The odds history in odds-history.csv answers "what was the price at time T".
// This answers a different question — "what happened" — so a score moving, a
// market being suspended and a price drifting all appear as one ordered stream.

/** Scalar fields worth a log line, paired with the name used in the log. */
const FIELDS = [
  ['score', 'score'],
  ['segmentNo', 'segment'],
  ['segmentName', 'segment_name'],
  ['segmentScore', 'segment_score'],
  ['round', 'round'],
  ['state', 'state'],
  ['betStop', 'bet_stop'],
];

function oddsIndex(match) {
  const index = new Map();
  for (const market of match?.markets ?? []) {
    for (const odd of market.odds) {
      index.set(`${market.id}|${odd.id}`, { market, odd });
    }
  }
  return index;
}

/**
 * @param {object|null} before  view before the frame, null if the match is new
 * @param {object} after        view after the frame
 * @returns {Array<{kind:string,target:string|null,from:*,to:*}>}
 */
export function diffMatch(before, after) {
  if (!after?.resolved) return [];

  // A match only becomes loggable once the snapshot names the teams; treat that
  // moment as its start rather than replaying every field as a change.
  if (!before?.resolved) {
    return [{ kind: 'match_start', target: null, from: null, to: after.title }];
  }

  const changes = [];
  for (const [field, kind] of FIELDS) {
    if (before[field] !== after[field] && after[field] !== null && after[field] !== undefined) {
      changes.push({ kind, target: null, from: before[field], to: after[field] });
    }
  }

  const was = oddsIndex(before);
  const now = oddsIndex(after);
  for (const [key, { market, odd }] of now) {
    const previous = was.get(key);
    const label = `${market.name} / ${odd.name}`;
    if (!previous) {
      changes.push({ kind: 'market_open', target: label, from: null, to: odd.price });
      continue;
    }
    if (previous.odd.price !== odd.price) {
      changes.push({ kind: 'price', target: label, from: previous.odd.price, to: odd.price });
    }
    if (previous.odd.isActive !== odd.isActive) {
      changes.push({
        kind: odd.isActive ? 'odd_resumed' : 'odd_suspended',
        target: label, from: previous.odd.isActive, to: odd.isActive,
      });
    }
  }
  for (const [key, { market, odd }] of was) {
    if (!now.has(key)) {
      changes.push({ kind: 'market_closed', target: `${market.name} / ${odd.name}`, from: odd.price, to: null });
    }
  }
  return changes;
}
