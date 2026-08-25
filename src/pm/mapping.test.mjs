// Mapping table: the file is meant to be hand-corrected, so the matcher must
// never undo a person's work.
//   node src/pm/mapping.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MappingTable } from './mapping.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pm-map-'));
const path = join(dir, 'mapping.csv');

try {
  const table = new MappingTable(path);
  assert.equal(table.size, 0, 'a missing file is an empty table, not an error');

  assert.equal(table.propose({ conditionId: '0xA', ggbetMatchId: 'm1', pmSegment: 'map2', ggbetSegment: 'Карта 2', confidence: 0.8 }), true);
  assert.equal(table.propose({ conditionId: '0xA', ggbetMatchId: 'm1', pmSegment: 'map2', ggbetSegment: 'Карта 2', confidence: 0.75 }), false,
    'a worse guess for the same pairing is ignored');
  assert.equal(table.propose({ conditionId: '0xA', ggbetMatchId: 'm1', pmSegment: 'map2', ggbetSegment: 'Карта 2', confidence: 0.95 }), true,
    'a better guess replaces it');
  table.save();

  // A person corrects the row and marks it verified.
  writeFileSync(path, readFileSync(path, 'utf8').replace('"m1"', '"CORRECTED"').replace(/"0\.95","0"/, '"1","1"'));

  const reloaded = new MappingTable(path);
  assert.equal(reloaded.verifiedCount, 1);
  assert.equal(reloaded.get('0xA').ggbet_match_id, 'CORRECTED');
  assert.equal(reloaded.propose({ conditionId: '0xA', ggbetMatchId: 'auto', pmSegment: '', ggbetSegment: '', confidence: 0.99 }), false,
    'a verified row is never overwritten, however confident the matcher is');

  reloaded.propose({ conditionId: '0xB', ggbetMatchId: 'm2', pmSegment: '', ggbetSegment: 'Победитель', confidence: 0.7 });
  reloaded.save();

  const text = readFileSync(path, 'utf8');
  assert.match(text, /CORRECTED/, 'the manual correction survives a rewrite');
  assert.match(text, /"0xB","m2"/, 'new automatic rows are appended alongside');
  assert.equal(new MappingTable(path).verifiedCount, 1, 'the verified flag round-trips');

  console.log('all mapping tests passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
