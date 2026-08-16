import { activeTimeline } from "./match-event.js";

const emptyPlayerStats = (player, atMs = 0) => ({
  playerId: player.playerId, name: player.name, totalMs: 0, currentStintMs: 0,
  benchMs: 0, positionMs: {}, goalkeeperMs: 0, lastEnteredAt: null, lastExitedAt: atMs
});

export class LineupProjector {
  project(events, throughTimeMs) {
    const timeline = activeTimeline(events);
    const created = timeline.find(event => event.type === "match_created");
    if (!created) return this.empty();
    const config = structuredClone(created.payload);
    config.roster = Array.isArray(config.roster) ? config.roster.filter(player => player?.playerId && player?.name) : [];
    const players = Object.fromEntries(config.roster.map(player => [player.playerId, emptyPlayerStats(player)]));
    const state = {
      matchId: created.matchId, config, players, field: {}, goalkeeperId: null,
      scoreFor: 0, scoreAgainst: 0, currentPeriod: 0, periodRunning: false,
      completed: false, notes: [], stints: [], timeline, errors: []
    };
    let cursor = 0;
    let stintStart = 0;
    let stintGoalsFor = 0;
    let stintGoalsAgainst = 0;
    const limit = Number.isFinite(throughTimeMs)
      ? throughTimeMs
      : Math.max(0, ...timeline.map(event => event.gameTimeMs));

    const closeInterval = end => {
      const safeEnd = Math.max(cursor, Math.min(end, limit));
      const duration = safeEnd - cursor;
      if (duration <= 0) return;
      for (const player of Object.values(players)) if (!player.removed) player.benchMs += duration;
      for (const [position, playerId] of Object.entries(state.field)) {
        const stats = players[playerId];
        if (!stats) continue;
        stats.totalMs += duration;
        stats.benchMs -= duration;
        stats.positionMs[position] = (stats.positionMs[position] || 0) + duration;
        if (playerId === state.goalkeeperId) stats.goalkeeperMs += duration;
      }
      cursor = safeEnd;
    };
    const closeStint = end => {
      if (end > stintStart && Object.keys(state.field).length) {
        state.stints.push({ startMs: stintStart, endMs: end, durationMs: end - stintStart,
          goalsFor: stintGoalsFor, goalsAgainst: stintGoalsAgainst,
          field: structuredClone(state.field), goalkeeperId: state.goalkeeperId });
      }
      stintStart = end;
      stintGoalsFor = 0;
      stintGoalsAgainst = 0;
    };

    for (const event of timeline) {
      if (event.gameTimeMs > limit) break;
      closeInterval(event.gameTimeMs);
      const p = event.payload || {};
      switch (event.type) {
        case "starting_lineup_confirmed":
          state.field = Object.fromEntries((Array.isArray(p.assignments) ? p.assignments : []).filter(assignment => assignment?.position && players[assignment?.playerId]).map(a => [a.position, a.playerId]));
          state.goalkeeperId = players[p.goalkeeperId] ? p.goalkeeperId : null;
          for (const id of Object.values(state.field)) if (players[id]) players[id].lastEnteredAt = event.gameTimeMs;
          stintStart = event.gameTimeMs;
          break;
        case "period_started": state.currentPeriod = p.period; state.periodRunning = true; break;
        case "clock_resumed": state.periodRunning = true; break;
        case "clock_paused": state.periodRunning = false; break;
        case "period_ended": state.periodRunning = false; break;
        case "layout_changed":
          if (Array.isArray(p.positions) && p.positions.length === config.playersOnField) {
            config.positions = structuredClone(p.positions);
            config.layoutName = p.name || "Custom";
          }
          break;
        case "player_added": {
          if (!p.player?.playerId || !p.player?.name) { state.errors.push(`Invalid player added at ${event.gameTimeMs}`); break; }
          const player = structuredClone(p.player);
          if (!config.roster.some(item => item.playerId === player.playerId)) config.roster.push(player);
          if (!players[player.playerId]) players[player.playerId] = emptyPlayerStats(player, event.gameTimeMs);
          else {
            players[player.playerId].removed = false;
            players[player.playerId].name = player.name;
          }
          break;
        }
        case "player_removed": {
          const position = Object.keys(state.field).find(pos => state.field[pos] === p.playerId);
          if (position) {
            closeStint(event.gameTimeMs);
            delete state.field[position];
            players[p.playerId].lastExitedAt = event.gameTimeMs;
            if (state.goalkeeperId === p.playerId) state.goalkeeperId = null;
          }
          config.roster = config.roster.filter(player => player.playerId !== p.playerId);
          if (players[p.playerId]) players[p.playerId].removed = true;
          break;
        }
        case "player_moved": {
          const moves = Array.isArray(p.moves) ? p.moves : [];
          const movingIds = new Set(moves.map(move => move.playerId));
          const destinations = moves.map(move => move.to).filter(to => !["off_field", "not_here"].includes(to));
          const invalid = !moves.length || movingIds.size !== moves.length || new Set(destinations).size !== destinations.length
            || moves.some(move => !move.playerId || !move.to || !players[move.playerId] || !config.roster.some(player => player.playerId === move.playerId))
            || destinations.some(to => state.field[to] && !movingIds.has(state.field[to]));
          if (invalid) {
            state.errors.push(`Invalid player move at ${event.gameTimeMs}`); break;
          }
          const origins = new Map(moves.map(move => [move.playerId, Object.keys(state.field).find(pos => state.field[pos] === move.playerId)]));
          if (moves.some(move => origins.get(move.playerId) || !["off_field", "not_here"].includes(move.to))) closeStint(event.gameTimeMs);
          for (const origin of origins.values()) if (origin) delete state.field[origin];
          for (const move of moves) {
            const player = config.roster.find(item => item.playerId === move.playerId);
            const origin = origins.get(move.playerId);
            const wasUnavailable = player.status !== "available";
            if (move.to === "not_here") {
              player.status = "unavailable";
              if (origin) players[move.playerId].lastExitedAt = event.gameTimeMs;
            } else {
              player.status = "available";
              if (move.to === "off_field") {
                if (origin || wasUnavailable) players[move.playerId].lastExitedAt = event.gameTimeMs;
              } else {
                state.field[move.to] = move.playerId;
                if (!origin) players[move.playerId].lastEnteredAt = event.gameTimeMs;
              }
            }
          }
          state.goalkeeperId = state.field.gk || null;
          break;
        }
        case "goal_for": state.scoreFor += 1; stintGoalsFor += 1; break;
        case "goal_against": state.scoreAgainst += 1; stintGoalsAgainst += 1; break;
        case "note_added": state.notes.push(event); break;
        case "match_completed": state.completed = true; state.periodRunning = false; break;
      }
      if (Object.keys(state.field).length > config.playersOnField) state.errors.push("Too many players on the field.");
    }
    closeInterval(limit);
    closeStint(limit);
    for (const [position, playerId] of Object.entries(state.field)) {
      const stats = players[playerId];
      if (!stats) { delete state.field[position]; continue; }
      stats.currentStintMs = Math.max(0, limit - (stats.lastEnteredAt ?? limit));
      stats.currentPosition = position;
    }
    state.elapsedMs = limit;
    state.fieldCount = Object.keys(state.field).length;
    state.bench = config.roster.filter(player => player.status === "available" && !Object.values(state.field).includes(player.playerId));
    state.unavailable = config.roster.filter(player => player.status !== "available");
    return state;
  }

  empty() { return { config: null, players: {}, field: {}, bench: [], timeline: [], stints: [], errors: [] }; }
}
