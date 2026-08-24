// Console rendering for the live table, kept apart from the browser plumbing so
// it can be exercised against recorded captures without launching Playwright.

import { sportName } from './sports.mjs';

const CLEAR = '\x1b[2J\x1b[H';

function matchLines(m, previous) {
  const lines = [];
  const mapName = m.mapName && m.mapName !== 'UNKNOWN' ? m.mapName.toLowerCase() : null;
  const state = [
    m.currentMap ? `map ${m.currentMap}` : null,
    mapName,
    m.roundScore,
    m.round ? `round ${m.round}` : null,
    m.gameState,
    m.bombPlanted ? 'BOMB' : null,
  ].filter(Boolean).join(' · ');

  lines.push('');
  lines.push(`${m.title}${m.mapScore ? `   ${m.mapScore}` : ''}${m.betStop ? '   [BET STOP]' : ''}`);
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
 * @param {{clear?: boolean, now?: Date}} [options]
 */
export function renderMatches(matches, previous = new Map(), options = {}) {
  const { clear = true, now = new Date() } = options;
  const lines = [];
  if (clear) lines.push(CLEAR);
  lines.push(`gg.bet · live · ${now.toLocaleTimeString()}`);
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
