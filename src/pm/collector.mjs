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

const config = loadConfig();
const once = process.argv.includes('--once');

const store = new Store(config.storage.dir);
const registry = new MarketRegistry();
const detector = new SweepDetector(config.sweep);
const books = new Map();
const counts = { rows: 0, sweeps: 0, gaps: 0, messages: 0 };

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
if (once) {
  const segment = tracked.filter((r) => r.level === 'segment').length;
  console.log(`tracking ${tracked.length} markets (${segment} in-match), database ${store.path}`);
  store.close();
  process.exit(0);
}

const timers = [
  setInterval(() => discover().catch((err) => console.error(`[discovery] ${err.message}`)),
    config.gamma.intervalSeconds * 1000),
  setInterval(heartbeat, config.book.heartbeatSeconds * 1000),
  setInterval(() => {
    console.error(`[status] ${books.size} books | ${counts.rows} rows | ${counts.sweeps} sweeps` +
      ` | ${counts.gaps} gaps | ${counts.messages} msgs | ${store.path}`);
  }, 60000),
];

function shutdown() {
  for (const timer of timers) clearInterval(timer);
  feed.stop();
  store.flush();
  console.error(`\n[status] wrote ${counts.rows} book rows, ${counts.sweeps} sweeps, ${counts.gaps} gaps`);
  store.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
