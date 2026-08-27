import { createId } from "./id.js";

const PLAYERS = ["Alex", "Blair", "Casey", "Drew", "Erin", "Frankie", "Morgan", "Taylor"];
const POSITIONS = ["forward_striker", "mid_center", "back_left_fullback", "back_right_fullback", "gk"];
const SAMPLE_CONFIGS = Object.freeze({
  early: { name: "Sample · Early season", matches: 2, attemptsPerPhase: 2, variation: 1, description: "Two matches with early attempt data and limited position comparisons." },
  positions: { name: "Sample · Position comparison", matches: 5, attemptsPerPhase: 4, variation: 2, description: "Five matches with broad-role rotation and clearer attacking and defensive patterns." },
  full: { name: "Sample · Eight-game season", matches: 8, attemptsPerPhase: 6, variation: 3, description: "Eight varied matches with enough attempts to explore deeper report states." }
});

const player = name => ({ playerId: name, name, status: "available", defaultPositions: [], goalkeeperEligible: true });

export function sampleDataOptions() {
  return Object.entries(SAMPLE_CONFIGS).map(([key, value]) => ({ key, ...value }));
}

export function createSampleDataset(kind = "early", nameSuffix = "") {
  const sample = SAMPLE_CONFIGS[kind] || SAMPLE_CONFIGS.early;
  const teamId = createId();
  const roster = PLAYERS.map(player);
  const team = { teamId, name: `${sample.name}${nameSuffix}`, players: roster };
  const events = [];
  for (let matchIndex = 0; matchIndex < sample.matches; matchIndex += 1) {
    events.push(...sampleMatchEvents(team, roster, sample, matchIndex));
  }
  return { team, events, description: sample.description };
}

function sampleMatchEvents(team, roster, sample, matchIndex) {
  const matchId = createId();
  const date = new Date(Date.UTC(2026, 7, 2 + matchIndex * 7)).toISOString().slice(0, 10);
  const baseTimestamp = Date.parse(`${date}T17:00:00Z`);
  const events = [];
  let sequence = 0;
  const add = (type, gameTimeMs, payload = {}) => {
    sequence += 1;
    events.push({
      eventId: `${matchId}-${sequence}`, matchId, sequence, type, gameTimeMs, payload,
      realTimestamp: new Date(baseTimestamp + sequence * 1000).toISOString(), timeSource: "automatic"
    });
  };
  const rotating = ["Alex", "Blair", "Casey", "Drew", "Erin", "Frankie"];
  const shift = matchIndex % rotating.length;
  const ordered = [...rotating.slice(shift), ...rotating.slice(0, shift)];
  const keeper = sample.variation > 1 && matchIndex % 2 ? "Taylor" : "Morgan";
  const assignments = [
    { playerId: ordered[0], position: "forward_striker" },
    { playerId: ordered[1], position: "mid_center" },
    { playerId: ordered[2], position: "back_left_fullback" },
    { playerId: ordered[3], position: "back_right_fullback" },
    { playerId: keeper, position: "gk" }
  ];
  add("match_created", 0, {
    teamId: team.teamId, team: team.name, opponent: `Sample Opponent ${matchIndex + 1}`, date,
    competition: "Sample season", opponentStrength: matchIndex % 3 === 0 ? "Strong" : "Similar",
    periodCount: 2, periodMinutes: 20, playersOnField: 5, maxStintMinutes: 12, restAlertMinutes: 8,
    roster, expectedComplete: true, clockMode: "count_up", layoutName: "2-1-1", positions: POSITIONS
  });
  add("starting_lineup_confirmed", 0, { assignments, goalkeeperId: keeper });
  add("period_started", 0, { period: 1 });

  const field = Object.fromEntries(assignments.map(item => [item.position, item.playerId]));
  addPhaseEvents(add, field, matchIndex, 2 * 60_000, 13 * 60_000, sample.attemptsPerPhase);

  if (sample.variation >= 1) {
    const forward = field.forward_striker;
    const midfielder = field.mid_center;
    add("player_moved", 14 * 60_000, { moves: [
      { playerId: forward, from: "forward_striker", to: "mid_center" },
      { playerId: midfielder, from: "mid_center", to: "forward_striker" }
    ] });
    field.forward_striker = midfielder;
    field.mid_center = forward;
  }
  addPhaseEvents(add, field, matchIndex + 1, 15 * 60_000, 27 * 60_000, sample.attemptsPerPhase);

  if (sample.variation >= 2) {
    const outgoing = field.back_right_fullback;
    const benchPlayer = ordered.find(name => !Object.values(field).includes(name));
    add("player_moved", 28 * 60_000, { moves: [
      { playerId: outgoing, from: "back_right_fullback", to: "off_field" },
      { playerId: benchPlayer, from: "off_field", to: "back_right_fullback" }
    ] });
    field.back_right_fullback = benchPlayer;
  }
  if (sample.variation >= 3 && matchIndex % 2 === 1) {
    const oldKeeper = field.gk;
    const newKeeper = oldKeeper === "Morgan" ? "Taylor" : "Morgan";
    add("player_moved", 30 * 60_000, { moves: [
      { playerId: oldKeeper, from: "gk", to: "off_field" },
      { playerId: newKeeper, from: "off_field", to: "gk" }
    ] });
    field.gk = newKeeper;
  }
  addPhaseEvents(add, field, matchIndex + 2, 31 * 60_000, 39 * 60_000, sample.attemptsPerPhase);
  add("clock_paused", 40 * 60_000, {});
  return events;
}

function addPhaseEvents(add, field, seed, startMs, endMs, density) {
  const forBoost = field.forward_striker === "Alex" ? 2 : field.mid_center === "Casey" ? 1 : 0;
  const defenseBoost = [field.back_left_fullback, field.back_right_fullback].includes("Blair") ? 1 : 0;
  const keeperBoost = field.gk === "Taylor" ? 1 : 0;
  const attemptsFor = Math.max(1, density + forBoost + (seed % 2));
  const attemptsAgainst = Math.max(1, density + (seed % 3 === 0 ? 1 : 0) - defenseBoost - keeperBoost);
  const total = attemptsFor + attemptsAgainst;
  for (let index = 0; index < total; index += 1) {
    const gameTimeMs = Math.round(startMs + (index + 1) * (endMs - startMs) / (total + 1));
    add("goal_attempt", gameTimeMs, { team: index < attemptsFor ? "for" : "against", playerId: null });
  }
  if ((seed + attemptsFor) % 3 !== 0) add("goal_for", Math.min(endMs - 10_000, startMs + 5 * 60_000), { scorerId: null });
  if ((seed + attemptsAgainst) % 4 === 0) add("goal_against", Math.min(endMs - 5_000, startMs + 8 * 60_000), {});
}
