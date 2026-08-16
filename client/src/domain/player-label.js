export function playerIdFromName(name) {
  return String(name).trim();
}

export function eventPlayerRecord(player) {
  return {
    playerId: player.playerId,
    name: player.name,
    status: "available",
    defaultPositions: [],
    goalkeeperEligible: true
  };
}

const groupOrder = position => ({ forward: 0, mid: 1, back: 2, gk: 3 })[position.split("_")[0]] ?? 4;
const sideOrder = position => position.includes("_left") ? 0 : position.includes("_right") ? 2 : 1;

export function orderedScorerGroups(field, bench = []) {
  field = field && typeof field === "object" ? field : {};
  bench = Array.isArray(bench) ? bench.filter(player => player?.playerId) : [];
  const knownIds = new Set();
  const onField = [];
  for (const [position, playerId] of Object.entries(field).sort(([a], [b]) => groupOrder(a) - groupOrder(b) || sideOrder(a) - sideOrder(b))) {
    if (playerId && !knownIds.has(playerId)) { onField.push(playerId); knownIds.add(playerId); }
  }
  for (const playerId of Object.values(field)) {
    if (playerId && !knownIds.has(playerId)) { onField.push(playerId); knownIds.add(playerId); }
  }
  const offField = bench.map(player => player.playerId).filter(playerId => !knownIds.has(playerId));
  return { onField, offField };
}
