// Storage tests against a real database in a temporary directory.
//   node src/pm/store.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, restoreSchedulableMarkets, utcDay } from './store.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pm-store-'));

try {
  assert.equal(utcDay(new Date('2026-08-25T23:59:59Z')), '2026-08-25');
  assert.equal(utcDay(new Date('2026-08-26T00:00:01Z')), '2026-08-26', 'the day rolls at UTC midnight');

  const store = new Store(dir, { flushMs: 1_000_000, maxBuffered: 5 });
  assert.ok(existsSync(store.path), 'the daily database is created eagerly');

  // Buffered rows are not on disk until a flush, which is the point of buffering.
  store.add('book', ['t1', 'a1', 'c1', 'change', 0.02, 0.9, 0.46, 100, 200, 0, 0, 300, 50, 3, 0.88]);
  assert.equal(store.count('book'), 0, 'nothing is written before a flush');
  store.flush();
  assert.equal(store.count('book'), 1);

  // Hitting maxBuffered flushes on its own, so a burst cannot grow unbounded.
  for (let i = 0; i < 5; i++) {
    store.add('sweeps', [`t${i}`, 'a1', 'c1', 'levels', 0.3, 0.02, 500, 6, 900, 100,
      `a1:t${i}`, 0.31, 1.55, 4.2, 'active']);
  }
  assert.equal(store.count('sweeps'), 5, 'a full buffer flushes itself');

  // The gg.bet side is priced into the sweep row itself, at the moment of the
  // event; looking it up afterwards found one quote in five thousand.
  store.flush();
  const priced = new DatabaseSync(store.path)
    .prepare('SELECT * FROM sweeps WHERE sweep_id = ?').get('a1:t0');
  assert.equal(priced.ggbet_fair, 0.31);
  assert.equal(priced.dislocation_ratio, 1.55);
  assert.equal(priced.seconds_since_ggbet_quote, 4.2);
  assert.equal(priced.ggbet_market_state, 'active');

  // One row per horizon, and a re-run of the same horizon cannot double it.
  store.add('sweep_followups', ['a1:t0', 'a1', 'c1', 5, 0.09, '2026-08-25T10:05:00Z', 0]);
  store.add('sweep_followups', ['a1:t0', 'a1', 'c1', 5, 0.11, '2026-08-25T10:05:01Z', 0]);
  store.add('sweep_followups', ['a1:t0', 'a1', 'c1', 15, 1, '2026-08-25T10:15:00Z', 1]);
  store.flush();
  assert.equal(store.count('sweep_followups'), 2, 'a horizon is written once per sweep');

  store.upsertMarket({
    conditionId: 'c1', tokens: ['a1', 'a2'], question: 'Map 1 Winner', slug: 's',
    eventSlug: 'cs2-a-b', eventTitle: 'A vs B', sport: 'esports_counter_strike',
    level: 'segment', kind: 'winner', segmentKind: 'map', segmentNo: 1, line: null,
    teams: ['A', 'B'], outcomes: ['A', 'B'], endDate: '2026-08-26', tickSize: 0.001, minSize: 5,
  }, '2026-08-25T10:00:00Z');
  assert.equal(store.count('markets'), 1);

  // Re-seeing a market updates last_seen instead of inserting a duplicate.
  store.upsertMarket({
    conditionId: 'c1', tokens: ['a1', 'a2'], question: 'Map 1 Winner', slug: 's',
    eventSlug: 'cs2-a-b', eventTitle: 'A vs B', sport: 'esports_counter_strike',
    level: 'segment', kind: 'winner', segmentKind: 'map', segmentNo: 1, line: null,
    teams: ['A', 'B'], outcomes: ['A', 'B'], endDate: '2026-08-27', tickSize: 0.001, minSize: 5,
  }, '2026-08-25T11:00:00Z');
  assert.equal(store.count('markets'), 1, 'the same market is upserted, not duplicated');

  // The lifecycle of the subscription window, and the self-check flag it exists
  // to produce. The flag is set once, live; a later re-registration — the daily
  // rollover writes every tracked market again — must not clear it.
  const dated = {
    conditionId: 'c2', tokens: ['b1', 'b2'], question: 'Map 2 Winner', slug: 's2',
    eventSlug: 'cs2-a-b', eventTitle: 'A vs B', sport: 'esports_counter_strike',
    level: 'segment', kind: 'winner', segmentKind: 'map', segmentNo: 2, line: null,
    teams: ['A', 'B'], outcomes: ['A', 'B'], endDate: '2026-08-26T18:00:00Z',
    tickSize: 0.01, minSize: 5,
  };
  store.upsertMarket(dated, '2026-08-25T12:00:00Z', {
    gameStart: Date.parse('2026-08-26T12:00:00Z'),
    subscribedAt: '2026-08-26T11:50:00Z', releasedAt: null, releaseReason: null,
    observedDuringGame: true,
  });
  store.markObserved('c2');
  store.upsertMarket(dated, '2026-08-25T13:00:00Z', {
    gameStart: Date.parse('2026-08-26T12:00:00Z'),
    subscribedAt: '2026-08-26T11:50:00Z', releasedAt: '2026-08-26T18:00:00Z',
    releaseReason: 'resolved', observedDuringGame: false,
  });
  const lifecycle = new DatabaseSync(store.path)
    .prepare('SELECT * FROM markets WHERE condition_id = ?').get('c2');
  assert.equal(lifecycle.game_start_time, '2026-08-26T12:00:00.000Z');
  assert.equal(lifecycle.subscribed_at, '2026-08-26T11:50:00Z');
  assert.equal(lifecycle.unsubscribed_at, '2026-08-26T18:00:00Z');
  assert.equal(lifecycle.release_reason, 'resolved');
  assert.equal(lifecycle.observed_during_game, 1, 'the flag is never cleared by a re-register');

  // Wallet activity is polled repeatedly and must not accumulate duplicates.
  const walletRow = ['t', '0xabc', 'act1', 'TRADE', 'BUY', 'a1', 'c1', 0.02, 100, '0xdead'];
  store.add('wallets', walletRow);
  store.add('wallets', [...walletRow]);
  store.flush();
  assert.equal(store.count('wallets'), 1, 'the same activity id is ignored on re-poll');

  // Midnight rollover: the day's file is closed and a fresh one opened, and the
  // caller is told so it can re-register what it tracks into the empty tables.
  const rotations = [];
  let clock = new Date('2026-08-25T23:59:50Z');
  // Its own directory: the store above already opened today's file here.
  const rollDir = join(dir, 'rollover');
  const rolling = new Store(rollDir, { flushMs: 1_000_000, now: () => clock, onRotate: (d) => rotations.push(d) });
  rolling.add('book', ['t', 'a1', 'c1', 'heartbeat', 0.02, 0.9, 0.46, 1, 2, 3, 4, 5, 6, 7, 0.88]);
  rolling.flush();
  assert.equal(rolling.count('book'), 1);
  const firstDay = rolling.path;

  clock = new Date('2026-08-26T00:00:10Z');
  rolling.flush();
  assert.notEqual(rolling.path, firstDay, 'a new day opens a new file');
  assert.equal(rolling.count('book'), 0, 'the new file starts empty');
  assert.deepEqual(rotations, ['2026-08-26'], 'the caller is told to re-register');
  assert.ok(existsSync(firstDay), 'yesterday is left intact');
  rolling.close();
  assert.equal(new DatabaseSync(firstDay).prepare('SELECT count(*) c FROM book').get().c, 1,
    'rows written before midnight stay in that day');

  store.close();

  // What was written survives the process: reopen and read it back.
  const db = new DatabaseSync(store.path);
  const row = db.prepare('SELECT * FROM markets').get();
  assert.equal(row.condition_id, 'c1');
  assert.equal(row.end_date, '2026-08-27', 'the upsert refreshed the end date');
  assert.equal(row.first_seen, '2026-08-25T10:00:00Z', 'first_seen is not overwritten');
  assert.equal(row.last_seen, '2026-08-25T11:00:00Z');
  assert.equal(db.prepare('SELECT count(*) c FROM book').get().c, 1);
  db.close();

  // A database written by an older build is missing the columns added since.
  // Daily files are created with CREATE TABLE IF NOT EXISTS, so opening one of
  // those would otherwise fail on every insert with nothing to point at.
  const oldDir = join(dir, 'legacy');
  mkdirSync(oldDir, { recursive: true });
  const legacyPath = join(oldDir, `pm-${utcDay(new Date())}.sqlite`);
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`CREATE TABLE markets (
    condition_id TEXT PRIMARY KEY, asset_id_a TEXT, asset_id_b TEXT,
    question TEXT, slug TEXT, event_slug TEXT, event_title TEXT,
    sport TEXT, level TEXT, kind TEXT, segment_kind TEXT, segment_no INTEGER,
    line REAL, team_a TEXT, team_b TEXT, outcome_a TEXT, outcome_b TEXT,
    end_date TEXT, tick_size REAL, min_size REAL, first_seen TEXT, last_seen TEXT);
    CREATE TABLE sweeps (
    ts TEXT, asset_id TEXT, condition_id TEXT, rule TEXT,
    bid_before REAL, bid_after REAL, size_consumed REAL, levels_crossed INTEGER,
    depth_before REAL, depth_after REAL);
    INSERT INTO markets (condition_id, question) VALUES ('old', 'Map 1 Winner');`);
  legacy.close();

  const migrated = new Store(oldDir, { flushMs: 1_000_000 });
  migrated.add('sweeps', ['t', 'a1', 'c1', 'levels', 0.3, 0.02, 500, 6, 900, 100,
    'a1:t', 0.31, 1.55, 4.2, 'active']);
  migrated.flush();
  assert.equal(migrated.count('sweeps'), 1, 'an old database takes the new sweep row');
  migrated.markObserved('old');
  const carried = new DatabaseSync(migrated.path)
    .prepare('SELECT * FROM markets WHERE condition_id = ?').get('old');
  assert.equal(carried.observed_during_game, 1, 'the added column is usable');
  assert.equal(carried.question, 'Map 1 Winner', 'the old rows are left alone');
  migrated.close();

  // The schedule lives in memory, and a market is visible to discovery for
  // about an hour, 11 to 15 hours before its game. A restart in between would
  // drop the rest of the day's matches with nothing to say so, unless the
  // registry can be read back.
  const restoreDir = join(dir, 'restore');
  const clock2 = new Date('2026-08-26T09:00:00Z');
  const restoring = new Store(restoreDir, { flushMs: 1_000_000, now: () => clock2 });
  const market = (id, gameStart, released = null) => [{
    conditionId: id, tokens: [`${id}-a`, `${id}-b`], question: 'Map 1 Winner: A vs B',
    slug: id, eventSlug: 'cs2-a-b', eventTitle: 'A vs B', sport: 'esports_counter_strike',
    level: 'segment', kind: 'winner', segmentKind: 'map', segmentNo: 1, line: null,
    teams: ['A', 'B'], outcomes: ['A', 'B'], endDate: '2026-08-26T22:00:00Z',
    tickSize: 0.01, minSize: 5,
  }, '2026-08-26T09:00:00Z', {
    gameStart: Date.parse(gameStart), subscribedAt: null,
    releasedAt: released, releaseReason: released ? 'resolved' : null,
    observedDuringGame: false,
  }];
  restoring.upsertMarket(...market('later', '2026-08-26T20:00:00Z'));
  restoring.upsertMarket(...market('done', '2026-08-26T20:00:00Z', '2026-08-26T08:00:00Z'));
  restoring.upsertMarket(...market('yesterday', '2026-08-25T20:00:00Z'));
  restoring.close();

  const back = restoreSchedulableMarkets(restoreDir, { now: clock2.getTime() });
  assert.deepEqual(back.map((r) => r.conditionId), ['later'],
    'a match still to come is restored; a released one and a finished one are not');
  assert.deepEqual(back[0].tokens, ['later-a', 'later-b'], 'both tokens come back');
  assert.equal(back[0].gameStartTime, '2026-08-26T20:00:00.000Z');
  assert.equal(back[0].sport, 'esports_counter_strike');
  assert.deepEqual(back[0].teams, ['A', 'B']);
  assert.deepEqual(restoreSchedulableMarkets(join(dir, 'nothing-here')), [],
    'a directory with no databases restores nothing rather than throwing');

  console.log('all store tests passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
