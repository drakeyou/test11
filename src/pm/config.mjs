// One config file for the Polymarket side, merged over the defaults below.
//
// The gg.bet collector keeps its own CLI flags untouched; what it shares here is
// only the path to the files it already writes, which module C tails read-only.

import { existsSync, readFileSync } from 'node:fs';

export const DEFAULTS = {
  // Event-slug prefix -> gg.bet sportId. Polymarket puts the discipline in the
  // event slug ("cs2-sangal-psna-2026-08-26"), not reliably in the question:
  // a handicap market reads "Map 1 Rounds Handicap: A (-6.5) vs B (+6.5)" and
  // names no sport at all.
  disciplines: {
    cs2: 'esports_counter_strike',
    csgo: 'esports_counter_strike',
    dota2: 'esports_dota_2',
    dota: 'esports_dota_2',
    lol: 'esports_league_of_legends',
    val: 'esports_valorant',
    valorant: 'esports_valorant',
    r6: 'esports_rainbow_six',
    atp: 'tennis',
    wta: 'tennis',
    tennis: 'tennis',
  },
  gamma: { intervalSeconds: 45, pageSize: 100, maxPages: 12 },
  book: { heartbeatSeconds: 5, reconnectMinMs: 1000, reconnectMaxMs: 60000 },
  // A tick is 0.001, so "three ticks" would fire on 0.300 -> 0.297, which is
  // noise rather than a book collapse. Both rules below are logged separately
  // and the thresholds are meant to be retuned once there is data.
  sweep: {
    levelsCrossed: 3,
    bidDrop: 0.03,
    depthWindowSeconds: 10,
    depthDropRatio: 0.5,
    depthAbovePrice: 0.05,
  },
  wallets: { intervalSeconds: 25, addresses: [] },
  ggbet: {
    oddsHistory: 'odds-history.csv',
    changes: 'changes.csv',
    mapping: 'mapping.csv',
    matchWindowHours: 6,
  },
  storage: { dir: 'data' },
};

/** Shallow-merge each top-level section so a partial config file is enough. */
function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(base[key] ?? {}), ...value }
      : value;
  }
  return out;
}

export function loadConfig(path = 'pm.config.json') {
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    return merge(DEFAULTS, JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}
