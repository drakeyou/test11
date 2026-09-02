// Module B2 — what happened after a sweep.
//
// A collapse is only half an observation. The question the study asks is what
// the book did next: a bid swept to a cent that trades back to four cents in
// five minutes is the whole thesis, and one that never recovers is the
// counter-example. Neither is readable from the sweeps table alone.
//
// The horizons are filled from the snapshots already streaming in — a running
// maximum per open horizon, updated on every book event for that asset — rather
// than by querying the book afterwards or asking the API. That costs one number
// per open sweep and nothing else.
//
// A market that resolves before a horizon expires is not a missing measurement:
// the token is worth its payout and there is no book left to recover in. Those
// rows carry the payout and say so, so they cannot be mistaken for a gap.

export const DEFAULT_HORIZONS = [1, 5, 15];

export class FollowupTracker {
  /** sweep id -> { assetId, conditionId, pending: Map<minutes, {dueAt, high}> } */
  #open = new Map();
  /** asset id -> Set of sweep ids, so a book update finds its horizons in O(1). */
  #byAsset = new Map();

  constructor({ horizons = DEFAULT_HORIZONS } = {}) {
    this.horizons = [...horizons].sort((a, b) => a - b);
  }

  /**
   * Start following a sweep.
   * @param {string} sweepId
   * @param {string} assetId
   * @param {string} conditionId
   * @param {number} at  epoch ms of the sweep
   * @param {number|null} bidAfter  the bid the sweep left behind, the first sample
   * @param {number} lastUpdate  the book's own clock at the sweep, for book_frozen
   */
  open(sweepId, assetId, conditionId, at, bidAfter = null, lastUpdate = 0) {
    if (this.#open.has(sweepId)) return;
    const pending = new Map();
    for (const minutes of this.horizons) {
      pending.set(minutes, { dueAt: at + minutes * 60 * 1000, high: bidAfter });
    }
    this.#open.set(sweepId, { sweepId, assetId, conditionId, pending, lastUpdate, moved: false });
    if (!this.#byAsset.has(assetId)) this.#byAsset.set(assetId, new Set());
    this.#byAsset.get(assetId).add(sweepId);
  }

  /**
   * Feed one book observation into every horizon still open on this asset.
   *
   * `lastUpdate` is the book's own clock and moves only on a real change, never
   * on a heartbeat. A horizon that ends without it having moved is a market
   * that died at the collapse — a total decided, a handicap closed — rather
   * than a sweep nobody bid back into, and the two must not be pooled.
   */
  observe(assetId, bid, lastUpdate = 0) {
    const sweeps = this.#byAsset.get(assetId);
    if (!sweeps) return;
    for (const sweepId of sweeps) {
      const entry = this.#open.get(sweepId);
      if (!entry) continue;
      if (lastUpdate > entry.lastUpdate) entry.moved = true;
      if (bid === null || bid === undefined) continue;
      for (const horizon of entry.pending.values()) {
        if (horizon.high === null || bid > horizon.high) horizon.high = bid;
      }
    }
  }

  /**
   * The market resolved: close every horizon it still has open at the payout.
   * @param {string} conditionId
   * @param {(assetId: string) => number|null} payoutOf
   * @returns {Array[]} rows for the sweep_followups table
   */
  resolved(conditionId, payoutOf, now = Date.now()) {
    const rows = [];
    const at = new Date(now).toISOString();
    for (const entry of [...this.#open.values()]) {
      if (entry.conditionId !== conditionId) continue;
      const payout = payoutOf(entry.assetId);
      for (const minutes of entry.pending.keys()) {
        rows.push([entry.sweepId, entry.assetId, entry.conditionId, minutes,
          payout ?? null, at, 1, FollowupTracker.#frozen(entry)]);
      }
      this.#close(entry);
    }
    return rows;
  }

  /**
   * Horizons that have come due.
   * @returns {Array[]} rows for the sweep_followups table
   */
  due(now = Date.now()) {
    const rows = [];
    const at = new Date(now).toISOString();
    for (const entry of this.#open.values()) {
      for (const [minutes, horizon] of entry.pending) {
        if (now < horizon.dueAt) continue;
        rows.push([entry.sweepId, entry.assetId, entry.conditionId, minutes,
          horizon.high, at, 0, FollowupTracker.#frozen(entry)]);
        entry.pending.delete(minutes);
      }
      if (entry.pending.size === 0) this.#close(entry);
    }
    return rows;
  }

  /**
   * Give up on an asset that is no longer being watched.
   *
   * Everything still open is written with what was seen up to here, flagged as
   * cut short, so a subscription ending mid-horizon leaves a truncated
   * measurement rather than a silent hole.
   */
  forget(assetId, now = Date.now()) {
    const sweeps = this.#byAsset.get(assetId);
    if (!sweeps) return [];
    const rows = [];
    const at = new Date(now).toISOString();
    for (const sweepId of [...sweeps]) {
      const entry = this.#open.get(sweepId);
      if (!entry) continue;
      for (const [minutes, horizon] of entry.pending) {
        rows.push([entry.sweepId, entry.assetId, entry.conditionId, minutes,
          horizon.high, at, 0, FollowupTracker.#frozen(entry)]);
      }
      this.#close(entry);
    }
    return rows;
  }

  /**
   * Did the book stand still for the whole horizon?
   *
   * Null when the caller gave no book clock to compare against: with no
   * baseline there is no claim to make, and answering "frozen" would invent a
   * dead market out of a missing argument.
   */
  static #frozen(entry) {
    if (!entry.lastUpdate) return null;
    return entry.moved ? 0 : 1;
  }

  #close(entry) {
    this.#open.delete(entry.sweepId);
    const sweeps = this.#byAsset.get(entry.assetId);
    if (!sweeps) return;
    sweeps.delete(entry.sweepId);
    if (sweeps.size === 0) this.#byAsset.delete(entry.assetId);
  }

  get size() {
    return this.#open.size;
  }

  /** Markets with a horizon still running, so their resolution is worth asking about. */
  openConditions() {
    const out = new Set();
    for (const entry of this.#open.values()) out.add(entry.conditionId);
    return out;
  }
}

/** Stable id for a sweep: the table has no key of its own and rows are buffered. */
export const sweepIdOf = (assetId, ts) => `${assetId}:${ts}`;
