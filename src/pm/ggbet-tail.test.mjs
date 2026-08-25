// Tail tests: CSV quoting, incremental reads, and quote staleness.
//   node src/pm/ggbet-tail.test.mjs
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GgbetTail, parseCsvLine } from './ggbet-tail.mjs';

// Tennis players carry commas inside their quoted names.
assert.deepEqual(parseCsvLine('"a","b,c","d"'), ['a', 'b,c', 'd']);
assert.deepEqual(parseCsvLine('"say ""hi""","x"'), ['say "hi"', 'x']);
assert.deepEqual(parseCsvLine('plain,值,'), ['plain', '值', '']);

const HEADER = 'ts,sport,match_id,title,score,segment,segment_score,market,selection,price,is_active';
const row = (ts, match, title, market, selection, price, active = 'true') =>
  [ts, 'tennis', match, title, '1:0', '2', '3:4', market, selection, price, active]
    .map((v) => `"${v}"`).join(',');

const dir = mkdtempSync(join(tmpdir(), 'pm-tail-'));
const path = join(dir, 'odds-history.csv');

try {
  writeFileSync(path, `${HEADER}\n${row('2026-08-25T12:00:00Z', 'm1', 'Matthew Donald vs Хассан, Беньямин', 'Победитель', 'Matthew Donald', '1.44')}\n`);
  const tail = new GgbetTail(path);
  assert.equal(tail.poll(), 1);
  assert.equal(tail.size, 1);

  // One side only: there is no fair value until both prices are known.
  assert.equal(tail.markets()[0].fair, null, 'one quote does not make a market');
  assert.deepEqual(tail.markets()[0].teams, ['Matthew Donald', 'Хассан, Беньямин'],
    'a comma inside a quoted name is not a field separator');

  appendFileSync(path, `${row('2026-08-25T12:00:05Z', 'm1', 'Matthew Donald vs Хассан, Беньямин', 'Победитель', 'Хассан, Беньямин', '2.59')}\n`);
  assert.equal(tail.poll(), 1, 'only the new bytes are read');
  assert.equal(tail.poll(), 0, 'a second poll with nothing appended reads nothing');

  const [market] = tail.markets();
  assert.ok(Math.abs(market.fair - 0.6427) < 0.001, `de-vigged fair, got ${market.fair}`);
  assert.equal(market.score, '1:0');
  assert.equal(market.segmentScore, '3:4');
  assert.equal(market.updatedAt, Date.parse('2026-08-25T12:00:05Z'),
    'the newest row dates the quote, which is what staleness is measured from');

  // A price update replaces the old one rather than adding a third selection.
  appendFileSync(path, `${row('2026-08-25T12:00:09Z', 'm1', 'Matthew Donald vs Хассан, Беньямин', 'Победитель', 'Matthew Donald', '1.20')}\n`);
  tail.poll();
  const updated = tail.markets()[0];
  assert.equal(updated.selections.length, 2, 'a market keeps two sides');
  assert.ok(updated.fair > market.fair, 'a shorter price raises the implied probability');

  // A suspended side is reported, so the join can mark the state.
  appendFileSync(path, `${row('2026-08-25T12:00:12Z', 'm1', 'Matthew Donald vs Хассан, Беньямин', 'Победитель', 'Matthew Donald', '1.20', 'false')}\n`);
  tail.poll();
  assert.equal(tail.markets()[0].active, false);

  // A half-written line is held back until its newline arrives.
  appendFileSync(path, row('2026-08-25T12:00:20Z', 'm2', 'A vs B', 'Победитель', 'A', '2.00'));
  assert.equal(tail.poll(), 0, 'an incomplete line is not parsed');
  appendFileSync(path, '\n');
  assert.equal(tail.poll(), 1, 'it is parsed once the line is finished');
  assert.equal(tail.size, 2);

  // A rotated or rewritten file is shorter than what was already read.
  writeFileSync(path, `${HEADER}\n${row('2026-08-25T13:00:00Z', 'm9', 'C vs D', 'Победитель', 'C', '1.50')}\n`);
  assert.equal(tail.poll(), 1, 'a truncated file is re-read from the start');

  console.log('all tail tests passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
