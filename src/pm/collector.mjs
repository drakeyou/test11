#!/usr/bin/env node
// Polymarket collector: discovery (A) and the book logger (B) in one process.
//
//   node src/pm/collector.mjs
//   node src/pm/collector.mjs --once     one discovery round, then exit
//
// Read-only throughout: no keys, no signing, no orders. Under the agent proxy,
// Node's fetch needs NODE_USE_ENV_PROXY=1; a normal machine needs nothing.
//
// Runs apart from the gg.bet collector on purpose. That one drives a browser
// that crashes and restarts; a hole in this feed is a hole in the fill-rate
// denominator, so the two must not share a fate.

import { loadConfig } from './config.mjs';
import { fetchActiveMarkets, MarketRegistry } from './gamma.mjs';
import { BookState, SweepDetector } from './book.mjs';
import { BookFeed } from './ws.mjs';
import { Store } from './store.mjs';
import { GgbetTail } from './ggbet-tail.mjs';
import { MappingTable } from './mapping.mjs';
import { buildLinks, joinedRow } from './link.mjs';
import { fetchActivity } from './wallets.mjs';

const config = loadConfig();
const once = process.argv.includes('--once');

const store = new Store(config.storage.dir);
const registry = new MarketRegistry();
const detector = new SweepDetector(config.sweep);
const books = new Map();
const tail = new GgbetTail(config.ggbet.oddsHistory);
const mapping = new MappingTable(config.ggbet.mapping);
let links = new Map();
let ggbetByKey = new Map();
const counts = { rows: 0, sweeps: 0, gaps: 0, messages: 0, joined: 0, fills: 0 };

const now = () => new Date().toISOString();

/** Record the book, and whatever the update did to it. */
function record(book, before, trigger) {
  const ts = now();
  const sweep = before && detector.observe(book, before, ts);
  if (sweep) {
    store.add('sweeps', sweep);
    counts.sweeps++;
  }
  store.add('book', book.metrics(ts, trigger));
  counts.rows++;

  const link = links.get(book.assetId);
  const ggbet = link && ggbetByKey.get(link.ggbetKey);
  if (ggbet) {
    store.add('joined', joinedRow(ts, link, book, ggbet));
    counts.joined++;
  }
}

/** Refresh the gg.bet side and the token-to-quote links it feeds. */
function relink() {
  tail.poll();
  const ggbetMarkets = tail.markets();
  ggbetByKey = new Map(ggbetMarkets.map((m) => [`${m.matchId}|${m.market}`, m]));
  links = buildLinks({
    markets: registry.tracked(),
    ggbetMarkets,
    mapping,
    windowHours: config.ggbet.matchWindowHours,
  });
  mapping.save();
  return links.size;
}

const feed = new BookFeed({
  ...config.book,
  onStatus: (text) => console.error(`[feed] ${text}`),
  onGap: (gap) => {
    counts.gaps++;
    console.error(`[feed] gap ${Math.round(gap.durationMs / 1000)}s over ${gap.assets} assets`);
    store.add('gaps', [gap.startedAt, gap.endedAt, gap.durationMs, gap.reason, gap.assets]);
  },
  onMessage: (message) => {
    counts.messages++;
    if (message.event_type === 'book') {
      const book = books.get(message.asset_id)
        ?? new BookState(message.asset_id, { conditionId: message.market });
      books.set(message.asset_id, book);
      const before = SweepDetector.snapshot(book, config.sweep.depthAbovePrice);
      book.applyBook(message);
      record(book, before, 'book');
      return;
    }
    if (message.event_type !== 'price_change') return; // last_trade_price is a print
    for (const entry of message.price_changes ?? []) {
      const book = books.get(entry.asset_id);
      if (!book) continue; // no snapshot yet; the next `book` frame resyncs us
      const before = SweepDetector.snapshot(book, config.sweep.depthAbovePrice);
      book.applyPriceChange(entry, message.timestamp);
      record(book, before, 'change');
    }
  },
});

/** A collapse takes a second, but coverage has to be provable minute by minute. */
function heartbeat() {
  for (const book of books.values()) record(book, null, 'heartbeat');
}

/** Target-wallet fills, the only labelled examples available. */
async function pollWallets() {
  for (const address of config.wallets.addresses ?? []) {
    try {
      const rows = await fetchActivity(address, { limit: 100 });
      for (const row of rows) store.add('wallets', row);
      counts.fills += rows.length;
    } catch (err) {
      console.error(`[wallets] ${address.slice(0, 10)}: ${err.message}`);
    }
  }
}

async function discover() {
  const raw = await fetchActiveMarkets(config.gamma);
  const { added, removed, tracked } = registry.update(raw, config.disciplines);
  for (const record of tracked) store.upsertMarket(record);
  for (const record of removed) {
    for (const assetId of record.tokens) {
      books.delete(assetId);
      detector.forget(assetId);
    }
  }
  if (feed.setAssets(registry.assetIds())) {
    console.error(`[discovery] ${tracked.length} markets, ${registry.assetIds().length} tokens` +
      ` (+${added.length} -${removed.length})`);
  }
  return tracked;
}

const tracked = await discover();
relink();
await pollWallets();
if (once) {
  const segment = tracked.filter((r) => r.level === 'segment').length;
  console.log(`tracking ${tracked.length} markets (${segment} in-match), database ${store.path}`);
  console.log(`gg.bet: ${tail.rowsRead} rows, ${tail.size} markets, ${links.size} tokens linked` +
    ` (${mapping.size} mappings, ${mapping.verifiedCount} verified)`);
  store.flush();
  console.log(`wallets: ${counts.fills} activity rows (${store.count('wallets')} stored)`);
  store.close();
  process.exit(0);
}

const timers = [
  setInterval(() => discover().catch((err) => console.error(`[discovery] ${err.message}`)),
    config.gamma.intervalSeconds * 1000),
  setInterval(heartbeat, config.book.heartbeatSeconds * 1000),
  setInterval(relink, (config.ggbet.pollSeconds ?? 5) * 1000),
  setInterval(() => pollWallets(), (config.wallets.intervalSeconds ?? 25) * 1000),
  setInterval(() => {
    console.error(`[status] ${books.size} books | ${counts.rows} rows | ${counts.joined} joined` +
      ` | ${counts.sweeps} sweeps | ${counts.gaps} gaps | ${links.size} linked | ${store.path}`);
  }, 60000),
];

function shutdown() {
  for (const timer of timers) clearInterval(timer);
  feed.stop();
  store.flush();
  mapping.save();
  console.error(`\n[status] wrote ${counts.rows} book rows, ${counts.joined} joined,` +
    ` ${counts.sweeps} sweeps, ${counts.gaps} gaps`);
  store.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
