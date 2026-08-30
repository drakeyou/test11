// The guard that decides whether a module was run or imported.
//   node src/entrypoint.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isEntryPoint } from './entrypoint.mjs';

const root = mkdtempSync(join(tmpdir(), 'entrypoint-'));

// A module run directly is the entry point, however the path was typed.
const plain = join(root, 'plain.mjs');
writeFileSync(plain, '');
assert.equal(isEntryPoint(`file://${plain}`, plain), true);

// A path with a space is percent-encoded in import.meta.url and raw in argv[1].
// This is the case that used to make the resolver exit 0 without a word.
const spaced = join(root, 'my files');
mkdirSync(spaced);
const inSpaced = join(spaced, 'x.mjs');
writeFileSync(inSpaced, '');
assert.equal(
  isEntryPoint(`file://${encodeURI(inSpaced)}`, inSpaced),
  true,
  'a space in the path must not hide the entry point',
);

// Cyrillic, likewise: "/данные/x.mjs" arrives encoded.
const cyrillic = join(root, 'данные');
mkdirSync(cyrillic);
const inCyrillic = join(cyrillic, 'x.mjs');
writeFileSync(inCyrillic, '');
assert.equal(isEntryPoint(`file://${encodeURI(inCyrillic)}`, inCyrillic), true);

// Node resolves symlinks for import.meta.url but not for argv[1].
const link = join(root, 'link.mjs');
symlinkSync(plain, link);
assert.equal(isEntryPoint(`file://${plain}`, link), true, 'a symlinked entry still counts');

// An imported module is not the entry point.
assert.equal(isEntryPoint(`file://${plain}`, join(root, 'other.mjs')), false);

// No entry path at all (a REPL, an eval) is not an error.
assert.equal(isEntryPoint(`file://${plain}`, undefined), false);

// End to end: the real thing, invoked through a directory that needs encoding.
const dir = join(root, 'a b');
mkdirSync(dir);
const script = join(dir, 'main.mjs');
writeFileSync(script, [
  `import { isEntryPoint } from ${JSON.stringify(join(process.cwd(), 'src/entrypoint.mjs'))};`,
  'if (isEntryPoint(import.meta.url)) console.log("ran");',
].join('\n'));
assert.equal(execFileSync(process.execPath, [script]).toString().trim(), 'ran');

console.log('all entrypoint tests passed');
