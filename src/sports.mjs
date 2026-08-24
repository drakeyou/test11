// Sports the monitor can follow. The ids are gg.bet's own `sportId` values,
// taken from the categorizerSportList payload in samples/0021-ws.json rather
// than guessed; the short keys are just CLI conveniences.

export const SPORTS = Object.fromEntries(Object.entries({
  cs: { id: 'esports_counter_strike', name: 'Counter-Strike' },
  lol: { id: 'esports_league_of_legends', name: 'League of Legends' },
  dota: { id: 'esports_dota_2', name: 'Dota 2' },
  valorant: { id: 'esports_valorant', name: 'Valorant' },
  tennis: { id: 'tennis', name: 'Теннис' },
  table_tennis: { id: 'table_tennis', name: 'Настольный теннис' },
}).map(([key, sport]) => [key, { key, ...sport }]));

const BY_ID = new Map(Object.values(SPORTS).map((s) => [s.id, s]));

export const sportName = (id) => BY_ID.get(id)?.name ?? id ?? 'unknown';

export const liveUrl = (id) => `https://gg.bet/ru/live?sportId=${encodeURIComponent(id)}`;

/**
 * Resolve a --sport value into sport entries.
 * Accepts short keys ("cs,lol"), raw sportIds, or "all".
 */
export function resolveSports(spec) {
  const wanted = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  if (wanted.includes('all')) return Object.values(SPORTS);

  return wanted.map((key) => {
    const found = SPORTS[key] ?? BY_ID.get(key);
    if (found) return found;
    if (key.includes('_')) return { key, id: key, name: key }; // unlisted sportId, pass through
    throw new Error(`unknown sport "${key}" — known: ${Object.keys(SPORTS).join(', ')}, or a raw sportId`);
  });
}
