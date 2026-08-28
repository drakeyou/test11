// Console rendering for the live table, kept apart from the browser plumbing so
// it can be exercised against recorded captures without launching Playwright.

import { sportName } from './sports.mjs';

const CLEAR = '\x1b[2J\x1b[H';

function matchLines(m, previous) {
  const lines = [];
  const state = [
    m.segmentNo ? `${m.segmentKind} ${m.segmentNo}${m.bestOf ? `/${m.bestOf}` : ''}` : null,
    m.segmentName?.toLowerCase() ?? null,
    m.segmentScore,
    m.round ? `round ${m.round}` : null,
    m.state,
    ...(m.extra ?? []),
  ].filter(Boolean).join(' · ');

  lines.push('');
  lines.push(`${m.title}${m.score ? `   ${m.score}` : ''}${m.betStop ? '   [BET STOP]' : ''}`);
  if (m.tournament) lines.push(`  ${m.tournament}`);
  if (state) lines.push(`  ${state}`);

  for (const market of m.markets) {
    if (!market.odds.length) continue;
    lines.push(`  ${market.name}:`);
    for (const odd of market.odds) {
      const was = previous.get(`${m.id}|${market.id}|${odd.id}`);
      const move = was === undefined || was === odd.price ? ' ' : odd.price > was ? '^' : 'v';
      lines.push(`   ${move} ${odd.name.padEnd(26)} ${odd.price.toFixed(2)}` +
        (odd.isActive ? '' : '  (suspended)'));
    }
  }
  return lines;
}

function groupBySport(matches) {
  const groups = new Map();
  for (const m of matches) {
    const key = m.sport ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return groups;
}

/**
 * @param {Array<object>} matches  output of MatchStore#list()
 * @param {Map<string, number>} previous  last shown price per odd key, for arrows
 * @param {{clear?: boolean, now?: Date, coverage?: Array}} [options]
 */
export function renderMatches(matches, previous = new Map(), options = {}) {
  const { clear = true, now = new Date(), coverage = [] } = options;
  const lines = [];
  if (clear) lines.push(CLEAR);
  lines.push(`gg.bet · live · ${now.toLocaleTimeString()}`);

  // The site delivers its live list a page at a time. A shortfall here means
  // matches exist that were never subscribed to, and it must never be silent.
  const short = coverage.filter((c) => c.have < c.expected);
  if (short.length) {
    lines.push('missing: ' + short
      .map((c) => `${sportName(c.sport)} ${c.have}/${c.expected}`).join(', ') +
      '  — list not fully loaded');
  }
  lines.push('='.repeat(74));

  if (!matches.length) {
    lines.push('waiting for the first websocket frames...');
    return lines.join('\n');
  }

  const groups = groupBySport(matches);
  // With one sport a header would be noise; with several it is the only way to
  // tell a tennis set score from a CS map score at a glance.
  for (const [sport, group] of groups) {
    if (groups.size > 1) {
      const label = sportName(sport);
      lines.push('');
      lines.push(`── ${label} (${group.length}) ${'─'.repeat(Math.max(0, 52 - label.length))}`);
    }
    for (const m of group) lines.push(...matchLines(m, previous));
  }
  return lines.join('\n');
}
