// Module B — order book state and sweep detection.
//
// Protocol, as recorded in samples-pm/ws-frames.json:
//   - the first frame after subscribing is an ARRAY of `book` snapshots, one per
//     asset; every later frame is a single OBJECT
//   - `book` is a full replacement, resent periodically, which resyncs us
//   - `price_change` carries { asset_id, price, size, side } where `size` is the
//     NEW resting size at that price, not a delta; zero removes the level
//   - `last_trade_price` is a print, not a book event
//
// Prices are keyed as integer thousandths so "0.1" and "0.10" cannot become two
// different levels.

const key = (price) => Math.round(Number(price) * 1000);
const toPrice = (k) => k / 1000;

/** Live state of one asset's book. */
export class BookState {
  #bids = new Map();
  #asks = new Map();

  constructor(assetId, { conditionId = null, tickSize = 0.01 } = {}) {
    this.assetId = assetId;
    this.conditionId = conditionId;
    this.tickSize = tickSize;
    this.lastUpdate = 0;
  }

  /** Replace the whole book from a `book` message. */
  applyBook(message) {
    this.#bids = new Map();
    this.#asks = new Map();
    for (const level of message.bids ?? []) this.#set(this.#bids, level.price, level.size);
    for (const level of message.asks ?? []) this.#set(this.#asks, level.price, level.size);
    if (message.tick_size) this.tickSize = Number(message.tick_size);
    if (message.market) this.conditionId ??= message.market;
    this.lastUpdate = Number(message.timestamp) || Date.now();
  }

  /** Apply one entry of a `price_change` message. */
  applyPriceChange(entry, timestamp) {
    const side = entry.side === 'SELL' ? this.#asks : this.#bids;
    this.#set(side, entry.price, entry.size);
    this.lastUpdate = Number(timestamp) || Date.now();
  }

  #set(side, price, size) {
    const amount = Number(size);
    const at = key(price);
    if (!Number.isFinite(amount) || amount <= 0) side.delete(at);
    else side.set(at, amount);
  }

  get bestBid() {
    let best = null;
    for (const at of this.#bids.keys()) if (best === null || at > best) best = at;
    return best === null ? null : toPrice(best);
  }

  get bestAsk() {
    let best = null;
    for (const at of this.#asks.keys()) if (best === null || at < best) best = at;
    return best === null ? null : toPrice(best);
  }

  /** Resting bid size at exactly this price. The columns fill rate is read from. */
  sizeAt(price) {
    return this.#bids.get(key(price)) ?? 0;
  }

  /** Total resting bid size strictly above a price, for the depth-collapse rule. */
  bidDepthAbove(price) {
    const floor = key(price);
    let total = 0;
    for (const [at, size] of this.#bids) if (at > floor) total += size;
    return total;
  }

  #total(side) {
    let sum = 0;
    for (const size of side.values()) sum += size;
    return sum;
  }

  /** Bid levels at or above a price, newest state, for counting what was eaten. */
  bidLevelsAbove(price) {
    const floor = key(price);
    return [...this.#bids.entries()].filter(([at]) => at > floor)
      .sort((a, b) => b[0] - a[0]).map(([at, size]) => [toPrice(at), size]);
  }

  /** One row for the `book` table. */
  metrics(ts, trigger) {
    const bid = this.bestBid;
    const ask = this.bestAsk;
    return [
      ts, this.assetId, this.conditionId, trigger,
      bid, ask, bid !== null && ask !== null ? (bid + ask) / 2 : null,
      this.sizeAt(0.01), this.sizeAt(0.02), this.sizeAt(0.03), this.sizeAt(0.05),
      this.#total(this.#bids), this.#total(this.#asks), this.#bids.size,
      bid !== null && ask !== null ? ask - bid : null,
    ];
  }
}

/**
 * Flags the book collapses the strategy feeds on.
 *
 * Two independent rules, both logged with which one fired:
 *   - the best bid falls by at least `bidDropTicks` of THIS market's tick, or
 *     `bidDropMin` absolute, whichever is larger. The tick is per-market — the
 *     esports books sampled run at 0.01 but some at 0.001, where three ticks
 *     would be 0.003 and would fire on noise.
 *   - resting depth above `depthAbovePrice` loses more than `depthDropRatio`
 *     within `depthWindowSeconds`.
 *
 * Sweeps that stop short of 1-2 cents matter as much as the ones that reach it:
 * they are the denominator of the fill rate.
 */
export class SweepDetector {
  #history = new Map();

  constructor(config) {
    this.config = config;
  }

  /**
   * @param {BookState} book  state AFTER the update
   * @param {{bestBid: number|null, depth: number, levels: Array}} before  state BEFORE
   * @param {string} ts  ISO timestamp
   * @returns {Array|null} a row for the `sweeps` table
   */
  observe(book, before, ts) {
    const { levelsCrossed, bidDropTicks = 3, bidDropMin = 0.02,
      depthWindowSeconds, depthDropRatio, depthAbovePrice } = this.config;

    const after = book.bestBid;
    const depthAfter = book.bidDepthAbove(depthAbovePrice);
    const rules = [];

    if (before.bestBid !== null && after !== null && after < before.bestBid) {
      const threshold = Math.max(bidDropTicks * book.tickSize, bidDropMin);
      if (before.bestBid - after >= threshold - 1e-9) rules.push('bid_drop');
    }

    // Levels that stood above the new best bid and are gone or thinner.
    const eaten = before.levels.filter(([price]) => after === null || price > after);
    if (eaten.length >= levelsCrossed) rules.push('levels');

    const window = this.#history.get(book.assetId) ?? [];
    const cutoff = Date.parse(ts) - depthWindowSeconds * 1000;
    while (window.length && window[0].at < cutoff) window.shift();
    const peak = window.reduce((max, point) => Math.max(max, point.depth), before.depth);
    if (peak > 0 && depthAfter < peak * (1 - depthDropRatio)) rules.push('depth_collapse');
    window.push({ at: Date.parse(ts), depth: depthAfter });
    this.#history.set(book.assetId, window);

    if (!rules.length) return null;
    const consumed = eaten.reduce((sum, [, size]) => sum + size, 0);
    return [ts, book.assetId, book.conditionId, rules.join('+'),
      before.bestBid, after, consumed, eaten.length, before.depth, depthAfter];
  }

  /** State to capture before applying an update, so the two can be compared. */
  static snapshot(book, depthAbovePrice) {
    return {
      bestBid: book.bestBid,
      depth: book.bidDepthAbove(depthAbovePrice),
      levels: book.bidLevelsAbove(0),
    };
  }

  forget(assetId) {
    this.#history.delete(assetId);
  }
}
