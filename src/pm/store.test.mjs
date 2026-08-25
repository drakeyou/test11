// Storage tests against a real database in a temporary directory.
//   node src/pm/store.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, utcDay } from './store.mjs';

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
    store.add('sweeps', [`t${i}`, 'a1', 'c1', 'levels', 0.3, 0.02, 500, 6, 900, 100]);
  }
  assert.equal(store.count('sweeps'), 5, 'a full buffer flushes itself');

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

  console.log('all store tests passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
