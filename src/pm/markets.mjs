#!/usr/bin/env node
// One-shot market discovery, for checking what the filter currently sees.
//   node src/pm/markets.mjs            summary by discipline and market type
//   node src/pm/markets.mjs --json     the tracked records, for piping onward
//   node src/pm/markets.mjs --unknown  event-slug prefixes with no discipline
//
// Under the agent proxy, Node's built-in fetch needs NODE_USE_ENV_PROXY=1.

import { loadConfig } from './config.mjs';
import { fetchActiveMarkets, MarketRegistry } from './gamma.mjs';

const flags = new Set(process.argv.slice(2));
const config = loadConfig();

const raw = await fetchActiveMarkets(config.gamma);
const registry = new MarketRegistry();
const { tracked } = registry.update(raw, config.disciplines);

if (flags.has('--json')) {
  console.log(JSON.stringify(tracked, null, 2));
} else if (flags.has('--unknown')) {
  const rows = [...registry.unknownPrefixes].sort((a, b) => b[1] - a[1]);
  console.log(`event-slug prefixes with no discipline mapping (${rows.length}):`);
  for (const [prefix, count] of rows.slice(0, 40)) console.log(`  ${String(count).padStart(5)}  ${prefix}`);
  console.log('\nAdd the ones you want to pm.config.json -> disciplines.');
} else {
  console.log(`scanned ${raw.length} active markets, tracking ${tracked.length} (${registry.assetIds().length} tokens)\n`);
  const counts = new Map();
  for (const record of tracked) {
    const key = `${record.sport}  ${record.level}/${record.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...counts].sort()) console.log(`  ${String(count).padStart(4)}  ${key}`);

  const segment = tracked.filter((r) => r.level === 'segment');
  console.log(`\nin-match sub-markets (where the bot works): ${segment.length}`);
  for (const record of segment.slice(0, 10)) {
    console.log(`  ${record.segmentKind}${record.segmentNo} ${record.kind.padEnd(9)} ` +
      `${(record.teams ?? []).join(' vs ').slice(0, 44).padEnd(46)} ${record.eventSlug}`);
  }
}
