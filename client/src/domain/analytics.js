import { activeTimeline } from "./match-event.js";
import { groupLineupStints } from "./lineup-stint.js";

export const REPORT_THRESHOLDS = Object.freeze({
  playingTime: { matches: 1 },
  impact: { completedMatches: 5, attemptMatches: 3, attemptEvents: 20 },
  fatigue: { completedMatches: 3, attemptMatches: 2, attemptEvents: 10 },
  playerTime: { completedMatches: 8, supportedPlayers: 3, minMinutes: 90, attemptMatches: 5, attemptEvents: 45, attemptMinMinutes: 60 },
  formations: { completedMatches: 3, goals: 3, supportedFactors: 2, minMinutes: 45, attemptMatches: 2, attemptEvents: 10, attemptMinMinutes: 30 },
  lines: { completedMatches: 6, goals: 7, supportedFactors: 3, minMinutes: 90, attemptMatches: 4, attemptEvents: 30, attemptMinMinutes: 60 },
  positions: { completedMatches: 8, goals: 10, supportedFactors: 3, minMinutes: 90, attemptMatches: 5, attemptEvents: 45, attemptMinMinutes: 60 },
  attempts: { matches: 1, events: 1, resultMatches: 5, resultAttemptMatches: 3 }
});

const percent = (...values) => Math.round(Math.min(1, ...values) * 100);
const report = (ready, progress, needs) => ({ ready, progress, needs });
const firstReady = (results, attempts) => report(
  results.ready || attempts.ready,
  Math.max(results.progress, attempts.progress),
  attempts.progress >= results.progress ? attempts.needs : results.needs
);
const emptyPlayer = (playerId, name) => ({
  playerId, name, minutesMs: 0, appearances: 0, completedAppearances: 0,
  wins: 0, draws: 0, losses: 0, finalMargin: 0,
  onFieldGoalsFor: 0, onFieldGoalsAgainst: 0,
  attemptsFor: 0, attemptsAgainst: 0
});
const emptyPosition = position => ({ position, minutesMs: 0, goalsFor: 0, goalsAgainst: 0, attemptsFor: 0, attemptsAgainst: 0 });
const emptyPlayerPosition = (playerId, name, position) => ({
  playerId, name, position, minutesMs: 0, goalsFor: 0, goalsAgainst: 0, attemptsFor: 0, attemptsAgainst: 0,
  completedAppearances: 0, wins: 0, finalMargin: 0
});
const lineupKey = field => [...new Set(Object.values(field))].filter(Boolean).sort().join("\u0000");
const emptyLineup = (key, playerIds, players) => ({
  key, playerIds, names: playerIds.map(playerId => players[playerId]?.name || playerId), minutesMs: 0,
  goalsFor: 0, goalsAgainst: 0, attemptsFor: 0, attemptsAgainst: 0,
  completedAppearances: 0, wins: 0, finalMargin: 0
});
const emptyFormation = name => ({
  name, minutesMs: 0, goalsFor: 0, goalsAgainst: 0, attemptsFor: 0, attemptsAgainst: 0,
  completedAppearances: 0, wins: 0, finalMargin: 0
});
const positionRank = position => position === "gk" ? "Keeper" : position.startsWith("forward_") ? "Forward" : position.startsWith("mid_") ? "Midfield" : "Defense";
const PLAYER_TIME_BUCKETS = Object.freeze([
  { key: "opening", label: "First 15 on field", startMs: 0, endMs: 15 * 60_000 },
  { key: "middle", label: "Next 15 on field", startMs: 15 * 60_000, endMs: 30 * 60_000 },
  { key: "late", label: "After 30 on field", startMs: 30 * 60_000, endMs: Infinity }
]);
const bucketOverlap = (startMs, endMs, bucket) => Math.max(0, Math.min(endMs, bucket.endMs) - Math.max(startMs, bucket.startMs));
const playerTimeBucketIndex = (intervals, eventTimeMs) => {
  const interval = intervals.find(item => eventTimeMs >= item.startMs && eventTimeMs <= item.endMs);
  if (!interval) return -1;
  const accumulatedMs = interval.fieldStartMs + Math.max(0, Math.min(eventTimeMs, interval.endMs) - interval.startMs);
  return PLAYER_TIME_BUCKETS.findIndex(bucket => accumulatedMs >= bucket.startMs && accumulatedMs < bucket.endMs);
};

export function analyzeTeam(matchRecords) {
  const recorded = matchRecords.filter(({ state }) => state?.config && (state.elapsedMs > 0 || state.completed));
  const completed = recorded.filter(({ state, isFinal }) => state.completed || isFinal);
  const playerMap = new Map();
  const positionMap = new Map();
  const lineupMap = new Map();
  const formationMap = new Map();
  const playerLineMap = new Map();
  const playerPositionMap = new Map();
  const playerTimingMap = new Map();
  let goalsFor = 0;
  let goalsAgainst = 0;
  let attemptsFor = 0;
  let attemptsAgainst = 0;
  let attemptMatches = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let exposureMs = 0;
  const timing = [
    { key: "opening", label: "First 15 min", startMs: 0, endMs: 15 * 60_000, exposureMs: 0, goalsFor: 0, goalsAgainst: 0, attemptsFor: 0, attemptsAgainst: 0, completedMatches: 0, wins: 0, finalMargin: 0 },
    { key: "middle", label: "15-30 min", startMs: 15 * 60_000, endMs: 30 * 60_000, exposureMs: 0, goalsFor: 0, goalsAgainst: 0, attemptsFor: 0, attemptsAgainst: 0, completedMatches: 0, wins: 0, finalMargin: 0 },
    { key: "late", label: "After 30 min", startMs: 30 * 60_000, endMs: Infinity, exposureMs: 0, goalsFor: 0, goalsAgainst: 0, attemptsFor: 0, attemptsAgainst: 0, completedMatches: 0, wins: 0, finalMargin: 0 }
  ];

  for (const { state, events, isFinal } of recorded) {
    const finalMatch = state.completed || isFinal;
    const timeline = activeTimeline(events);
    const attempts = timeline.filter(event => event.type === "goal_attempt");
    const lineupStints = groupLineupStints(state.stints);
    const playerFieldIntervals = new Map();
    const playerElapsedMs = new Map();
    exposureMs += state.elapsedMs;
    for (const bucket of timing) {
      bucket.exposureMs += Math.max(0, Math.min(state.elapsedMs, bucket.endMs) - bucket.startMs);
      bucket.goalsFor += timeline.filter(event => event.type === "goal_for" && event.gameTimeMs >= bucket.startMs && event.gameTimeMs < bucket.endMs).length;
      bucket.goalsAgainst += timeline.filter(event => event.type === "goal_against" && event.gameTimeMs >= bucket.startMs && event.gameTimeMs < bucket.endMs).length;
    }
    const matchAttemptsFor = attempts.filter(event => event.payload?.team !== "against").length;
    const matchAttemptsAgainst = attempts.length - matchAttemptsFor;
    attemptsFor += matchAttemptsFor;
    attemptsAgainst += matchAttemptsAgainst;
    if (attempts.length) attemptMatches += 1;
    goalsFor += state.scoreFor;
    goalsAgainst += state.scoreAgainst;
    if (finalMatch) {
      if (state.scoreFor > state.scoreAgainst) wins += 1;
      else if (state.scoreFor < state.scoreAgainst) losses += 1;
      else draws += 1;
      for (const bucket of timing) {
        if (state.elapsedMs <= bucket.startMs) continue;
        bucket.completedMatches += 1;
        bucket.finalMargin += state.scoreFor - state.scoreAgainst;
        if (state.scoreFor > state.scoreAgainst) bucket.wins += 1;
      }
    }

    for (const player of Object.values(state.players)) {
      if (!player?.playerId) continue;
      const row = playerMap.get(player.playerId) || emptyPlayer(player.playerId, player.name);
      row.name = player.name;
      row.minutesMs += player.totalMs;
      if (player.totalMs > 0) {
        row.appearances += 1;
        if (finalMatch) {
          row.completedAppearances += 1;
          row.finalMargin += state.scoreFor - state.scoreAgainst;
          if (state.scoreFor > state.scoreAgainst) row.wins += 1;
          else if (state.scoreFor < state.scoreAgainst) row.losses += 1;
          else row.draws += 1;
        }
      }
      playerMap.set(player.playerId, row);
    }

    for (const stint of lineupStints) {
      const key = lineupKey(stint.field);
      if (key) {
        const playerIds = key.split("\u0000");
        const lineup = lineupMap.get(key) || emptyLineup(key, playerIds, state.players);
        lineup.minutesMs += stint.durationMs;
        lineup.goalsFor += stint.goalsFor;
        lineup.goalsAgainst += stint.goalsAgainst;
        lineupMap.set(key, lineup);
      }
      const formationName = stint.layoutName || state.config.layoutName || "Custom";
      const formation = formationMap.get(formationName) || emptyFormation(formationName);
      formation.minutesMs += stint.durationMs;
      formation.goalsFor += stint.goalsFor;
      formation.goalsAgainst += stint.goalsAgainst;
      formationMap.set(formationName, formation);
      for (const [position, playerId] of Object.entries(stint.field)) {
        const player = state.players[playerId];
        if (!player) continue;
        const row = playerMap.get(playerId) || emptyPlayer(playerId, player.name);
        row.onFieldGoalsFor += stint.goalsFor;
        row.onFieldGoalsAgainst += stint.goalsAgainst;
        playerMap.set(playerId, row);
        const positionRow = positionMap.get(position) || emptyPosition(position);
        positionRow.minutesMs += stint.durationMs;
        positionRow.goalsFor += stint.goalsFor;
        positionRow.goalsAgainst += stint.goalsAgainst;
        positionMap.set(position, positionRow);
        const playerPositionKey = `${playerId}\u0000${position}`;
        const playerPosition = playerPositionMap.get(playerPositionKey) || emptyPlayerPosition(playerId, player.name, position);
        playerPosition.minutesMs += stint.durationMs;
        playerPosition.goalsFor += stint.goalsFor;
        playerPosition.goalsAgainst += stint.goalsAgainst;
        playerPositionMap.set(playerPositionKey, playerPosition);
        const line = positionRank(position);
        const playerLineKey = `${playerId}\u0000${line}`;
        const playerLine = playerLineMap.get(playerLineKey) || { ...emptyPlayerPosition(playerId, player.name, position), line };
        playerLine.minutesMs += stint.durationMs;
        playerLine.goalsFor += stint.goalsFor;
        playerLine.goalsAgainst += stint.goalsAgainst;
        playerLineMap.set(playerLineKey, playerLine);
        const playerTiming = playerTimingMap.get(playerId) || {
          playerId, name: player.name,
          buckets: PLAYER_TIME_BUCKETS.map(bucket => ({ key: bucket.key, label: bucket.label, exposureMs: 0, goalsFor: 0, goalsAgainst: 0, attemptsFor: 0, attemptsAgainst: 0, completedAppearances: 0, wins: 0, finalMargin: 0 }))
        };
        const fieldStartMs = playerElapsedMs.get(playerId) || 0;
        const fieldEndMs = fieldStartMs + stint.durationMs;
        PLAYER_TIME_BUCKETS.forEach((bucket, index) => {
          playerTiming.buckets[index].exposureMs += bucketOverlap(fieldStartMs, fieldEndMs, bucket);
        });
        const intervals = playerFieldIntervals.get(playerId) || [];
        intervals.push({ startMs: stint.startMs, endMs: stint.endMs, fieldStartMs });
        playerFieldIntervals.set(playerId, intervals);
        playerElapsedMs.set(playerId, fieldEndMs);
        playerTimingMap.set(playerId, playerTiming);
      }
    }

    if (finalMatch) {
      const matchLineups = new Map();
      const matchFormations = new Set();
      for (const stint of lineupStints) {
        const key = lineupKey(stint.field);
        if (key && stint.durationMs > 0) matchLineups.set(key, key.split("\u0000"));
        if (stint.durationMs > 0) matchFormations.add(stint.layoutName || state.config.layoutName || "Custom");
      }
      for (const [key, playerIds] of matchLineups) {
        const lineup = lineupMap.get(key) || emptyLineup(key, playerIds, state.players);
        lineup.completedAppearances += 1;
        lineup.finalMargin += state.scoreFor - state.scoreAgainst;
        if (state.scoreFor > state.scoreAgainst) lineup.wins += 1;
        lineupMap.set(key, lineup);
      }
      for (const formationName of matchFormations) {
        const formation = formationMap.get(formationName) || emptyFormation(formationName);
        formation.completedAppearances += 1;
        formation.finalMargin += state.scoreFor - state.scoreAgainst;
        if (state.scoreFor > state.scoreAgainst) formation.wins += 1;
        formationMap.set(formationName, formation);
      }
      for (const player of Object.values(state.players)) {
        const matchLines = new Set();
        for (const [position, positionMs] of Object.entries(player.positionMs || {})) {
          if (positionMs <= 0) continue;
          const playerPositionKey = `${player.playerId}\u0000${position}`;
          const playerPosition = playerPositionMap.get(playerPositionKey) || emptyPlayerPosition(player.playerId, player.name, position);
          playerPosition.completedAppearances += 1;
          playerPosition.finalMargin += state.scoreFor - state.scoreAgainst;
          if (state.scoreFor > state.scoreAgainst) playerPosition.wins += 1;
          playerPositionMap.set(playerPositionKey, playerPosition);
          matchLines.add(positionRank(position));
        }
        for (const line of matchLines) {
          const playerLineKey = `${player.playerId}\u0000${line}`;
          const playerLine = playerLineMap.get(playerLineKey) || { ...emptyPlayerPosition(player.playerId, player.name, ""), line };
          playerLine.completedAppearances += 1;
          playerLine.finalMargin += state.scoreFor - state.scoreAgainst;
          if (state.scoreFor > state.scoreAgainst) playerLine.wins += 1;
          playerLineMap.set(playerLineKey, playerLine);
        }
        const playerTiming = playerTimingMap.get(player.playerId);
        if (playerTiming) PLAYER_TIME_BUCKETS.forEach((bucket, index) => {
          const matchExposureMs = (playerFieldIntervals.get(player.playerId) || []).reduce((sum, interval) => {
            const fieldEndMs = interval.fieldStartMs + interval.endMs - interval.startMs;
            return sum + bucketOverlap(interval.fieldStartMs, fieldEndMs, bucket);
          }, 0);
          if (!matchExposureMs) return;
          playerTiming.buckets[index].completedAppearances += 1;
          playerTiming.buckets[index].finalMargin += state.scoreFor - state.scoreAgainst;
          if (state.scoreFor > state.scoreAgainst) playerTiming.buckets[index].wins += 1;
        });
      }
    }

    for (const goal of timeline.filter(event => event.type === "goal_for" || event.type === "goal_against")) {
      const stint = lineupStints.find(item => goal.gameTimeMs >= item.startMs && goal.gameTimeMs <= item.endMs);
      if (!stint) continue;
      for (const playerId of Object.values(stint.field)) {
        const playerTiming = playerTimingMap.get(playerId);
        const bucketIndex = playerTimeBucketIndex(playerFieldIntervals.get(playerId) || [], goal.gameTimeMs);
        if (playerTiming && bucketIndex >= 0) playerTiming.buckets[bucketIndex][goal.type === "goal_for" ? "goalsFor" : "goalsAgainst"] += 1;
      }
    }

    for (const attempt of attempts) {
      const stint = lineupStints.find(item => attempt.gameTimeMs >= item.startMs && attempt.gameTimeMs <= item.endMs);
      const bucketIndex = timing.findIndex(bucket => attempt.gameTimeMs >= bucket.startMs && attempt.gameTimeMs < bucket.endMs);
      if (!stint || bucketIndex < 0) continue;
      const key = attempt.payload?.team === "against" ? "attemptsAgainst" : "attemptsFor";
      timing[bucketIndex][key] += 1;
      const formationName = stint.layoutName || state.config.layoutName || "Custom";
      const formation = formationMap.get(formationName) || emptyFormation(formationName);
      formation[key] += 1;
      formationMap.set(formationName, formation);
      const activeLineupKey = lineupKey(stint.field);
      if (activeLineupKey) {
        const playerIds = activeLineupKey.split("\u0000");
        const lineup = lineupMap.get(activeLineupKey) || emptyLineup(activeLineupKey, playerIds, state.players);
        lineup[key] += 1;
        lineupMap.set(activeLineupKey, lineup);
      }
      for (const [position, playerId] of Object.entries(stint.field)) {
        const player = state.players[playerId];
        if (player) {
          const row = playerMap.get(playerId) || emptyPlayer(playerId, player.name);
          row[key] += 1;
          playerMap.set(playerId, row);
        }
        const positionRow = positionMap.get(position) || emptyPosition(position);
        positionRow[key] += 1;
        positionMap.set(position, positionRow);
        if (player) {
          const playerPositionKey = `${playerId}\u0000${position}`;
          const playerPosition = playerPositionMap.get(playerPositionKey) || emptyPlayerPosition(playerId, player.name, position);
          playerPosition[key] += 1;
          playerPositionMap.set(playerPositionKey, playerPosition);
          const line = positionRank(position);
          const playerLineKey = `${playerId}\u0000${line}`;
          const playerLine = playerLineMap.get(playerLineKey) || { ...emptyPlayerPosition(playerId, player.name, position), line };
          playerLine[key] += 1;
          playerLineMap.set(playerLineKey, playerLine);
          const playerTiming = playerTimingMap.get(playerId);
          const playerBucketIndex = playerTimeBucketIndex(playerFieldIntervals.get(playerId) || [], attempt.gameTimeMs);
          if (playerTiming && playerBucketIndex >= 0) playerTiming.buckets[playerBucketIndex][key] += 1;
        }
      }
    }
  }

  const players = [...playerMap.values()].filter(player => player.minutesMs > 0).map(player => ({
    ...player,
    seasonMinutes: player.minutesMs / 60_000,
    averageMinutes: player.appearances ? player.minutesMs / player.appearances / 60_000 : 0,
    winRate: player.completedAppearances ? player.wins / player.completedAppearances : 0,
    scoreMargin: player.completedAppearances ? player.finalMargin / player.completedAppearances : 0,
    onFieldMarginPer60: player.minutesMs ? (player.onFieldGoalsFor - player.onFieldGoalsAgainst) * 3_600_000 / player.minutesMs : 0,
    attemptsForPer60: player.minutesMs ? player.attemptsFor * 3_600_000 / player.minutesMs : 0,
    attemptsAgainstPer60: player.minutesMs ? player.attemptsAgainst * 3_600_000 / player.minutesMs : 0,
    attemptDifferentialPer60: player.minutesMs ? (player.attemptsFor - player.attemptsAgainst) * 3_600_000 / player.minutesMs : 0
  })).sort((a, b) => b.minutesMs - a.minutesMs);

  const positions = [...positionMap.values()].map(item => ({
    ...item,
    marginPer60: item.minutesMs ? (item.goalsFor - item.goalsAgainst) * 3_600_000 / item.minutesMs : 0,
    attemptDifferentialPer60: item.minutesMs ? (item.attemptsFor - item.attemptsAgainst) * 3_600_000 / item.minutesMs : 0
  })).sort((a, b) => b.minutesMs - a.minutesMs);
  const lineups = [...lineupMap.values()].filter(item => item.minutesMs > 0).map(item => ({
    ...item,
    label: item.names.length > 3 ? `${item.names.slice(0, 3).join(" · ")} +${item.names.length - 3}` : item.names.join(" · "),
    winRate: item.completedAppearances ? item.wins / item.completedAppearances : 0,
    scoreMargin: item.completedAppearances ? item.finalMargin / item.completedAppearances : 0,
    marginPer60: item.minutesMs ? (item.goalsFor - item.goalsAgainst) * 3_600_000 / item.minutesMs : 0,
    attemptsForPer60: item.minutesMs ? item.attemptsFor * 3_600_000 / item.minutesMs : 0,
    attemptsAgainstPer60: item.minutesMs ? item.attemptsAgainst * 3_600_000 / item.minutesMs : 0,
    attemptDifferentialPer60: item.minutesMs ? (item.attemptsFor - item.attemptsAgainst) * 3_600_000 / item.minutesMs : 0
  })).sort((a, b) => b.minutesMs - a.minutesMs);
  const goalPriorMs = 120 * 60_000;
  const attemptPriorMs = 60 * 60_000;
  const winPriorAppearances = 4;
  const teamGoalsForPerMs = exposureMs ? goalsFor / exposureMs : 0;
  const teamGoalsAgainstPerMs = exposureMs ? goalsAgainst / exposureMs : 0;
  const teamAttemptsForPerMs = exposureMs ? attemptsFor / exposureMs : 0;
  const teamAttemptsAgainstPerMs = exposureMs ? attemptsAgainst / exposureMs : 0;
  const teamWinRate = completed.length ? wins / completed.length : 0;
  const formations = [...formationMap.values()].filter(item => item.minutesMs > 0).map(item => {
    const smoothedGoalsForPer60 = (item.goalsFor + teamGoalsForPerMs * goalPriorMs) * 3_600_000 / (item.minutesMs + goalPriorMs);
    const smoothedGoalsAgainstPer60 = (item.goalsAgainst + teamGoalsAgainstPerMs * goalPriorMs) * 3_600_000 / (item.minutesMs + goalPriorMs);
    const smoothedAttemptsForPer60 = (item.attemptsFor + teamAttemptsForPerMs * attemptPriorMs) * 3_600_000 / (item.minutesMs + attemptPriorMs);
    const smoothedAttemptsAgainstPer60 = (item.attemptsAgainst + teamAttemptsAgainstPerMs * attemptPriorMs) * 3_600_000 / (item.minutesMs + attemptPriorMs);
    return {
      ...item,
      winRate: item.completedAppearances ? item.wins / item.completedAppearances : 0,
      scoreMargin: item.completedAppearances ? item.finalMargin / item.completedAppearances : 0,
      marginPer60: item.minutesMs ? (item.goalsFor - item.goalsAgainst) * 3_600_000 / item.minutesMs : 0,
      attemptsForPer60: item.minutesMs ? item.attemptsFor * 3_600_000 / item.minutesMs : 0,
      attemptsAgainstPer60: item.minutesMs ? item.attemptsAgainst * 3_600_000 / item.minutesMs : 0,
      attemptDifferentialPer60: item.minutesMs ? (item.attemptsFor - item.attemptsAgainst) * 3_600_000 / item.minutesMs : 0,
      smoothedWinRate: (item.wins + teamWinRate * winPriorAppearances) / (item.completedAppearances + winPriorAppearances),
      smoothedGoalsForPer60,
      smoothedGoalsAgainstPer60,
      smoothedMarginPer60: smoothedGoalsForPer60 - smoothedGoalsAgainstPer60,
      smoothedAttemptsForPer60,
      smoothedAttemptsAgainstPer60,
      smoothedAttemptDifferentialPer60: smoothedAttemptsForPer60 - smoothedAttemptsAgainstPer60
    };
  }).sort((a, b) => b.minutesMs - a.minutesMs);
  const playerPositions = [...playerPositionMap.values()].map(item => ({
    ...item,
    winRate: item.completedAppearances ? item.wins / item.completedAppearances : 0,
    scoreMargin: item.completedAppearances ? item.finalMargin / item.completedAppearances : 0,
    marginPer60: item.minutesMs ? (item.goalsFor - item.goalsAgainst) * 3_600_000 / item.minutesMs : 0,
    attemptsForPer60: item.minutesMs ? item.attemptsFor * 3_600_000 / item.minutesMs : 0,
    attemptsAgainstPer60: item.minutesMs ? item.attemptsAgainst * 3_600_000 / item.minutesMs : 0,
    attemptDifferentialPer60: item.minutesMs ? (item.attemptsFor - item.attemptsAgainst) * 3_600_000 / item.minutesMs : 0
  })).sort((a, b) => b.minutesMs - a.minutesMs);
  const playerLines = [...playerLineMap.values()].map(item => ({
    ...item,
    winRate: item.completedAppearances ? item.wins / item.completedAppearances : 0,
    scoreMargin: item.completedAppearances ? item.finalMargin / item.completedAppearances : 0,
    attemptsForPer60: item.minutesMs ? item.attemptsFor * 3_600_000 / item.minutesMs : 0,
    attemptsAgainstPer60: item.minutesMs ? item.attemptsAgainst * 3_600_000 / item.minutesMs : 0,
    attemptDifferentialPer60: item.minutesMs ? (item.attemptsFor - item.attemptsAgainst) * 3_600_000 / item.minutesMs : 0
  })).sort((a, b) => b.minutesMs - a.minutesMs);

  const goalEvents = goalsFor + goalsAgainst;
  const attemptEvents = attemptsFor + attemptsAgainst;
  const supportedPlayerPositions = playerPositions.filter(item => item.minutesMs >= REPORT_THRESHOLDS.positions.minMinutes * 60_000).length;
  const supportedPlayerLines = playerLines.filter(item => item.minutesMs >= REPORT_THRESHOLDS.lines.minMinutes * 60_000).length;
  const supportedFormations = formations.filter(item => item.minutesMs >= REPORT_THRESHOLDS.formations.minMinutes * 60_000).length;
  const attemptSupportedPlayerPositions = playerPositions.filter(item => item.minutesMs >= REPORT_THRESHOLDS.positions.attemptMinMinutes * 60_000).length;
  const attemptSupportedPlayerLines = playerLines.filter(item => item.minutesMs >= REPORT_THRESHOLDS.lines.attemptMinMinutes * 60_000).length;
  const attemptSupportedFormations = formations.filter(item => item.minutesMs >= REPORT_THRESHOLDS.formations.attemptMinMinutes * 60_000).length;
  const timingRates = timing.map(bucket => ({
    key: bucket.key, label: bucket.label, exposureMs: bucket.exposureMs,
    winRate: bucket.completedMatches ? bucket.wins / bucket.completedMatches : 0,
    scoreMargin: bucket.completedMatches ? bucket.finalMargin / bucket.completedMatches : 0,
    marginPer60: bucket.exposureMs ? (bucket.goalsFor - bucket.goalsAgainst) * 3_600_000 / bucket.exposureMs : 0,
    attemptsForPer60: bucket.exposureMs ? bucket.attemptsFor * 3_600_000 / bucket.exposureMs : 0,
    attemptsAgainstPer60: bucket.exposureMs ? bucket.attemptsAgainst * 3_600_000 / bucket.exposureMs : 0,
    attemptDifferentialPer60: bucket.exposureMs ? (bucket.attemptsFor - bucket.attemptsAgainst) * 3_600_000 / bucket.exposureMs : 0
  }));
  const playerTiming = [...playerTimingMap.values()].map(player => ({
    ...player,
    totalMs: player.buckets.reduce((sum, bucket) => sum + bucket.exposureMs, 0),
    buckets: player.buckets.map(bucket => ({
      ...bucket,
      winRate: bucket.completedAppearances ? bucket.wins / bucket.completedAppearances : 0,
      scoreMargin: bucket.completedAppearances ? bucket.finalMargin / bucket.completedAppearances : 0,
      marginPer60: bucket.exposureMs ? (bucket.goalsFor - bucket.goalsAgainst) * 3_600_000 / bucket.exposureMs : 0,
      attemptsForPer60: bucket.exposureMs ? bucket.attemptsFor * 3_600_000 / bucket.exposureMs : 0,
      attemptsAgainstPer60: bucket.exposureMs ? bucket.attemptsAgainst * 3_600_000 / bucket.exposureMs : 0,
      attemptDifferentialPer60: bucket.exposureMs ? (bucket.attemptsFor - bucket.attemptsAgainst) * 3_600_000 / bucket.exposureMs : 0
    }))
  })).sort((a, b) => b.totalMs - a.totalMs);
  const playerTime = PLAYER_TIME_BUCKETS.map((bucket, index) => {
    const totals = playerTiming.reduce((summary, player) => {
      const playerBucket = player.buckets[index];
      summary.exposureMs += playerBucket.exposureMs;
      summary.goalsFor += playerBucket.goalsFor;
      summary.goalsAgainst += playerBucket.goalsAgainst;
      summary.attemptsFor += playerBucket.attemptsFor;
      summary.attemptsAgainst += playerBucket.attemptsAgainst;
      summary.completedAppearances += playerBucket.completedAppearances;
      summary.wins += playerBucket.wins;
      summary.finalMargin += playerBucket.finalMargin;
      return summary;
    }, { exposureMs: 0, goalsFor: 0, goalsAgainst: 0, attemptsFor: 0, attemptsAgainst: 0, completedAppearances: 0, wins: 0, finalMargin: 0 });
    return {
      ...bucket, ...totals,
      winRate: totals.completedAppearances ? totals.wins / totals.completedAppearances : 0,
      scoreMargin: totals.completedAppearances ? totals.finalMargin / totals.completedAppearances : 0,
      marginPer60: totals.exposureMs ? (totals.goalsFor - totals.goalsAgainst) * 3_600_000 / totals.exposureMs : 0,
      attemptsForPer60: totals.exposureMs ? totals.attemptsFor * 3_600_000 / totals.exposureMs : 0,
      attemptsAgainstPer60: totals.exposureMs ? totals.attemptsAgainst * 3_600_000 / totals.exposureMs : 0,
      attemptDifferentialPer60: totals.exposureMs ? (totals.attemptsFor - totals.attemptsAgainst) * 3_600_000 / totals.exposureMs : 0
    };
  });
  const rawAttemptReadiness = report(
    attemptMatches >= REPORT_THRESHOLDS.attempts.matches && attemptEvents >= REPORT_THRESHOLDS.attempts.events,
    percent(attemptMatches / REPORT_THRESHOLDS.attempts.matches, attemptEvents / REPORT_THRESHOLDS.attempts.events),
    `${Math.max(0, REPORT_THRESHOLDS.attempts.matches - attemptMatches)} more matches with attempts and ${Math.max(0, REPORT_THRESHOLDS.attempts.events - attemptEvents)} more attempts`
  );
  const teamResultReadiness = report(
    completed.length >= 1,
    percent(completed.length),
    `${Math.max(0, 1 - completed.length)} more completed matches`
  );
  const resultAttemptReadiness = report(
    completed.length >= REPORT_THRESHOLDS.attempts.resultMatches && attemptMatches >= REPORT_THRESHOLDS.attempts.resultAttemptMatches,
    percent(completed.length / REPORT_THRESHOLDS.attempts.resultMatches, attemptMatches / REPORT_THRESHOLDS.attempts.resultAttemptMatches),
    `${Math.max(0, REPORT_THRESHOLDS.attempts.resultMatches - completed.length)} more completed matches and ${Math.max(0, REPORT_THRESHOLDS.attempts.resultAttemptMatches - attemptMatches)} more matches with attempts`
  );
  const resultImpactReadiness = report(
    completed.length >= REPORT_THRESHOLDS.impact.completedMatches,
    percent(completed.length / REPORT_THRESHOLDS.impact.completedMatches),
    `${Math.max(0, REPORT_THRESHOLDS.impact.completedMatches - completed.length)} more completed matches`
  );
  const attemptImpactReadiness = report(
    attemptMatches >= REPORT_THRESHOLDS.impact.attemptMatches && attemptEvents >= REPORT_THRESHOLDS.impact.attemptEvents,
    percent(attemptMatches / REPORT_THRESHOLDS.impact.attemptMatches, attemptEvents / REPORT_THRESHOLDS.impact.attemptEvents),
    `${Math.max(0, REPORT_THRESHOLDS.impact.attemptMatches - attemptMatches)} more matches with attempts and ${Math.max(0, REPORT_THRESHOLDS.impact.attemptEvents - attemptEvents)} more attempts`
  );
  const resultTimingReadiness = report(
    completed.length >= REPORT_THRESHOLDS.fatigue.completedMatches,
    percent(completed.length / REPORT_THRESHOLDS.fatigue.completedMatches),
    `${Math.max(0, REPORT_THRESHOLDS.fatigue.completedMatches - completed.length)} more completed matches`
  );
  const attemptTimingReadiness = report(
    attemptMatches >= REPORT_THRESHOLDS.fatigue.attemptMatches && attemptEvents >= REPORT_THRESHOLDS.fatigue.attemptEvents,
    percent(attemptMatches / REPORT_THRESHOLDS.fatigue.attemptMatches, attemptEvents / REPORT_THRESHOLDS.fatigue.attemptEvents),
    `${Math.max(0, REPORT_THRESHOLDS.fatigue.attemptMatches - attemptMatches)} more matches with attempts and ${Math.max(0, REPORT_THRESHOLDS.fatigue.attemptEvents - attemptEvents)} more attempts`
  );
  const supportedPlayerTimes = playerTiming.filter(player => player.totalMs >= REPORT_THRESHOLDS.playerTime.minMinutes * 60_000).length;
  const attemptSupportedPlayerTimes = playerTiming.filter(player => player.totalMs >= REPORT_THRESHOLDS.playerTime.attemptMinMinutes * 60_000).length;
  const resultPlayerTimeReadiness = report(
    completed.length >= REPORT_THRESHOLDS.playerTime.completedMatches && supportedPlayerTimes >= REPORT_THRESHOLDS.playerTime.supportedPlayers,
    percent(completed.length / REPORT_THRESHOLDS.playerTime.completedMatches, supportedPlayerTimes / REPORT_THRESHOLDS.playerTime.supportedPlayers),
    `${Math.max(0, REPORT_THRESHOLDS.playerTime.completedMatches - completed.length)} more completed matches and ${Math.max(0, REPORT_THRESHOLDS.playerTime.supportedPlayers - supportedPlayerTimes)} more 90-minute player samples`
  );
  const attemptPlayerTimeReadiness = report(
    attemptMatches >= REPORT_THRESHOLDS.playerTime.attemptMatches && attemptEvents >= REPORT_THRESHOLDS.playerTime.attemptEvents && attemptSupportedPlayerTimes >= REPORT_THRESHOLDS.playerTime.supportedPlayers,
    percent(attemptMatches / REPORT_THRESHOLDS.playerTime.attemptMatches, attemptEvents / REPORT_THRESHOLDS.playerTime.attemptEvents, attemptSupportedPlayerTimes / REPORT_THRESHOLDS.playerTime.supportedPlayers),
    `${Math.max(0, REPORT_THRESHOLDS.playerTime.attemptMatches - attemptMatches)} more matches with attempts, ${Math.max(0, REPORT_THRESHOLDS.playerTime.attemptEvents - attemptEvents)} more attempts, and ${Math.max(0, REPORT_THRESHOLDS.playerTime.supportedPlayers - attemptSupportedPlayerTimes)} more 60-minute player samples`
  );
  const resultFormationReadiness = report(
    completed.length >= REPORT_THRESHOLDS.formations.completedMatches && goalEvents >= REPORT_THRESHOLDS.formations.goals && supportedFormations >= REPORT_THRESHOLDS.formations.supportedFactors,
    percent(completed.length / REPORT_THRESHOLDS.formations.completedMatches, goalEvents / REPORT_THRESHOLDS.formations.goals, supportedFormations / REPORT_THRESHOLDS.formations.supportedFactors),
    `${Math.max(0, REPORT_THRESHOLDS.formations.completedMatches - completed.length)} more completed matches, ${Math.max(0, REPORT_THRESHOLDS.formations.goals - goalEvents)} more goals, and ${Math.max(0, REPORT_THRESHOLDS.formations.supportedFactors - supportedFormations)} more ${REPORT_THRESHOLDS.formations.minMinutes}-minute formation samples`
  );
  const attemptFormationReadiness = report(
    attemptMatches >= REPORT_THRESHOLDS.formations.attemptMatches && attemptEvents >= REPORT_THRESHOLDS.formations.attemptEvents && attemptSupportedFormations >= REPORT_THRESHOLDS.formations.supportedFactors,
    percent(attemptMatches / REPORT_THRESHOLDS.formations.attemptMatches, attemptEvents / REPORT_THRESHOLDS.formations.attemptEvents, attemptSupportedFormations / REPORT_THRESHOLDS.formations.supportedFactors),
    `${Math.max(0, REPORT_THRESHOLDS.formations.attemptMatches - attemptMatches)} more matches with attempts, ${Math.max(0, REPORT_THRESHOLDS.formations.attemptEvents - attemptEvents)} more attempts, and ${Math.max(0, REPORT_THRESHOLDS.formations.supportedFactors - attemptSupportedFormations)} more ${REPORT_THRESHOLDS.formations.attemptMinMinutes}-minute formation samples`
  );
  const resultLineReadiness = report(
    completed.length >= REPORT_THRESHOLDS.lines.completedMatches && goalEvents >= REPORT_THRESHOLDS.lines.goals && supportedPlayerLines >= REPORT_THRESHOLDS.lines.supportedFactors,
    percent(completed.length / REPORT_THRESHOLDS.lines.completedMatches, goalEvents / REPORT_THRESHOLDS.lines.goals, supportedPlayerLines / REPORT_THRESHOLDS.lines.supportedFactors),
    `${Math.max(0, REPORT_THRESHOLDS.lines.completedMatches - completed.length)} more completed matches, ${Math.max(0, REPORT_THRESHOLDS.lines.goals - goalEvents)} more goals, and ${Math.max(0, REPORT_THRESHOLDS.lines.supportedFactors - supportedPlayerLines)} more 90-minute player-rank samples`
  );
  const attemptLineReadiness = report(
    attemptMatches >= REPORT_THRESHOLDS.lines.attemptMatches && attemptEvents >= REPORT_THRESHOLDS.lines.attemptEvents && attemptSupportedPlayerLines >= REPORT_THRESHOLDS.lines.supportedFactors,
    percent(attemptMatches / REPORT_THRESHOLDS.lines.attemptMatches, attemptEvents / REPORT_THRESHOLDS.lines.attemptEvents, attemptSupportedPlayerLines / REPORT_THRESHOLDS.lines.supportedFactors),
    `${Math.max(0, REPORT_THRESHOLDS.lines.attemptMatches - attemptMatches)} more matches with attempts, ${Math.max(0, REPORT_THRESHOLDS.lines.attemptEvents - attemptEvents)} more attempts, and ${Math.max(0, REPORT_THRESHOLDS.lines.supportedFactors - attemptSupportedPlayerLines)} more 60-minute player-rank samples`
  );
  const resultPositionReadiness = report(
    completed.length >= REPORT_THRESHOLDS.positions.completedMatches && goalEvents >= REPORT_THRESHOLDS.positions.goals && supportedPlayerPositions >= REPORT_THRESHOLDS.positions.supportedFactors,
    percent(completed.length / REPORT_THRESHOLDS.positions.completedMatches, goalEvents / REPORT_THRESHOLDS.positions.goals, supportedPlayerPositions / REPORT_THRESHOLDS.positions.supportedFactors),
    `${Math.max(0, REPORT_THRESHOLDS.positions.completedMatches - completed.length)} more completed matches, ${Math.max(0, REPORT_THRESHOLDS.positions.goals - goalEvents)} more goals, and ${Math.max(0, REPORT_THRESHOLDS.positions.supportedFactors - supportedPlayerPositions)} more 90-minute player-position samples`
  );
  const attemptPositionReadiness = report(
    attemptMatches >= REPORT_THRESHOLDS.positions.attemptMatches && attemptEvents >= REPORT_THRESHOLDS.positions.attemptEvents && attemptSupportedPlayerPositions >= REPORT_THRESHOLDS.positions.supportedFactors,
    percent(attemptMatches / REPORT_THRESHOLDS.positions.attemptMatches, attemptEvents / REPORT_THRESHOLDS.positions.attemptEvents, attemptSupportedPlayerPositions / REPORT_THRESHOLDS.positions.supportedFactors),
    `${Math.max(0, REPORT_THRESHOLDS.positions.attemptMatches - attemptMatches)} more matches with attempts, ${Math.max(0, REPORT_THRESHOLDS.positions.attemptEvents - attemptEvents)} more attempts, and ${Math.max(0, REPORT_THRESHOLDS.positions.supportedFactors - attemptSupportedPlayerPositions)} more 60-minute player-position samples`
  );
  const playingTimeResultReadiness = report(
    completed.length >= REPORT_THRESHOLDS.impact.completedMatches,
    percent(completed.length / REPORT_THRESHOLDS.impact.completedMatches),
    `${Math.max(0, REPORT_THRESHOLDS.impact.completedMatches - completed.length)} more completed matches`
  );
  const outcomeReadiness = {
    team: { win: teamResultReadiness, margin: teamResultReadiness, attemptsFor: rawAttemptReadiness, attemptsAgainst: rawAttemptReadiness, attemptsMargin: rawAttemptReadiness },
    playingTime: { win: playingTimeResultReadiness, margin: playingTimeResultReadiness, attemptsFor: rawAttemptReadiness, attemptsAgainst: rawAttemptReadiness, attemptsMargin: rawAttemptReadiness },
    attempts: { win: resultAttemptReadiness, margin: resultAttemptReadiness, attemptsFor: rawAttemptReadiness, attemptsAgainst: rawAttemptReadiness, attemptsMargin: rawAttemptReadiness },
    impact: { win: resultImpactReadiness, margin: resultImpactReadiness, attemptsFor: attemptImpactReadiness, attemptsAgainst: attemptImpactReadiness, attemptsMargin: attemptImpactReadiness },
    formations: { win: resultFormationReadiness, margin: resultFormationReadiness, attemptsFor: attemptFormationReadiness, attemptsAgainst: attemptFormationReadiness, attemptsMargin: attemptFormationReadiness },
    fatigue: { win: resultTimingReadiness, margin: resultTimingReadiness, attemptsFor: attemptTimingReadiness, attemptsAgainst: attemptTimingReadiness, attemptsMargin: attemptTimingReadiness },
    playerTime: { win: resultPlayerTimeReadiness, margin: resultPlayerTimeReadiness, attemptsFor: attemptPlayerTimeReadiness, attemptsAgainst: attemptPlayerTimeReadiness, attemptsMargin: attemptPlayerTimeReadiness },
    lines: { win: resultLineReadiness, margin: resultLineReadiness, attemptsFor: attemptLineReadiness, attemptsAgainst: attemptLineReadiness, attemptsMargin: attemptLineReadiness },
    positions: { win: resultPositionReadiness, margin: resultPositionReadiness, attemptsFor: attemptPositionReadiness, attemptsAgainst: attemptPositionReadiness, attemptsMargin: attemptPositionReadiness }
  };
  const readiness = {
    playingTime: report(recorded.length >= REPORT_THRESHOLDS.playingTime.matches && players.length > 0, percent(recorded.length / REPORT_THRESHOLDS.playingTime.matches, players.length ? 1 : 0), players.length ? "Record one match" : "Record on-field player time"),
    attempts: firstReady(resultAttemptReadiness, rawAttemptReadiness),
    impact: firstReady(resultImpactReadiness, attemptImpactReadiness),
    formations: firstReady(resultFormationReadiness, attemptFormationReadiness),
    fatigue: firstReady(resultTimingReadiness, attemptTimingReadiness),
    playerTime: firstReady(resultPlayerTimeReadiness, attemptPlayerTimeReadiness),
    lines: firstReady(resultLineReadiness, attemptLineReadiness),
    positions: firstReady(resultPositionReadiness, attemptPositionReadiness)
  };
  const outcomeBreakdownKeys = ["team", "formations", "impact", "lines", "fatigue", "playerTime", "positions"];
  const outcomeMetrics = ["win", "margin", "attemptsFor", "attemptsAgainst", "attemptsMargin"];
  const outcomeReadyCount = outcomeBreakdownKeys.flatMap(key => Object.values(outcomeReadiness[key])).filter(item => item.ready).length;
  const outcomeReportReadyCount = outcomeBreakdownKeys.filter(key => outcomeMetrics.every(metric => outcomeReadiness[key][metric].ready)).length;
  const outcomeReportPartialCount = outcomeBreakdownKeys.filter(key => outcomeMetrics.some(metric => outcomeReadiness[key][metric].ready) && !outcomeMetrics.every(metric => outcomeReadiness[key][metric].ready)).length;

  return {
    matches: recorded.length, completedMatches: completed.length, exposureMs, goalsFor, goalsAgainst,
    wins, draws, losses, winRate: completed.length ? wins / completed.length : 0,
    scoreMargin: goalsFor - goalsAgainst, attemptsFor, attemptsAgainst, attemptsMargin: attemptsFor - attemptsAgainst, attemptMatches,
    players, positions, lineups, formations, playerLines, playerPositions, timing: timingRates, playerTime, playerTiming, readiness, outcomeReadiness, outcomeReadyCount, outcomeReportReadyCount, outcomeReportPartialCount,
    readyCount: Object.values(readiness).filter(item => item.ready).length
  };
}
