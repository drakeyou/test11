#!/usr/bin/env node
// Live CS2 score/odds monitor for gg.bet.
//
// Reads the site's own API traffic (XHR + WebSocket) rather than scraping the
// DOM, so a redesign of the page markup doesn't break it.
//
//   node src/monitor.mjs --discover      capture raw payloads into captures/
//   node src/monitor.mjs                 live table + odds history to CSV
//
// Run --discover first: it tells you whether the data arrives over XHR or the
// websocket, and leaves samples on disk to tune src/extract.mjs against.

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { extractMatches } from './extract.mjs';

const DEFAULTS = {
  url: 'https://gg.bet/ru/live?sportId=esports_counter_strike',
  interval: 10,
  out: 'odds-history.csv',
  captures: 'captures',
};

const HELP = `
gg.bet live CS2 monitor

  --discover          capture raw API payloads to ./captures, then exit
  --url <url>         page to open (default: live CS section)
  --interval <sec>    redraw interval in watch mode (default: 10)
  --out <file>        CSV history file (default: odds-history.csv)
  --proxy <server>    e.g. http://user:pass@host:port
  --headful           show the browser window
`;

function parseArgs(argv) {
  const opts = { ...DEFAULTS, discover: false, headful: false, proxy: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--discover') opts.discover = true;
    else if (arg === '--headful') opts.headful = true;
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

const CLEAR = '\x1b[2J\x1b[H';

function render(matches, previous) {
  const lines = [CLEAR, `gg.bet · CS2 live · ${new Date().toLocaleTimeString()}`, '='.repeat(72)];

  if (!matches.size) {
    lines.push('no matches parsed yet — if this persists, run --discover and inspect captures/');
    console.log(lines.join('\n'));
    return;
  }

  for (const [id, m] of matches) {
    lines.push('');
    lines.push(`${m.teams[0]} vs ${m.teams[1]}${m.score ? `  ${m.score}` : ''}`);
    if (m.tournament) lines.push(`  ${m.tournament}`);
    for (const o of m.odds.slice(0, 8)) {
      const was = previous.get(`${id}|${o.market}|${o.selection}`);
      const arrow = was === undefined || was === o.price ? ' ' : o.price > was ? '^' : 'v';
      lines.push(`  ${arrow} ${o.selection.padEnd(28)} ${o.price.toFixed(2)}`);
    }
  }
  console.log(lines.join('\n'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const browser = await chromium.launch({
    headless: !opts.headful,
    proxy: proxyOption(opts.proxy),
  });
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const matches = new Map();
  const lastPrice = new Map();
  let captureCount = 0;

  async function ingest(source, url, body) {
    const payload = decode(body);
    if (!payload) return;

    if (opts.discover) {
      await mkdir(opts.captures, { recursive: true });
      const name = `${String(++captureCount).padStart(4, '0')}-${source}.json`;
      await writeFile(`${opts.captures}/${name}`, JSON.stringify({ url, payload }, null, 2));
      console.log(`[${source}] ${name}  ${body.length}b  matches:${extractMatches(payload).length}  ${url.slice(0, 90)}`);
      return;
    }

    const rows = [];
    const stamp = new Date().toISOString();
    for (const m of extractMatches(payload)) {
      matches.set(m.id, m);
      for (const o of m.odds) {
        const key = `${m.id}|${o.market}|${o.selection}`;
        if (lastPrice.get(key) === o.price) continue;
        lastPrice.set(key, o.price);
        rows.push([stamp, m.id, m.teams[0], m.teams[1], m.score, o.market, o.selection, o.price]
          .map(csvCell).join(','));
      }
    }
    if (rows.length) await appendFile(opts.out, rows.join('\n') + '\n');
  }

  page.on('response', async (response) => {
    if (!(response.headers()['content-type'] ?? '').includes('json')) return;
    try {
      await ingest('xhr', response.url(), await response.text());
    } catch {
      // response bodies expire on navigation; nothing to recover here
    }
  });

  page.on('websocket', (ws) => {
    console.error(`websocket: ${ws.url()}`);
    ws.on('framereceived', (frame) => {
      const data = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
      ingest('ws', ws.url(), data).catch(() => {});
    });
  });

  console.error(`opening ${opts.url} ...`);
  await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  if (opts.discover) {
    console.error('discover mode — capturing for 60s, Ctrl-C to stop early');
    await page.waitForTimeout(60000);
    console.error(`\nwrote ${captureCount} payloads to ${opts.captures}/`);
    await browser.close();
    return;
  }

  if (!existsSync(opts.out)) {
    await writeFile(opts.out, 'ts,match_id,team_a,team_b,score,market,selection,price\n');
  }
  for (;;) {
    render(matches, lastPrice);
    await page.waitForTimeout(opts.interval * 1000);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
