// Module C — reading the gg.bet collector's output without touching it.
//
// odds-history.csv is append-only, so this follows it by byte offset and keeps
// the latest quote per market in memory. The collector writes a row only when a
// price actually moves, which is what makes staleness measurable: if the newest
// row for a market is seven minutes old, the fair value derived from it is seven
// minutes old, and `seconds_since_ggbet_quote` says so.

import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { devig } from './match.mjs';

/** RFC4180 line parser. Tennis players carry commas inside quotes ("Хассан, Беньямин"). */
export function parseCsvLine(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char !== '"') value += char;
      else if (line[i + 1] === '"') { value += '"'; i++; }
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') { fields.push(value); value = ''; }
    else value += char;
  }
  fields.push(value);
  return fields;
}

const teamsOf = (title) => {
  const match = /^(.*?)\s+vs\.?\s+(.*)$/i.exec(String(title ?? ''));
  return match ? [match[1].trim(), match[2].trim()] : null;
};

export class GgbetTail {
  #offset = 0;
  #partial = '';
  #columns = null;
  /** key `${matchId}|${market}` -> live state of that market */
  #markets = new Map();

  constructor(path) {
    this.path = path;
    this.rowsRead = 0;
  }

  /**
   * Consume whatever has been appended since the last call.
   * @returns {number} rows parsed this round
   */
  poll() {
    if (!existsSync(this.path)) return 0;
    const { size } = statSync(this.path);
    // A rewritten or rotated file is shorter than what we already read.
    if (size < this.#offset) {
      this.#offset = 0;
      this.#partial = '';
      this.#columns = null;
    }
    if (size === this.#offset) return 0;

    const handle = openSync(this.path, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(size - this.#offset);
      const read = readSync(handle, buffer, 0, buffer.length, this.#offset);
      this.#offset += read;
      text = buffer.subarray(0, read).toString('utf8');
    } finally {
      closeSync(handle);
    }

    const lines = (this.#partial + text).split('\n');
    // The collector may be mid-write; keep the tail until its newline arrives.
    this.#partial = lines.pop() ?? '';

    let count = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const fields = parseCsvLine(line);
      if (!this.#columns) {
        this.#columns = fields;
        continue;
      }
      this.#apply(Object.fromEntries(this.#columns.map((name, i) => [name, fields[i]])));
      count++;
    }
    this.rowsRead += count;
    return count;
  }

  #apply(row) {
    const key = `${row.match_id}|${row.market}`;
    const state = this.#markets.get(key) ?? {
      matchId: row.match_id, market: row.market, selections: new Map(),
    };
    state.sport = row.sport;
    state.title = row.title;
    state.teams = teamsOf(row.title);
    state.score = row.score || null;
    state.segment = row.segment || null;
    state.segmentScore = row.segment_score || null;
    state.updatedAt = Date.parse(row.ts);
    state.selections.set(row.selection, {
      price: Number(row.price),
      isActive: row.is_active === 'true',
    });
    this.#markets.set(key, state);
  }

  get size() {
    return this.#markets.size;
  }

  /**
   * Every market seen so far, with its de-vigged fair value where both sides
   * are known. Selection order follows the gg.bet feed, so fair[0] belongs to
   * the first selection, which for a two-way market is the home competitor.
   */
  markets() {
    const out = [];
    for (const state of this.#markets.values()) {
      const entries = [...state.selections.entries()];
      const [first, second] = entries;
      out.push({
        matchId: state.matchId,
        market: state.market,
        sport: state.sport,
        title: state.title,
        teams: state.teams,
        score: state.score,
        segment: state.segment,
        segmentScore: state.segmentScore,
        updatedAt: state.updatedAt,
        selections: entries.map(([name, quote]) => ({ name, ...quote })),
        fair: entries.length === 2 ? devig(first[1].price, second[1].price) : null,
        active: entries.length === 2 && first[1].isActive && second[1].isActive,
      });
    }
    return out;
  }
}
