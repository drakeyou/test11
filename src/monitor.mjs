#!/usr/bin/env node
// Live CS2 score/odds monitor for gg.bet.
//
// The page gets its data from two GraphQL websockets, so the monitor listens to
// those frames instead of scraping the DOM. See src/parse.mjs for the shapes.
//
//   node src/monitor.mjs --discover      capture raw payloads into captures/
//   node src/monitor.mjs                 live table + odds history to CSV
//
// A browser that dies takes the session with it, so the watch loop reports what
// happened and starts a fresh one; the collected matches survive the restart.

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { MatchStore, parseFrame } from './parse.mjs';
import { renderMatches } from './render.mjs';

const DEFAULTS = {
  url: 'https://gg.bet/ru/live?sportId=esports_counter_strike',
  interval: 5,
  out: 'odds-history.csv',
  captures: 'captures',
};

const HELP = `
gg.bet live CS2 monitor

  --discover          capture raw API payloads to ./captures, then exit
  --url <url>         page to open (default: live CS section)
  --interval <sec>    redraw interval in watch mode (default: 5)
  --out <file>        CSV history file (default: odds-history.csv)
  --proxy <server>    e.g. http://user:pass@host:port
  --headful           show the browser window
  --once              run one session; do not restart after a failure
`;

function parseArgs(argv) {
  const opts = { ...DEFAULTS, discover: false, headful: false, proxy: null, help: false, once: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--discover') opts.discover = true;
    else if (arg === '--headful') opts.headful = true;
    else if (arg === '--once') opts.once = true;
    else if (arg === '--url') opts.url = next();
    else if (arg === '--interval') opts.interval = Number(next());
    else if (arg === '--out') opts.out = next();
    else if (arg === '--proxy') opts.proxy = next();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** Parse "http://user:pass@host:port" into Playwright's proxy option. */
function proxyOption(spec) {
  if (!spec) return undefined;
  const url = new URL(spec);
  const server = `${url.protocol}//${url.host}`;
  return url.username
    ? { server, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
    : { server };
}

function decode(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const oddKey = (match, market, odd) => `${match.id}|${market.id}|${odd.id}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one browser session until it fails or the page goes away.
 * Throws with a description of what ended it, so the caller can restart.
 */
async function session(opts, store, recorded, shown) {
  const browser = await chromium.launch({ headless: !opts.headful, proxy: proxyOption(opts.proxy) });
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  let ended = null;
  const end = (reason) => { ended ??= reason; };
  browser.on('disconnected', () => end('browser disconnected'));
  page.on('close', () => end('page closed'));
  page.on('crash', () => end('page crashed'));

  let captureCount = 0;

  async function capture(source, url, body) {
    const payload = decode(body);
    if (!payload) return;
    await mkdir(opts.captures, { recursive: true });
    const name = `${String(++captureCount).padStart(4, '0')}-${source}.json`;
    await writeFile(`${opts.captures}/${name}`, JSON.stringify({ url, payload }, null, 2));
    console.log(`[${source}] ${name}  ${body.length}b  ops:${parseFrame(payload).length}  ${url.slice(0, 80)}`);
  }

  async function ingest(body) {
    const payload = decode(body);
    if (!payload) return;
    const ops = parseFrame(payload);
    if (!ops.length) return;
    store.apply(ops);

    const rows = [];
    const stamp = new Date().toISOString();
    for (const m of store.list()) {
      // Until the snapshot names the teams a match is just a uuid; recording it
      // would put unusable rows in the history.
      if (!m.resolved) continue;
      for (const market of m.markets) {
        for (const odd of market.odds) {
          const key = oddKey(m, market, odd);
          if (recorded.get(key) === odd.price) continue;
          recorded.set(key, odd.price);
          rows.push([stamp, m.id, m.title, m.mapScore, m.currentMap, m.roundScore,
            market.name, odd.name, odd.price, odd.isActive].map(csvCell).join(','));
        }
      }
    }
    if (rows.length) await appendFile(opts.out, rows.join('\n') + '\n');
  }

  if (opts.discover) {
    page.on('response', async (response) => {
      if (!(response.headers()['content-type'] ?? '').includes('json')) return;
      try {
        await capture('xhr', response.url(), await response.text());
      } catch {
        // response bodies expire on navigation; nothing to recover here
      }
    });
  }

  page.on('websocket', (ws) => {
    console.error(`websocket: ${ws.url()}`);
    ws.on('framereceived', (frame) => {
      const data = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
      (opts.discover ? capture('ws', ws.url(), data) : ingest(data))
        .catch((err) => console.error(`frame dropped: ${err.message}`));
    });
  });

  console.error(`opening ${opts.url} ...`);
  await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  if (opts.discover) {
    console.error('discover mode — capturing for 60s, Ctrl-C to stop early');
    await delay(60000);
    console.error(`\nwrote ${captureCount} payloads to ${opts.captures}/`);
    await browser.close();
    return;
  }

  try {
    for (;;) {
      const matches = store.list().filter((m) => m.resolved);
      // Arrows compare against the previous frame on screen, which is not the
      // same thing as the last price written to the CSV.
      console.log(renderMatches(matches, shown));
      for (const m of matches) {
        for (const market of m.markets) {
          for (const odd of market.odds) shown.set(oddKey(m, market, odd), odd.price);
        }
      }
      await delay(opts.interval * 1000);
      if (ended) throw new Error(ended);
      if (!browser.isConnected()) throw new Error('browser is no longer connected');
      if (page.isClosed()) throw new Error('page was closed');
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  // Piping into `head` closes stdout early; exit quietly rather than crashing.
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
  });
  process.on('unhandledRejection', (err) => {
    console.error(`unhandled rejection: ${err?.message ?? err}`);
  });

  if (!opts.discover && !existsSync(opts.out)) {
    await writeFile(opts.out,
      'ts,match_id,title,map_score,current_map,round_score,market,selection,price,is_active\n');
  }

  const store = new MatchStore();
  const recorded = new Map();
  const shown = new Map();

  for (let attempt = 1; ; attempt++) {
    try {
      await session(opts, store, recorded, shown);
      return; // discover mode finished normally
    } catch (err) {
      if (opts.discover || opts.once) throw err;
      const wait = Math.min(30, 2 ** Math.min(attempt, 4));
      console.error(`\nsession ended: ${err.message} — restarting in ${wait}s (attempt ${attempt})`);
      await delay(wait * 1000);
    }
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
