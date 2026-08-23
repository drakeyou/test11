// Parser for gg.bet's live data, which arrives over two GraphQL websockets.
//
//   wss://gg-b-gql.gg.bet/graphql          line and odds
//   wss://score-board.databet.cloud/graphql  CS-specific live state
//
// Both speak the legacy subscriptions-transport-ws envelope:
//   { id, type: "data", payload: { data: { <field>: ... } } }
//
// The odds stream sends one full snapshot (`matches`) and then partial patches
// (`onUpdateSportEvent`) that carry competitor ids but no names, so updates are
// only meaningful when merged onto the snapshot. MatchStore does that merge.

/** Event ids are provider-prefixed on gg.bet ("5:<uuid>") and bare on databet. */
export function normalizeId(id) {
  return typeof id === 'string' ? id.replace(/^[^:]+:/, '') : id;
}

/** Turn the CompetitorScore array into { total, maps: { 1: 13, 2: 11 } }. */
function scoresOf(list) {
  const out = { maps: {} };
  for (const s of list ?? []) {
    const points = Number(s.points);
    if (!Number.isFinite(points)) continue;
    if (s.type === 'total') out.total = points;
    else if (s.type === 'map') out.maps[s.number] = points;
  }
  return out;
}

function competitorOf(raw) {
  const out = { id: raw.id, scores: scoresOf(raw.score) };
  if (raw.name) out.name = raw.name;
  if (raw.homeAway) out.side = raw.homeAway;
  if (raw.logo) out.logo = raw.logo;
  return out;
}

function marketOf(raw) {
  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    typeId: raw.typeId,
    odds: (raw.odds ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      price: Number(o.value),
      isActive: o.isActive === true,
      competitorIds: o.competitorIds ?? [],
    })),
  };
}

/** Normalize a SportEvent, keeping only the fields the frame actually carried. */
function eventOf(raw) {
  const fixture = raw.fixture ?? {};
  const out = { id: normalizeId(raw.id), sourceId: raw.id };

  if (raw.slug) out.slug = raw.slug;
  if (typeof raw.betStop === 'boolean') out.betStop = raw.betStop;
  if (fixture.title) out.title = fixture.title;
  if (fixture.score) out.mapScore = fixture.score;
  if (fixture.status) out.status = fixture.status;
  if (fixture.startTime) out.startTime = fixture.startTime;
  if (fixture.tournament?.name) out.tournament = fixture.tournament.name;
  if (fixture.competitors) out.competitors = fixture.competitors.map(competitorOf);
  if (raw.markets) out.markets = raw.markets.map(marketOf);

  return out;
}

/**
 * Decode one websocket frame into store operations.
 * Unknown frames (keepalives, betslip maths, banners) yield an empty array.
 * @returns {Array<{kind:'event',event:object}|{kind:'overview',id:string,overview:object}>}
 */
export function parseFrame(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'data') return [];
  const data = payload.payload?.data;
  if (!data || typeof data !== 'object') return [];

  const ops = [];
  for (const event of data.matches?.sportEvents ?? []) {
    ops.push({ kind: 'event', event: eventOf(event) });
  }
  if (data.onUpdateSportEvent) {
    ops.push({ kind: 'event', event: eventOf(data.onUpdateSportEvent) });
  }
  for (const row of data.onUpdateSportEventOverviews?.replace ?? []) {
    if (row.overview) ops.push({ kind: 'overview', id: normalizeId(row.id), overview: row.overview });
  }
  return ops;
}

function mergeCompetitors(prev = [], next) {
  if (!next) return prev;
  const byId = new Map(prev.map((c) => [c.id, c]));
  return next.map((c) => {
    const old = byId.get(c.id);
    return old ? { ...old, ...c, scores: { ...old.scores, ...c.scores } } : c;
  });
}

/** Accumulates frames into a live view of every match. */
export class MatchStore {
  #matches = new Map();

  apply(ops) {
    for (const op of ops) {
      if (op.kind === 'event') {
        const prev = this.#matches.get(op.event.id);
        const merged = prev ? { ...prev, ...op.event } : op.event;
        merged.competitors = mergeCompetitors(prev?.competitors, op.event.competitors);
        this.#matches.set(op.event.id, merged);
      } else if (op.kind === 'overview') {
        const prev = this.#matches.get(op.id) ?? { id: op.id };
        this.#matches.set(op.id, { ...prev, live: op.overview });
      }
    }
    return this;
  }

  get size() {
    return this.#matches.size;
  }

  /** Flatten to the fields a display or a CSV row needs. */
  list() {
    return [...this.#matches.values()].map((m) => {
      const [home, away] = m.competitors ?? [];
      const map = m.live?.currentMap;
      const mapEntry = (m.live?.maps ?? []).find((x) => x.number === map);
      // Patches arrive before the snapshot that names the teams, so a match can
      // be known by id alone for the first few frames. Callers skip those.
      const title = m.title ?? (home?.name && away?.name ? `${home.name} vs ${away.name}` : null);
      return {
        id: m.id,
        resolved: title !== null,
        title: title ?? m.id,
        tournament: m.tournament ?? null,
        status: m.status ?? null,
        betStop: m.betStop === true,
        mapScore: m.mapScore ?? null,
        currentMap: map ?? null,
        mapName: m.live?.mapName ?? null,
        round: m.live?.currentRound ?? null,
        gameState: m.live?.gameState ?? null,
        bestOf: m.live?.bestOf ?? null,
        roundScore: mapEntry ? `${mapEntry.home.score}:${mapEntry.away.score}` : null,
        bombPlanted: m.live?.bomb?.isPlanted ?? null,
        markets: m.markets ?? [],
      };
    });
  }
}
