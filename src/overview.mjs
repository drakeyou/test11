// The databet scoreboard sends a different overview type per sport. Each one is
// reduced here to the same handful of fields, so the store, the renderer and the
// change log stay sport-agnostic.
//
// Shapes taken from the captures: CSGOOverview and TennisOverview count rounds
// and games, the MOBA ones count kills and carry a gold lead. What every sport
// shares is "which segment are we in" (map or set) and "what is the score
// inside it".

const pair = (home, away) =>
  home === undefined || away === undefined ? null : `${home}:${away}`;

/** Tennis points arrive as POINT0 / POINT15 / POINT30 / POINT40 / POINT_ABOVE. */
function point(value) {
  if (!value || value === 'UNKNOWN') return null;
  if (value === 'POINT_ABOVE' || value === 'ADVANTAGE') return 'AD';
  return value.replace(/^POINT/, '');
}

const HANDLERS = {
  CSGOOverview(o) {
    const map = (o.maps ?? []).find((m) => m.number === o.currentMap);
    return {
      segmentKind: 'map',
      segmentNo: o.currentMap ?? null,
      segmentName: o.mapName && o.mapName !== 'UNKNOWN' ? o.mapName : null,
      segmentScore: map ? pair(map.home?.score, map.away?.score) : null,
      round: o.currentRound ?? null,
      state: o.gameState ?? null,
      bestOf: o.bestOf ?? null,
      extra: [o.bomb?.isPlanted ? 'BOMB' : null, o.matchFormat ?? null].filter(Boolean),
    };
  },

  LOLOverview(o) {
    const map = (o.maps ?? []).find((m) => m.number === o.currentMap);
    return {
      segmentKind: 'map',
      segmentNo: o.currentMap ?? null,
      segmentName: null,
      segmentScore: map ? pair(map.teams?.home?.kills, map.teams?.away?.kills) : null,
      round: null,
      state: o.timer?.isActive ? 'live' : null,
      bestOf: o.bestOf ?? null,
      extra: [o.currentGoldLead ? `gold ${o.currentGoldLead > 0 ? '+' : ''}${o.currentGoldLead}` : null]
        .filter(Boolean),
    };
  },

  Dota2Overview(o) {
    const summary = HANDLERS.LOLOverview(o);
    const map = (o.maps ?? []).find((m) => m.number === o.currentMap);
    const side = map?.teams?.home?.side;
    return {
      ...summary,
      extra: [...summary.extra, side && side !== 'UNKNOWN' ? `home ${side.toLowerCase()}` : null]
        .filter(Boolean),
    };
  },

  TennisOverview(o) {
    const set = (o.sets ?? []).find((s) => s.number === o.currentSet);
    const home = o.teams?.home;
    const away = o.teams?.away;
    const tieBreak = pair(home?.tieBreak?.score, away?.tieBreak?.score);
    const points = pair(point(home?.gamePoint?.gamePoint), point(away?.gamePoint?.gamePoint));
    return {
      segmentKind: 'set',
      segmentNo: o.currentSet ?? null,
      segmentName: null,
      segmentScore: set ? pair(set.gameScore?.home, set.gameScore?.away) : null,
      round: null,
      // COMMON is the ordinary run of play and says nothing worth printing.
      state: o.pause ? 'pause'
        : set?.state && set.state !== 'COMMON' ? set.state.toLowerCase().replace(/_/g, '-')
        : null,
      bestOf: null,
      extra: [
        points && !points.includes('null') ? points : null,
        tieBreak && tieBreak !== '0:0' ? `tb ${tieBreak}` : null,
        o.server && o.server !== 'UNKNOWN' ? `serve ${o.server.toLowerCase()}` : null,
      ].filter(Boolean),
    };
  },
};

/** Best effort for a sport whose overview type we have not seen yet. */
function generic(o) {
  return {
    segmentKind: o.currentSet !== undefined ? 'set' : 'map',
    segmentNo: o.currentMap ?? o.currentSet ?? null,
    segmentName: o.mapName && o.mapName !== 'UNKNOWN' ? o.mapName : null,
    segmentScore: pair(o.teams?.home?.score, o.teams?.away?.score),
    round: o.currentRound ?? null,
    state: o.gameState ?? null,
    bestOf: o.bestOf ?? null,
    extra: [],
  };
}

/**
 * Reduce a databet overview to the fields the rest of the app uses.
 * @returns {object|null} null when there is no overview yet
 */
export function summarizeOverview(overview) {
  if (!overview || typeof overview !== 'object') return null;
  const handler = HANDLERS[overview.__typename];
  return { type: overview.__typename ?? 'unknown', ...(handler ?? generic)(overview) };
}
