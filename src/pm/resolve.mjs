#!/usr/bin/env node
// Market resolution: which outcome won, and the metadata a closed market still
// carries.
//
//   node src/pm/resolve.mjs --from target-fills.csv
//   node src/pm/resolve.mjs --from target-fills.csv --out pm-resolutions.csv
//
// Without this a position that was never sold is unreadable: there is no way to
// tell "expired worthless" from "held to resolution and redeemed at $1", and
// measuring return on the sold ones alone is survivorship bias that makes any
// strategy look profitable.
//
// Source is CLOB /markets/{condition_id}, which takes the id in the path and so
// cannot silently answer about a different market. Gamma's condition_id filter
// is ignored without error and returns an unfiltered list — a quiet way to
// poison the data.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isEntryPoint } from '../entrypoint.mjs';
import { classifyMarket } from './classify.mjs';
import { loadConfig } from './config.mjs';
import { parseCsvLine } from './ggbet-tail.mjs';

const CLOB = 'https://clob.polymarket.com/markets';

export const COLUMNS = [
  'condition_id', 'token_id', 'outcome', 'winner', 'payout_price', 'closed',
  'question', 'market_slug', 'end_date_iso', 'game_start_time',
  'min_tick_size', 'min_order_size',
  // Beyond the agreed schema: derived here rather than in the analyser so the
  // market-classification rules stay in one place instead of two languages.
  'sport', 'market_level', 'kind', 'segment_no',
  'fetched_at',
];

const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read one market's resolution.
 *
 * `record` comes back alongside because this is also the only way to learn
 * about a market the discovery query never showed: the studied wallets trade
 * baseball and basketball, which the book logger does not scan for, and the id
 * in the path means CLOB cannot answer about a different market.
 *
 * @returns {{closed: boolean, rows: Array, record: object}} one row per outcome token
 */
export async function fetchResolution(conditionId, disciplines = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${CLOB}/${conditionId}`);
  if (!response.ok) throw new Error(`clob ${response.status} for ${conditionId}`);
  const market = await response.json();

  // The CLOB shape has no events[], so give the classifier the slug it keys the
  // discipline off. "cs2-color-btf-2026-08-25-game2" still starts with "cs2".
  const classified = classifyMarket({
    question: market.question,
    slug: market.market_slug,
    events: [{ slug: market.market_slug, title: market.question }],
    outcomes: JSON.stringify((market.tokens ?? []).map((t) => t.outcome)),
    clobTokenIds: JSON.stringify((market.tokens ?? []).map((t) => t.token_id)),
    orderPriceMinTickSize: market.minimum_tick_size,
    orderMinSize: market.minimum_order_size,
  }, disciplines);

  const fetchedAt = new Date().toISOString();
  const rows = (market.tokens ?? []).map((token) => [
    market.condition_id ?? conditionId, token.token_id, token.outcome,
    token.winner === true ? 1 : token.winner === false ? 0 : '',
    token.price, market.closed === true ? 1 : 0,
    market.question, market.market_slug, market.end_date_iso, market.game_start_time,
    market.minimum_tick_size, market.minimum_order_size,
    classified.sport, classified.level, classified.kind, classified.segmentNo,
    fetchedAt,
  ]);
  return {
    closed: market.closed === true,
    rows,
    record: {
      ...classified,
      conditionId: market.condition_id ?? conditionId,
      endDate: market.end_date_iso ?? null,
      // The classifier saw a synthetic market object with no game time in it.
      gameStartTime: market.game_start_time ?? null,
    },
  };
}

/** The output file is its own cache: a closed market never changes again. */
export class ResolutionStore {
  #byCondition = new Map();

  constructor(path) {
    this.path = path;
    if (!existsSync(path)) return;
    const [, ...lines] = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      const fields = parseCsvLine(line);
      const row = Object.fromEntries(COLUMNS.map((name, i) => [name, fields[i] ?? '']));
      const list = this.#byCondition.get(row.condition_id) ?? [];
      list.push(fields);
      this.#byCondition.set(row.condition_id, list);
    }
  }

  /**
   * Settled markets are skipped; ones still open are re-read next run.
   * Rows read back from the file hold strings while freshly fetched ones hold
   * numbers, so the flag is compared as text either way.
   */
  isSettled(conditionId) {
    const rows = this.#byCondition.get(conditionId);
    return Boolean(rows?.length) && String(rows[0][COLUMNS.indexOf('closed')]) === '1';
  }

  has(conditionId) {
    return this.#byCondition.has(conditionId);
  }

  set(conditionId, rows) {
    this.#byCondition.set(conditionId, rows);
  }

  get size() {
    return this.#byCondition.size;
  }

  get settledCount() {
    return [...this.#byCondition.keys()].filter((id) => this.isSettled(id)).length;
  }

  save() {
    const lines = [COLUMNS.join(',')];
    for (const rows of this.#byCondition.values()) {
      for (const row of rows) lines.push(row.map(cell).join(','));
    }
    writeFileSync(this.path, lines.join('\n') + '\n');
  }
}

/** Condition ids referenced by a fills export. */
export function conditionIdsFrom(path) {
  const [header, ...lines] = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  const column = parseCsvLine(header).indexOf('condition_id');
  if (column < 0) throw new Error(`${path} has no condition_id column`);
  return [...new Set(lines.map((line) => parseCsvLine(line)[column]).filter(Boolean))];
}

/**
 * Resolve every id not already settled.
 * @param {string[]} conditionIds
 * @param {ResolutionStore} store
 * @param {object} [options]
 */
export async function resolveAll(conditionIds, store, {
  disciplines = {}, pauseMs = 400, retries = 3, fetchImpl = fetch, onProgress = null,
} = {}) {
  const pending = conditionIds.filter((id) => !store.isSettled(id));
  let resolved = 0;
  let failed = 0;

  for (const [index, conditionId] of pending.entries()) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { rows } = await fetchResolution(conditionId, disciplines, fetchImpl);
        store.set(conditionId, rows);
        resolved++;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < retries) await delay(pauseMs * 2 ** attempt);
      }
    }
    if (lastError) {
      failed++;
      console.error(`  ! ${conditionId.slice(0, 14)}: ${lastError.message}`);
    }
    onProgress?.(index + 1, pending.length);
    if (index < pending.length - 1) await delay(pauseMs);
  }
  return { attempted: pending.length, resolved, failed, skipped: conditionIds.length - pending.length };
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag, fallback) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : fallback;
  };
  const from = valueOf('--from', 'target-fills.csv');
  const out = valueOf('--out', 'pm-resolutions.csv');

  if (!existsSync(from)) throw new Error(`${from} not found`);
  const config = loadConfig();
  // A market the logger never subscribed to still needs a name on its PnL row.
  const naming = { ...config.labels, ...config.disciplines };
  const ids = conditionIdsFrom(from);
  const store = new ResolutionStore(out);

  console.log(`${ids.length} markets in ${from}, ${store.settledCount} already settled`);
  const result = await resolveAll(ids, store, {
    disciplines: naming,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) process.stderr.write(`  resolved ${done}/${total}\r`);
    },
  });
  store.save();

  const settled = store.settledCount;
  console.log(`\nwrote ${out}: ${store.size} markets, ${settled} settled`);
  console.log(`  fetched ${result.resolved}, skipped ${result.skipped} cached, ${result.failed} failed`);

  // A wall of 403s writes a header and nothing else, and the analyser downstream
  // then reports "0 outcome tokens resolved" as if the markets had no outcome.
  // Say it here, where the status codes are.
  if (result.attempted > 0 && result.resolved === 0) {
    throw new Error(`every fetch failed (${result.failed}/${result.attempted})`
      + ' — nothing was resolved; the errors above are the reason');
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
