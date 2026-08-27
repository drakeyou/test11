// Resolver tests with an injected fetch, shaped on a real CLOB response.
//   node src/pm/resolve.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conditionIdsFrom, fetchResolution, ResolutionStore, resolveAll, COLUMNS } from './resolve.mjs';
import { DEFAULTS } from './config.mjs';

const naming = { ...DEFAULTS.labels, ...DEFAULTS.disciplines };

// A settled Counter-Strike map market, as CLOB returns it.
const settled = {
  condition_id: '0xc1', closed: true, minimum_tick_size: 0.001, minimum_order_size: 5,
  question: 'Counter-Strike: Color vs Butterfly - Map 2 Winner',
  market_slug: 'cs2-color-btf-2026-08-25-game2',
  end_date_iso: '2026-08-25T00:00:00Z', game_start_time: '2026-08-25T14:00:00Z',
  tokens: [
    { token_id: 't1', outcome: 'Color', price: 1, winner: true },
    { token_id: 't2', outcome: 'Butterfly', price: 0, winner: false },
  ],
};
const serve = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });

// --- one market -------------------------------------------------------------
const { closed, rows } = await fetchResolution('0xc1', naming, serve(settled));
assert.equal(closed, true);
assert.equal(rows.length, 2, 'one row per outcome token');

const index = Object.fromEntries(COLUMNS.map((name, i) => [name, i]));
const [winnerRow, loserRow] = rows;
assert.equal(winnerRow[index.token_id], 't1');
assert.equal(winnerRow[index.winner], 1);
assert.equal(winnerRow[index.payout_price], 1);
assert.equal(loserRow[index.winner], 0, 'a loser is zero, not blank');
assert.equal(loserRow[index.payout_price], 0);
assert.equal(winnerRow[index.closed], 1);
assert.equal(winnerRow[index.market_slug], 'cs2-color-btf-2026-08-25-game2');
assert.equal(winnerRow[index.game_start_time], '2026-08-25T14:00:00Z');

// Metadata missing from the fills export is recovered here, and the rules come
// from the same classifier the collector uses rather than a second copy.
assert.equal(winnerRow[index.sport], 'esports_counter_strike', 'discipline from the slug prefix');
assert.equal(winnerRow[index.market_level], 'segment');
assert.equal(winnerRow[index.kind], 'winner');
assert.equal(winnerRow[index.segment_no], 2);

// A market the logger never subscribed to still gets named.
const baseball = await fetchResolution('0xb1', naming, serve({
  ...settled, condition_id: '0xb1', market_slug: 'mlb-pit-mil-2026-08-05-nrfi',
  question: 'Will there be a run scored in the first inning?: Pit vs Mil',
}));
assert.equal(baseball.rows[0][index.sport], 'baseball', 'labels name what disciplines does not watch');

// An unsettled market reports as such.
const open = await fetchResolution('0xo1', naming, serve({ ...settled, closed: false }));
assert.equal(open.closed, false);
assert.equal(open.rows[0][index.closed], 0);

await assert.rejects(() => fetchResolution('0xc1', naming, serve(null, false, 404)), /clob 404/);

// --- the file as its own cache ----------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'pm-resolve-'));
const path = join(dir, 'pm-resolutions.csv');

try {
  const store = new ResolutionStore(path);
  assert.equal(store.size, 0, 'a missing file is an empty cache');

  let calls = 0;
  const counting = async (url) => {
    calls++;
    const id = url.split('/').pop();
    return { ok: true, json: async () => ({ ...settled, condition_id: id, closed: id !== '0xopen' }) };
  };

  const first = await resolveAll(['0xc1', '0xopen'], store, { pauseMs: 0, fetchImpl: counting });
  assert.equal(first.resolved, 2);
  assert.equal(calls, 2);
  store.save();

  // Reload from disk: the settled one is skipped, the open one is re-read,
  // which is what makes an hourly run cheap and a restart harmless.
  const reloaded = new ResolutionStore(path);
  assert.equal(reloaded.size, 2, 'both markets round-trip through the file');
  assert.equal(reloaded.settledCount, 1);
  assert.equal(reloaded.isSettled('0xc1'), true);
  assert.equal(reloaded.isSettled('0xopen'), false,
    'an open market is not treated as settled, whatever type the flag came back as');

  calls = 0;
  const second = await resolveAll(['0xc1', '0xopen'], reloaded, { pauseMs: 0, fetchImpl: counting });
  assert.equal(second.skipped, 1, 'the settled market is not re-requested');
  assert.equal(calls, 1, 'only the open market costs a request');

  // Retries: a flaky endpoint is retried, and a dead one is reported, not thrown.
  let attempts = 0;
  const flaky = async () => {
    attempts++;
    if (attempts < 3) return { ok: false, status: 502 };
    return { ok: true, json: async () => ({ ...settled, condition_id: '0xf1' }) };
  };
  const retried = await resolveAll(['0xf1'], new ResolutionStore(path), { pauseMs: 0, fetchImpl: flaky });
  assert.equal(retried.resolved, 1, 'a transient failure is retried');
  assert.equal(attempts, 3);

  const dead = await resolveAll(['0xd1'], new ResolutionStore(path),
    { pauseMs: 0, retries: 1, fetchImpl: serve(null, false, 500) });
  assert.equal(dead.failed, 1, 'a permanent failure is counted, not fatal');

  // --- reading ids out of a fills export ------------------------------------
  const fills = join(dir, 'target-fills.csv');
  writeFileSync(fills, 'ts,condition_id,asset_id,wallet\n' +
    '"t","0xaa","tok1","0xw"\n"t","0xaa","tok2","0xw"\n"t","0xbb","tok3","0xw"\n');
  assert.deepEqual(conditionIdsFrom(fills), ['0xaa', '0xbb'], 'ids are deduplicated');

  writeFileSync(fills, 'ts,asset_id\n"t","tok1"\n');
  assert.throws(() => conditionIdsFrom(fills), /no condition_id/);

  assert.ok(readFileSync(path, 'utf8').startsWith(COLUMNS.join(',')), 'header matches the schema');

  console.log('all resolver tests passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
