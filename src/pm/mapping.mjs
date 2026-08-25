// Module C — the market correspondence table.
//
// Automatic matching gets most of the way and no further: "NAVI" against
// "Natus Vincere" scores 0.29 on bigrams, and no threshold rescues that without
// admitting nonsense elsewhere. So the table is meant to be hand-edited, and a
// row marked verified is never touched again by the matcher — that is the whole
// point of persisting it rather than rebuilding it each run.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseCsvLine } from './ggbet-tail.mjs';

const COLUMNS = ['pm_condition_id', 'ggbet_match_id', 'pm_segment', 'ggbet_segment',
  'confidence', 'verified'];
const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

export class MappingTable {
  #rows = new Map();

  constructor(path) {
    this.path = path;
    this.load();
  }

  load() {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, 'utf8').split('\n').filter((l) => l.trim());
    const [, ...body] = lines;
    for (const line of body) {
      const fields = parseCsvLine(line);
      const row = Object.fromEntries(COLUMNS.map((name, i) => [name, fields[i] ?? '']));
      row.confidence = Number(row.confidence) || 0;
      // Anything a person marked stays authoritative.
      row.verified = /^(1|true|yes)$/i.test(row.verified);
      if (row.pm_condition_id) this.#rows.set(row.pm_condition_id, row);
    }
  }

  get size() {
    return this.#rows.size;
  }

  get verifiedCount() {
    return [...this.#rows.values()].filter((r) => r.verified).length;
  }

  get(conditionId) {
    return this.#rows.get(conditionId) ?? null;
  }

  /**
   * Record what the matcher found. Refuses to overwrite a verified row, and
   * keeps the better guess when it has seen this market before.
   * @returns {boolean} whether the table changed
   */
  propose({ conditionId, ggbetMatchId, pmSegment, ggbetSegment, confidence }) {
    const existing = this.#rows.get(conditionId);
    if (existing?.verified) return false;
    if (existing && existing.confidence >= confidence && existing.ggbet_match_id === ggbetMatchId) {
      return false;
    }
    this.#rows.set(conditionId, {
      pm_condition_id: conditionId,
      ggbet_match_id: ggbetMatchId,
      pm_segment: pmSegment ?? '',
      ggbet_segment: ggbetSegment ?? '',
      confidence: Number(confidence.toFixed(4)),
      verified: false,
    });
    return true;
  }

  /** Rewrite the file, preserving verified rows exactly as they were read. */
  save() {
    const lines = [COLUMNS.join(',')];
    for (const row of this.#rows.values()) {
      lines.push([row.pm_condition_id, row.ggbet_match_id, row.pm_segment, row.ggbet_segment,
        row.confidence, row.verified ? '1' : '0'].map(cell).join(','));
    }
    writeFileSync(this.path, lines.join('\n') + '\n');
  }
}
