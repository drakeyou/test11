#!/usr/bin/env node
// Triage tool for the payloads written by `--discover`.
//
//   node src/inspect.mjs                 rank every capture by how match-like it is
//   node src/inspect.mjs <file>          print the structural skeleton of one capture
//
// The skeleton replaces values with samples and collapses arrays to their first
// element, so a 200 KB payload becomes a few dozen readable lines that are safe
// to paste into a chat or an issue.

import { readdir, readFile } from 'node:fs/promises';
import { parseFrame } from './parse.mjs';

const DIR = 'captures';
const MAX_DEPTH = 6;
const MAX_STRING = 24;

const isObj = (v) => v !== null && typeof v === 'object';

/** Collapse a payload into a compact shape description. */
function skeleton(node, depth = 0) {
  if (depth > MAX_DEPTH) return '…';
  if (node === null) return 'null';
  if (Array.isArray(node)) {
    if (!node.length) return '[]';
    return [skeleton(node[0], depth + 1), `…×${node.length}`];
  }
  if (isObj(node)) {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = skeleton(v, depth + 1);
    return out;
  }
  if (typeof node === 'string') {
    return node.length > MAX_STRING ? `${node.slice(0, MAX_STRING)}…` : node;
  }
  return node;
}

/** Where in the tree do team-like structures live? Helps locate the real data. */
function candidatePaths(node, path = '$', depth = 0, hits = []) {
  if (depth > 8 || !isObj(node)) return hits;
  if (Array.isArray(node)) {
    if (node.length && isObj(node[0])) candidatePaths(node[0], `${path}[0]`, depth + 1, hits);
    return hits;
  }
  const keys = Object.keys(node);
  const teamish = keys.filter((k) => /^(home|away|team|competitor|participant|opponent)/i.test(k));
  const oddish = keys.filter((k) => /^(odd|odds|price|coef|coefficient|rate)/i.test(k));
  if (teamish.length) hits.push({ path, teamKeys: teamish, oddKeys: oddish, keys });
  for (const [k, v] of Object.entries(node)) candidatePaths(v, `${path}.${k}`, depth + 1, hits);
  return hits;
}

async function loadCapture(name) {
  const raw = JSON.parse(await readFile(`${DIR}/${name}`, 'utf8'));
  return { url: raw.url ?? '(unknown)', payload: raw.payload ?? raw };
}

async function summarize() {
  let names;
  try {
    names = (await readdir(DIR)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    console.error(`no ${DIR}/ directory — run \`npm run discover\` first`);
    process.exit(1);
  }
  if (!names.length) {
    console.error(`${DIR}/ is empty — run \`npm run discover\` first`);
    process.exit(1);
  }

  const rows = [];
  for (const name of names) {
    const { url, payload } = await loadCapture(name);
    rows.push({
      name,
      url,
      matches: parseFrame(payload).length,
      candidates: candidatePaths(payload).length,
      size: JSON.stringify(payload).length,
    });
  }

  rows.sort((a, b) => b.matches - a.matches || b.candidates - a.candidates || b.size - a.size);

  console.log(`${rows.length} captures in ${DIR}/\n`);
  console.log('   ops  team-like  size     file              url');
  console.log('-'.repeat(96));
  for (const r of rows.slice(0, 30)) {
    console.log(
      `${String(r.matches).padStart(7)}  ${String(r.candidates).padStart(9)}  ` +
      `${String(r.size).padStart(7)}  ${r.name.padEnd(17)} ${r.url.slice(0, 48)}`
    );
  }

  const best = rows.find((r) => r.matches > 0) ?? rows.find((r) => r.candidates > 0);
  console.log('');
  if (!best) {
    console.log('Nothing looks like a match anywhere. The data may arrive over the websocket');
    console.log('or in a non-JSON encoding. Inspect the largest file by hand:');
    console.log(`  node src/inspect.mjs ${rows[0].name}`);
  } else if (best.matches > 0) {
    console.log(`Parser handles ${best.name} (${best.matches} ops). Try: npm run watch`);
  } else {
    console.log(`No matches parsed, but ${best.name} has team-like fields. Look at its shape:`);
    console.log(`  node src/inspect.mjs ${best.name}`);
  }
}

async function detail(name) {
  const { url, payload } = await loadCapture(name);
  console.log(`file : ${name}`);
  console.log(`url  : ${url}`);
  console.log(`size : ${JSON.stringify(payload).length} bytes`);

  const hits = candidatePaths(payload);
  console.log(`\n--- team-like locations (${hits.length}) ---`);
  for (const h of hits.slice(0, 10)) {
    console.log(`  ${h.path}`);
    console.log(`    team keys : ${h.teamKeys.join(', ') || '—'}`);
    console.log(`    odd keys  : ${h.oddKeys.join(', ') || '—'}`);
    console.log(`    all keys  : ${h.keys.slice(0, 14).join(', ')}`);
  }

  console.log('\n--- skeleton ---');
  console.log(JSON.stringify(skeleton(payload), null, 2));
}

const arg = process.argv[2];
await (arg ? detail(arg) : summarize());
