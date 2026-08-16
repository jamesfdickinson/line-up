export function matchIdsForTeam(events, teamId) {
  return [...new Set(events
    .filter(event => event.type === "match_created" && event.payload?.teamId === teamId)
    .map(event => event.matchId))];
}
