// Module C — joining a Polymarket token to the gg.bet quote that prices the
// same question, and producing the row the whole study turns on.
//
// A link is per-token, not per-market: each Polymarket market has two tokens,
// and the fair value of one is the complement of the other. Getting that
// direction wrong is silent and would invert every dislocation figure, so the
// side is resolved by outcome name rather than by position.

import { alignOutcomes, findMatch } from './match.mjs';

const keyOf = (market) => `${market.matchId}|${market.market}`;

/**
 * Resolve every tracked Polymarket token to a gg.bet market.
 *
 * A verified row in the mapping table wins outright; otherwise the matcher
 * proposes one and the table records it for a person to confirm or correct.
 *
 * @returns {Map<string, object>} asset id -> link
 */
export function buildLinks({ markets, ggbetMarkets, mapping, minConfidence = 0.7, windowHours = 6, now = Date.now() }) {
  const byKey = new Map(ggbetMarkets.map((m) => [keyOf(m), m]));
  const links = new Map();

  for (const record of markets) {
    const pinned = mapping?.get(record.conditionId);
    let candidate = null;
    let confidence = 0;

    if (pinned?.verified) {
      candidate = byKey.get(`${pinned.ggbet_match_id}|${pinned.ggbet_segment}`) ?? null;
      confidence = 1;
    }
    if (!candidate) {
      const found = findMatch(record, ggbetMarkets, { minConfidence, windowHours, now });
      if (!found) continue;
      candidate = found;
      confidence = found.confidence;
      mapping?.propose({
        conditionId: record.conditionId,
        ggbetMatchId: found.matchId,
        pmSegment: record.segmentNo ? `${record.segmentKind}${record.segmentNo}` : '',
        ggbetSegment: found.market,
        confidence,
      });
    }

    const alignment = alignOutcomes(record.outcomes, candidate.selections);
    if (!alignment) continue;

    record.tokens.forEach((assetId, index) => {
      links.set(assetId, {
        assetId,
        conditionId: record.conditionId,
        ggbetKey: keyOf(candidate),
        // fair is the probability of the gg.bet feed's FIRST selection, so a
        // token aligned to the second one takes the complement.
        complement: alignment[index] === 1,
        confidence,
      });
    });
  }
  return links;
}

/**
 * One row for the `joined` table.
 * @param {string} ts  ISO timestamp
 * @param {object} link  from buildLinks
 * @param {object} book  the BookState for this token
 * @param {object} ggbet  the gg.bet market it is linked to
 * @param {number} now  epoch ms, for quote staleness
 */
export function joinedRow(ts, link, book, ggbet, now = Date.now()) {
  const bid = book.bestBid;
  const ask = book.bestAsk;
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const fair = ggbet.fair === null || ggbet.fair === undefined
    ? null
    : link.complement ? 1 - ggbet.fair : ggbet.fair;

  return [
    ts, link.conditionId, link.assetId, bid, ask, mid,
    fair, ggbet.active ? 'active' : 'suspended', ggbet.score, ggbet.segmentScore,
    // The metric the study exists to measure. Undefined without both sides.
    fair !== null && mid ? fair / mid : null,
    // gg.bet writes only on a price change, so the age of its newest row is the
    // age of this fair value. Without it there is no telling whether a
    // dislocation is real or just a quote that stopped updating.
    ggbet.updatedAt ? (now - ggbet.updatedAt) / 1000 : null,
  ];
}
