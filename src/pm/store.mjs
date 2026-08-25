// SQLite storage, one file per UTC day.
//
// node:sqlite ships with Node 22, so the collector needs no database driver and
// no build step. Writes are buffered and flushed inside a transaction: at ~100
// book rows a second, a transaction per row would spend all its time on fsync.
//
// The daily file keeps any single database a workable size (a day is roughly a
// gigabyte at 500 tracked tokens) and lets the analyzer pick a date range by
// opening only the files it needs.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS markets (
  condition_id TEXT PRIMARY KEY, asset_id_a TEXT, asset_id_b TEXT,
  question TEXT, slug TEXT, event_slug TEXT, event_title TEXT,
  sport TEXT, level TEXT, kind TEXT, segment_kind TEXT, segment_no INTEGER,
  line REAL, team_a TEXT, team_b TEXT, outcome_a TEXT, outcome_b TEXT,
  end_date TEXT, tick_size REAL, min_size REAL,
  first_seen TEXT, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS book (
  ts TEXT, asset_id TEXT, condition_id TEXT, trigger TEXT,
  best_bid REAL, best_ask REAL, mid REAL,
  size_at_001 REAL, size_at_002 REAL, size_at_003 REAL, size_at_005 REAL,
  depth_bid_total REAL, depth_ask_total REAL, n_bid_levels INTEGER, spread REAL
);
CREATE TABLE IF NOT EXISTS sweeps (
  ts TEXT, asset_id TEXT, condition_id TEXT, rule TEXT,
  bid_before REAL, bid_after REAL, size_consumed REAL, levels_crossed INTEGER,
  depth_before REAL, depth_after REAL
);
CREATE TABLE IF NOT EXISTS joined (
  ts TEXT, condition_id TEXT, asset_id TEXT,
  pm_best_bid REAL, pm_best_ask REAL, pm_mid REAL,
  ggbet_fair REAL, ggbet_market_state TEXT, score TEXT, segment_score TEXT,
  dislocation_ratio REAL, seconds_since_ggbet_quote REAL
);
CREATE TABLE IF NOT EXISTS wallets (
  ts TEXT, address TEXT, activity_id TEXT, type TEXT, side TEXT,
  asset_id TEXT, condition_id TEXT, price REAL, size REAL, tx_hash TEXT,
  UNIQUE (address, activity_id)
);
CREATE TABLE IF NOT EXISTS trades (
  ts TEXT, condition_id TEXT, asset_id TEXT, wallet TEXT, side TEXT,
  price REAL, size REAL, role TEXT, tx_hash TEXT,
  UNIQUE (tx_hash, wallet, asset_id, side, size, price)
);
CREATE TABLE IF NOT EXISTS gaps (
  started_at TEXT, ended_at TEXT, duration_ms INTEGER, reason TEXT,
  assets_resubscribed INTEGER
);
CREATE INDEX IF NOT EXISTS book_asset_ts ON book (asset_id, ts);
CREATE INDEX IF NOT EXISTS sweeps_asset_ts ON sweeps (asset_id, ts);
CREATE INDEX IF NOT EXISTS joined_cond_ts ON joined (condition_id, ts);
CREATE INDEX IF NOT EXISTS trades_asset_ts ON trades (asset_id, ts);
`;

const INSERTS = {
  book: `INSERT INTO book VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  sweeps: `INSERT INTO sweeps VALUES (?,?,?,?,?,?,?,?,?,?)`,
  joined: `INSERT INTO joined VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  wallets: `INSERT OR IGNORE INTO wallets VALUES (?,?,?,?,?,?,?,?,?,?)`,
  trades: `INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?,?,?,?)`,
  gaps: `INSERT INTO gaps VALUES (?,?,?,?,?)`,
};

const MARKET_UPSERT = `
INSERT INTO markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(condition_id) DO UPDATE SET last_seen = excluded.last_seen,
  end_date = excluded.end_date, tick_size = excluded.tick_size, min_size = excluded.min_size`;

export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

export class Store {
  #dir;
  #day = null;
  #db = null;
  #statements = null;
  #market = null;
  #buffers = { book: [], sweeps: [], joined: [], wallets: [], trades: [], gaps: [] };
  #flushAt;
  #maxBuffered;

  /**
   * @param {string} dir  directory for the daily database files
   * @param {object} [options]
   * @param {number} [options.flushMs]
   * @param {number} [options.maxBuffered]
   * @param {() => Date} [options.now]  injectable clock, so rotation is testable
   * @param {(day: string) => void} [options.onRotate]  called after a new day opens
   */
  constructor(dir, { flushMs = 1000, maxBuffered = 2000, now = () => new Date(), onRotate = null } = {}) {
    this.#dir = dir;
    this.#maxBuffered = maxBuffered;
    this.now = now;
    this.onRotate = onRotate;
    mkdirSync(dir, { recursive: true });
    this.#open(utcDay(now()));
    this.#flushAt = setInterval(() => this.flush(), flushMs);
    this.#flushAt.unref?.();
  }

  #open(day) {
    this.#db = new DatabaseSync(join(this.#dir, `pm-${day}.sqlite`));
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec(SCHEMA);
    this.#statements = Object.fromEntries(
      Object.entries(INSERTS).map(([table, sql]) => [table, this.#db.prepare(sql)]),
    );
    this.#market = this.#db.prepare(MARKET_UPSERT);
    this.#day = day;
  }

  /**
   * Roll over at UTC midnight so no file grows without bound.
   *
   * The new file starts with an empty `markets` table, so anything written
   * before the next discovery round would have no discipline to join against.
   * onRotate is where the caller re-registers what it is tracking.
   */
  #rotateIfNeeded() {
    const today = utcDay(this.now());
    if (today === this.#day) return;
    this.#drain();
    this.#db.close();
    this.#open(today);
    this.onRotate?.(today);
  }

  get path() {
    return join(this.#dir, `pm-${this.#day}.sqlite`);
  }

  /** Queue a row; it reaches disk on the next flush. */
  add(table, row) {
    this.#buffers[table].push(row);
    if (this.#buffers[table].length >= this.#maxBuffered) this.flush();
  }

  upsertMarket(record, seenAt = new Date().toISOString()) {
    this.#rotateIfNeeded();
    const [a, b] = record.tokens;
    this.#market.run(
      record.conditionId, a ?? null, b ?? null, record.question, record.slug,
      record.eventSlug, record.eventTitle, record.sport, record.level, record.kind,
      record.segmentKind, record.segmentNo, record.line,
      record.teams?.[0] ?? null, record.teams?.[1] ?? null,
      record.outcomes?.[0] ?? null, record.outcomes?.[1] ?? null,
      record.endDate, record.tickSize, record.minSize, seenAt, seenAt,
    );
  }

  /** Write everything buffered in one transaction per table. */
  flush() {
    this.#rotateIfNeeded();
    this.#drain();
  }

  #drain() {
    for (const [table, rows] of Object.entries(this.#buffers)) {
      if (!rows.length) continue;
      const statement = this.#statements[table];
      this.#db.exec('BEGIN');
      try {
        for (const row of rows) statement.run(...row);
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        console.error(`flush to ${table} failed: ${err.message}`);
      }
      rows.length = 0;
    }
  }

  /** Maker/taker split of what has been stored, for the status line. */
  roleCounts() {
    const rows = this.#db.prepare('SELECT role, count(*) AS c FROM trades GROUP BY role').all();
    return Object.fromEntries(rows.map((r) => [r.role, r.c]));
  }

  count(table) {
    return this.#db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
  }

  close() {
    clearInterval(this.#flushAt);
    this.flush();
    this.#db.close();
  }
}
