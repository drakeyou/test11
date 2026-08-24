#!/usr/bin/env node
// Live score/odds monitor for gg.bet.
//
// Each sport is its own live page with its own websocket subscriptions, so the
// monitor opens one tab per sport and feeds every frame into a shared store.
//
//   node src/monitor.mjs                         Counter-Strike
//   node src/monitor.mjs --sport cs,lol,tennis   several at once
//   node src/monitor.mjs --sport all --discover  capture raw payloads
//
// Two files come out of a watch run: odds-history.csv answers "what was the
// price at time T", changes.csv answers "what happened, in order".

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { appender } from './appender.mjs';
import { MatchStore, parseFrame } from './parse.mjs';
import { renderMatches } from './render.mjs';
import { liveUrl, resolveSports } from './sports.mjs';

const DEFAULTS = {
  sport: 'cs',
  interval: 5,
  out: 'odds-history.csv',
  log: 'changes.csv',
  captures: 'captures',
  url: null,
};

const HELP = `
gg.bet live monitor

  --sport <list>      cs,lol,dota,valorant,tennis,table_tennis or all (default: cs)
                      a raw sportId also works
  --discover          capture raw API payloads to ./captures, then exit
  --url <url>         open this exact page instead of the per-sport live pages
  --interval <sec>    redraw interval in watch mode (default: 5)
  --out <file>        odds history CSV (default: odds-history.csv)
  --log <file>        change log CSV (default: changes.csv)
  --proxy <server>    e.g. http://user:pass@host:port
  --headful           show the browser window
  --once              run one session; do not restart after a failure
`;

const ODDS_HEADER =
  'ts,sport,match_id,title,score,segment,segment_score,market,selection,price,is_active\n';
const LOG_HEADER = 'seq,ts,sport,match_id,title,kind,target,from,to\n';

function parseArgs(argv) {
  const opts = { ...DEFAULTS, discover: false, headful: false, proxy: null, help: false, once: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--discover') opts.discover = true;
    else if (arg === '--headful') opts.headful = true;
    else if (arg === '--once') opts.once = true;
    else if (arg === '--sport') opts.sport = next();
    else if (arg === '--url') opts.url = next();
    else if (arg === '--interval') opts.interval = Number(next());
    else if (arg === '--out') opts.out = next();
    else if (arg === '--log') opts.log = next();
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
const csvRow = (cells) => cells.map(csvCell).join(',');
const oddKey = (match, market, odd) => `${match.id}|${market.id}|${odd.id}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run one browser session until it fails; throws a description of what ended it. */
async function session(opts, targets, store, recorded, shown, counter) {
  const browser = await chromium.launch({ headless: !opts.headful, proxy: proxyOption(opts.proxy) });
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 } });

  let ended = null;
  const end = (reason) => { ended ??= reason; };
  browser.on('disconnected', () => end('browser disconnected'));

  let captureCount = 0;
  const writeLog = appender(opts.log);
  const writeOdds = appender(opts.out);

  async function capture(sport, source, url, body) {
    const payload = decode(body);
    if (!payload) return;
    await mkdir(opts.captures, { recursive: true });
    const name = `${String(++captureCount).padStart(4, '0')}-${sport}-${source}.json`;
    await writeFile(`${opts.captures}/${name}`, JSON.stringify({ sport, url, payload }, null, 2));
    console.log(`[${source}] ${name}  ${body.length}b  ops:${parseFrame(payload).length}  ${url.slice(0, 70)}`);
  }

  async function ingest(sportId, body) {
    const payload = decode(body);
    if (!payload) return;
    const ops = parseFrame(payload);
    if (!ops.length) return;

    const stamp = new Date().toISOString();
    const changes = store.apply(ops, sportId);
    if (changes.length) {
      // A sequence number survives two frames landing in the same millisecond.
      writeLog(changes
        .map((c) => csvRow([++counter.value, stamp, c.sport, c.matchId, c.title, c.kind, c.target, c.from, c.to]))
        .join('\n') + '\n');
    }

    const rows = [];
    for (const m of store.list()) {
      // Until the snapshot names the teams a match is just a uuid; recording it
      // would put unusable rows in the history.
      if (!m.resolved) continue;
      for (const market of m.markets) {
        for (const odd of market.odds) {
          const key = oddKey(m, market, odd);
          if (recorded.get(key) === odd.price) continue;
          recorded.set(key, odd.price);
          rows.push(csvRow([stamp, m.sport, m.id, m.title, m.score, m.segmentNo, m.segmentScore,
            market.name, odd.name, odd.price, odd.isActive]));
        }
      }
    }
    if (rows.length) writeOdds(rows.join('\n') + '\n');
  }

  for (const target of targets) {
    const page = await context.newPage();
    page.on('close', () => end(`page closed (${target.name})`));
    page.on('crash', () => end(`page crashed (${target.name})`));

    if (opts.discover) {
      page.on('response', async (response) => {
        if (!(response.headers()['content-type'] ?? '').includes('json')) return;
        try {
          await capture(target.key, 'xhr', response.url(), await response.text());
        } catch {
          // response bodies expire on navigation; nothing to recover here
        }
      });
    }

    page.on('websocket', (ws) => {
      console.error(`[${target.name}] websocket: ${ws.url()}`);
      ws.on('framereceived', (frame) => {
        const data = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
        (opts.discover ? capture(target.key, 'ws', ws.url(), data) : ingest(target.id, data))
          .catch((err) => console.error(`frame dropped: ${err.message}`));
      });
    });

    console.error(`[${target.name}] opening ${target.url} ...`);
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }

  try {
    if (opts.discover) {
      console.error('discover mode — capturing for 60s, Ctrl-C to stop early');
      await delay(60000);
      console.error(`\nwrote ${captureCount} payloads to ${opts.captures}/`);
      return;
    }

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

  const targets = opts.url
    ? [{ key: 'custom', id: null, name: 'custom', url: opts.url }]
    : resolveSports(opts.sport).map((s) => ({ ...s, url: liveUrl(s.id) }));

  // Piping into `head` closes stdout early; exit quietly rather than crashing.
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
  });
  process.on('unhandledRejection', (err) => {
    console.error(`unhandled rejection: ${err?.message ?? err}`);
  });

  if (!opts.discover) {
    if (!existsSync(opts.out)) await writeFile(opts.out, ODDS_HEADER);
    if (!existsSync(opts.log)) await writeFile(opts.log, LOG_HEADER);
  }

  const store = new MatchStore();
  const recorded = new Map();
  const shown = new Map();
  const counter = { value: 0 };

  for (let attempt = 1; ; attempt++) {
    try {
      await session(opts, targets, store, recorded, shown, counter);
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
