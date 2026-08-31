// Module A2 — when a market is worth watching.
//
// Discovery used to double as the subscription window: the registry held
// whatever the current Gamma page returned, so a market was watched from the
// moment it appeared until newer markets pushed it out of the first
// `maxPages * pageSize` rows sorted by startDate. That window is a property of
// Polymarket's market-creation rate, not of the match: measured against the live
// API it is about half an hour deep, and a real collection came out at a median
// of 61 minutes of observation per market, ending roughly a day before the game
// was played. Every book row landed before anyone was trading, and not one fill
// of the studied wallets fell inside a watched window.
//
// So the lifecycle moves here. Discovery only ever *adds* to the schedule —
// markets are seen 11-15 hours ahead of their game — and the clock decides when
// to subscribe and when to let go:
//
//   subscribe    now >= game_start - leadMinutes  (or at once, if that passed)
//   unsubscribe  the market resolved, or now > game_start + hold(discipline)
//
// A market in the window is never dropped for being quiet or for falling out of
// Gamma's page, which is what used to happen.
//
// `end_date` deliberately does not decide the window. It is a resolution
// deadline, not the end of play: measured on live data it runs game + 6h for
// CS2 and game + 168h for ITF tennis, so unsubscribing by it would hold a
// tennis book for a week after the match ended.

/** Hours after the game start a market is still worth watching, by gg.bet sportId. */
export const DEFAULT_HOLD_HOURS = {
  esports_counter_strike: 6,
  esports_dota_2: 8,
  esports_league_of_legends: 6,
  esports_valorant: 6,
  esports_rainbow_six: 6,
  esports_call_of_duty: 6,
  tennis: 5,
  table_tennis: 2,
};

/**
 * Parse the timestamps Polymarket mixes in one payload.
 *
 * `endDate` is ISO ("2026-09-08T07:30:00Z") but `gameStartTime` comes back as
 * "2026-09-01 07:30:00+00" — a space instead of the T and a two-digit offset,
 * which `Date.parse` reads as invalid in some runtimes and as local time in
 * others. Both failures are silent and would put the whole schedule hours off.
 *
 * @returns {number|null} epoch ms
 */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let text = String(value).trim();
  if (!text) return null;
  text = text.replace(' ', 'T');
  // "+00" and "-0730" are both legal in Postgres output and neither is ISO.
  text = text.replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  // A bare timestamp with no zone is UTC here: every Polymarket field is.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) text += 'Z';
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
}

const HOUR = 3600 * 1000;

/**
 * When play starts, and how we know.
 *
 * @returns {{at: number, source: string}|null}
 */
export function gameStartOf(record, { holdHours = DEFAULT_HOLD_HOURS, maxAheadHours = 72 } = {}, now = Date.now()) {
  const stated = parseTimestamp(record.gameStartTime);
  if (stated !== null) return { at: stated, source: 'game_start_time' };

  // Fallback: the resolution deadline minus a typical match. Only usable where
  // the deadline is close enough to be about this match at all — the tennis
  // template sets it a week out, and backing off five hours from that would
  // schedule the subscription six days after the match finished.
  const end = parseTimestamp(record.endDate);
  if (end === null) return null;
  const hold = holdHours[record.sport] ?? holdHours.default ?? 6;
  const at = end - hold * HOUR;
  if (at - now > maxAheadHours * HOUR) return null;
  return { at, source: 'end_date_minus_typical' };
}

/**
 * The set of markets under subscription, driven by the clock rather than by
 * whatever Gamma happened to return this round.
 */
export class MarketSchedule {
  /** condition id -> entry. Entries are kept after release, so a market is not rescheduled. */
  #entries = new Map();
  #live = new Set();
  #assets = new Map();

  constructor(config = {}) {
    this.config = {
      leadMinutes: 10,
      holdHours: DEFAULT_HOLD_HOURS,
      maxAheadHours: 72,
      resolutionCheckMinutes: 15,
      resolutionCheckAfterMinutes: 45,
      ...config,
      holdHours: { ...DEFAULT_HOLD_HOURS, ...(config.holdHours ?? {}) },
    };
  }

  /**
   * Take what discovery classified as trackable and schedule it.
   *
   * Records already in the schedule are refreshed in place — Gamma restates
   * `gameStartTime` when a match is delayed — but a released market is never
   * revived, or a finished match would be resubscribed on every round.
   *
   * @returns {{scheduled: object[], skipped: {conditionId: string, reason: string}[]}}
   */
  observe(records, now = Date.now()) {
    const scheduled = [];
    const skipped = [];
    for (const record of records) {
      const known = this.#entries.get(record.conditionId);
      if (known?.releasedAt) continue;

      const start = gameStartOf(record, this.config, now);
      if (!start) {
        skipped.push({
          conditionId: record.conditionId,
          reason: record.gameStartTime || record.endDate
            ? 'resolution deadline too far to date the match'
            : 'no game start time and no end date',
          record,
        });
        continue;
      }

      const hold = this.config.holdHours[record.sport] ?? this.config.holdHours.default ?? 6;
      const entry = known ?? {
        conditionId: record.conditionId,
        subscribedAt: null,
        releasedAt: null,
        releaseReason: null,
        observedDuringGame: false,
        resolved: false,
        resolutionCheckedAt: 0,
      };
      entry.record = record;
      entry.gameStart = start.at;
      entry.gameStartSource = start.source;
      entry.subscribeAt = start.at - this.config.leadMinutes * 60 * 1000;
      entry.holdUntil = start.at + hold * HOUR;
      this.#entries.set(record.conditionId, entry);
      if (!known) scheduled.push(entry);
    }
    return { scheduled, skipped };
  }

  /**
   * Move the clock. Everything that came due is subscribed, everything past its
   * hold or already resolved is let go.
   *
   * @returns {{added: object[], removed: object[], live: object[]}}
   */
  refresh(now = Date.now()) {
    const added = [];
    const removed = [];
    for (const entry of this.#entries.values()) {
      if (entry.releasedAt) continue;

      if (this.#live.has(entry.conditionId)) {
        const reason = entry.resolved ? 'resolved'
          : now > entry.holdUntil ? 'past the hold window'
          : null;
        if (reason) {
          this.#release(entry, reason, now);
          removed.push(entry);
        }
        continue;
      }

      // Not live yet. A market that resolved before we ever subscribed — a
      // match played out while the collector was down — is closed out silently.
      if (entry.resolved || now > entry.holdUntil) {
        this.#release(entry, entry.resolved ? 'resolved' : 'window passed unwatched', now);
        continue;
      }
      if (now >= entry.subscribeAt) {
        entry.subscribedAt = new Date(now).toISOString();
        this.#live.add(entry.conditionId);
        for (const assetId of entry.record.tokens) this.#assets.set(assetId, entry.conditionId);
        added.push(entry);
      }
    }
    return { added, removed, live: this.live() };
  }

  #release(entry, reason, now) {
    entry.releasedAt = new Date(now).toISOString();
    entry.releaseReason = reason;
    this.#live.delete(entry.conditionId);
    for (const assetId of entry.record.tokens) this.#assets.delete(assetId);
  }

  /** A market the resolver reports closed; it stops being watched on the next refresh. */
  markResolved(conditionId) {
    const entry = this.#entries.get(conditionId);
    if (!entry) return false;
    entry.resolved = true;
    return true;
  }

  /**
   * Live markets whose resolution is worth re-checking.
   *
   * Checking costs a CLOB request per market, so it only starts once the match
   * has had time to finish and repeats no more often than configured.
   */
  dueForResolutionCheck(now = Date.now(), limit = 25) {
    const after = this.config.resolutionCheckAfterMinutes * 60 * 1000;
    const every = this.config.resolutionCheckMinutes * 60 * 1000;
    const due = [];
    for (const conditionId of this.#live) {
      const entry = this.#entries.get(conditionId);
      if (!entry || entry.resolved) continue;
      if (now - entry.gameStart < after) continue;
      if (now - entry.resolutionCheckedAt < every) continue;
      due.push(entry);
      if (due.length >= limit) break;
    }
    for (const entry of due) entry.resolutionCheckedAt = now;
    return due;
  }

  /**
   * Record that the book was actually seen while the match was being played.
   *
   * This is the self-check the whole change exists for, and it is kept live
   * rather than derived later so that a glance at markets.csv answers it.
   *
   * @returns {boolean} true the first time, so the caller can write it once
   */
  noteObserved(conditionId, now = Date.now()) {
    const entry = this.#entries.get(conditionId);
    if (!entry || entry.observedDuringGame) return false;
    if (now < entry.gameStart || now > entry.holdUntil) return false;
    entry.observedDuringGame = true;
    return true;
  }

  entry(conditionId) {
    return this.#entries.get(conditionId) ?? null;
  }

  /** Records under subscription right now. */
  live() {
    return [...this.#live].map((id) => this.#entries.get(id));
  }

  /** Every asset id under subscription, two per market. */
  assetIds() {
    return [...this.#assets.keys()];
  }

  conditionOf(assetId) {
    return this.#assets.get(assetId) ?? null;
  }

  get liveSize() {
    return this.#live.size;
  }

  get size() {
    return this.#entries.size;
  }

  /** Markets scheduled but not yet due, for the status line. */
  get pendingSize() {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (!entry.releasedAt && !this.#live.has(entry.conditionId)) count++;
    }
    return count;
  }
}
