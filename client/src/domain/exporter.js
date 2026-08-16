export function exportMatchJson(events, state) {
  const playerDirectory = Object.fromEntries(Object.values(state.players).map(player => [player.playerId, player.name]));
  return JSON.stringify({
    schemaVersion: 1, exportedAt: new Date().toISOString(), matchId: state.matchId,
    config: state.config, playerDirectory, events, derivedStints: state.stints,
    playerSummary: Object.values(state.players)
  }, null, 2);
}

export function exportEventsCsv(events, state = { players: {} }) {
  const nameOf = id => id ? state.players?.[id]?.name || "Unknown" : "";
  const headers = ["event_id", "match_id", "sequence", "event_type", "game_time_ms", "real_timestamp", "time_source", "player_id", "player_name", "payload_json"];
  const rows = events.map(e => {
    const playerId = e.payload?.playerId || e.payload?.player?.playerId || "";
    return [e.eventId, e.matchId, e.sequence, e.type, e.gameTimeMs, e.realTimestamp, e.timeSource,
      playerId, e.payload?.player?.name || nameOf(playerId), JSON.stringify(e.payload)];
  });
  return [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

export function downloadFile(name, contents, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([contents], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
