// Heuristic extraction of match/odds records out of arbitrary JSON payloads.
//
// gg.bet's internal API shape is not documented and changes without notice, so
// nothing here keys off specific field names. Instead we walk the payload and
// keep objects that look like a match: two named sides plus at least one price.
// Run `--discover` first and inspect captures/ if a payload is missed.

const TEAM_KEYS = /^(home|away|team|competitor|participant|opponent)/i;
const TEAM_NAME_KEYS = /^(name|title|shortName|slug|abbreviation)$/i;
const ODDS_KEYS = /^(odd|odds|price|coef|coefficient|rate|value|decimal)/i;
const SCORE_KEYS = /^(score|scores|result|points|rounds|games|maps)/i;
const MARKET_KEYS = /^(market|bet|betType|outcome|selection|title|name)$/i;

const isObj = (v) => v !== null && typeof v === 'object';

/** Pull a human-readable name out of a team-ish value. */
function teamName(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!isObj(value)) return null;
  for (const [k, v] of Object.entries(value)) {
    if (TEAM_NAME_KEYS.test(k) && typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Collect the two sides of a match, either from paired keys or a 2-item array. */
function teamsOf(node) {
  const named = [];
  for (const [k, v] of Object.entries(node)) {
    if (!TEAM_KEYS.test(k)) continue;
    if (Array.isArray(v) && v.length === 2) {
      const pair = v.map(teamName).filter(Boolean);
      if (pair.length === 2) return pair;
      continue;
    }
    const name = teamName(v);
    if (name) named.push(name);
  }
  return named.length === 2 ? named : null;
}

/** A decimal odd is a number in a plausible range; strings are coerced. */
function asPrice(value) {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1.01 && n <= 1000 ? n : null;
}

/** Walk a subtree and collect every {market, selection, price} triple. */
function oddsOf(node, depth = 0) {
  const found = [];
  if (depth > 6 || !isObj(node)) return found;

  const values = Array.isArray(node) ? node.entries() : Object.entries(node);
  for (const [key, value] of values) {
    if (isObj(value)) {
      found.push(...oddsOf(value, depth + 1));
      continue;
    }
    if (!ODDS_KEYS.test(String(key))) continue;
    const price = asPrice(value);
    if (price === null) continue;

    let selection = null;
    let market = null;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== 'string') continue;
      if (!selection && MARKET_KEYS.test(k)) selection = v;
      else if (!market && MARKET_KEYS.test(k)) market = v;
    }
    found.push({ market: market ?? 'unknown', selection: selection ?? String(key), price });
  }
  return found;
}

/** Flatten anything score-shaped into a display string like "1:0" or "13:9". */
function scoreOf(node) {
  for (const [k, v] of Object.entries(node)) {
    if (!SCORE_KEYS.test(k)) continue;
    if (typeof v === 'string' && /\d/.test(v)) return v;
    if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')) {
      return `${v[0]}:${v[1]}`;
    }
    if (isObj(v)) {
      const nums = Object.values(v).filter((n) => typeof n === 'number');
      if (nums.length === 2) return `${nums[0]}:${nums[1]}`;
      const nested = scoreOf(v);
      if (nested) return nested;
    }
  }
  return null;
}

function idOf(node, teams) {
  for (const [k, v] of Object.entries(node)) {
    if (/^(id|matchId|eventId|uuid|slug)$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      return String(v);
    }
  }
  return teams.join(' vs ');
}

function tournamentOf(node) {
  for (const [k, v] of Object.entries(node)) {
    if (/^(tournament|league|competition|series|event)$/i.test(k)) {
      const name = teamName(v);
      if (name) return name;
    }
  }
  return null;
}

/**
 * Walk any decoded payload and return the matches found in it.
 * @returns {Array<{id,teams,score,tournament,odds}>}
 */
export function extractMatches(payload, depth = 0, seen = new Set()) {
  const out = [];
  if (depth > 8 || !isObj(payload) || seen.has(payload)) return out;
  seen.add(payload);

  if (Array.isArray(payload)) {
    for (const item of payload) out.push(...extractMatches(item, depth + 1, seen));
    return out;
  }

  const teams = teamsOf(payload);
  if (teams) {
    const odds = oddsOf(payload);
    if (odds.length) {
      out.push({
        id: idOf(payload, teams),
        teams,
        score: scoreOf(payload),
        tournament: tournamentOf(payload),
        odds,
      });
      return out; // don't double-count nested markets of the same match
    }
  }

  for (const value of Object.values(payload)) {
    if (isObj(value)) out.push(...extractMatches(value, depth + 1, seen));
  }
  return out;
}
