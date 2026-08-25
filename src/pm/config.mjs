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
  // The tick is per-market, not a constant: of the esports markets sampled, 58
  // run at 0.01 and 7 at 0.001. So the bid-drop rule is expressed in ticks of
  // the market itself, with an absolute floor so the 0.001 books do not fire on
  // noise. Both rules are logged separately and meant to be retuned on data.
  sweep: {
    levelsCrossed: 3,
    bidDropTicks: 3,
    bidDropMin: 0.02,
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
