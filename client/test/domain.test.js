import test from "node:test";
import assert from "node:assert/strict";
import { activeTimeline } from "../src/domain/match-event.js";
import { LineupProjector } from "../src/domain/lineup-projector.js";
import { SuggestionEngine } from "../src/domain/suggestion-engine.js";
import { eventPlayerRecord, orderedScorerGroups, playerIdFromName } from "../src/domain/player-label.js";
import { exportEventsCsv, exportMatchJson } from "../src/domain/exporter.js";
import { MatchClock } from "../src/domain/match-clock.js";
import { matchIdsForTeam } from "../src/domain/team.js";
import { displayedGameTime } from "../src/domain/game-time.js";
import { mainMenuMatchStatus, STALE_PAUSE_MS } from "../src/domain/match-status.js";
import { createId } from "../src/domain/id.js";
import { analyzeTeam, MIN_FINISHED_MATCH_MS } from "../src/domain/analytics.js";
import { recentSubstitutionChanges, SUBSTITUTION_HIGHLIGHT_MS } from "../src/domain/substitution-highlight.js";
import { groupLineupStints } from "../src/domain/lineup-stint.js";

const matchId = "match-1";
const roster = ["Alex", "Blair", "Casey"].map((name, index) => ({ playerId: `p${index + 1}`, name, status: "available" }));
const event = (sequence, type, gameTimeMs, payload = {}) => ({ eventId: `e${sequence}`, matchId, sequence, type, gameTimeMs, payload, realTimestamp: "2026-01-01T00:00:00Z", timeSource: "automatic" });
const moved = (sequence, gameTimeMs, ...moves) => event(sequence, "player_moved", gameTimeMs, { moves });
const base = [
  event(1, "match_created", 0, { team: "Home", opponent: "Away", periodCount: 2, periodMinutes: 25, playersOnField: 2, maxStintMinutes: 10, restAlertMinutes: 5, roster }),
  event(2, "starting_lineup_confirmed", 0, { assignments: [{ playerId: "p1", position: "gk" }, { playerId: "p2", position: "forward_striker" }], goalkeeperId: "p1" }),
  event(3, "period_started", 0, { period: 1 })
];

test("creates UUIDs when randomUUID is unavailable on a LAN HTTP origin", () => {
  const first = createId({ getRandomValues: bytes => bytes.fill(0x11) });
  const second = createId({ getRandomValues: bytes => bytes.fill(0x22) });
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test("a match paused for three hours appears over only in the main-menu status", () => {
  const paused = { completed: false, periodRunning: false, currentPeriod: 1 };
  const now = Date.parse("2026-01-01T15:00:00Z");
  assert.equal(mainMenuMatchStatus(paused, new Date(now - STALE_PAUSE_MS + 1).toISOString(), now), "Paused");
  assert.equal(mainMenuMatchStatus(paused, new Date(now - STALE_PAUSE_MS).toISOString(), now), "Over");
  assert.equal(mainMenuMatchStatus({ ...paused, periodRunning: true }, new Date(now - STALE_PAUSE_MS).toISOString(), now), "Running");
});

test("uses the exact trimmed player name as the player ID", () => {
  assert.equal(playerIdFromName("  Alex Morgan  "), "Alex Morgan");
});

test("keeps team jersey numbers out of event player records", () => {
  const record = eventPlayerRecord({ playerId: "Alex Morgan", name: "Alex Morgan", number: "12" });
  assert.deepEqual(record, { playerId: "Alex Morgan", name: "Alex Morgan", status: "available", defaultPositions: [], goalkeeperEligible: true });
  assert.equal("number" in record, false);
});

test("orders goal scorers from forwards through defenders and GK, then off field", () => {
  const groups = orderedScorerGroups(
    { gk: "gk", back_center: "cb", forward_striker: "st", mid_center: "cm" },
    [{ playerId: "bench-1" }, { playerId: "bench-2" }]
  );
  assert.deepEqual(groups.onField, ["st", "cm", "cb", "gk"]);
  assert.deepEqual(groups.offField, ["bench-1", "bench-2"]);
});

test("scorer ordering ignores malformed roster entries", () => {
  assert.deepEqual(orderedScorerGroups({ forward_striker: "st" }, [undefined, null, { playerId: "bench" }]), { onField: ["st"], offField: ["bench"] });
});

test("analysis exports include readable player names beside stable IDs", () => {
  const state = { matchId, config: {}, stints: [], players: { p2: { playerId: "p2", name: "Blair" } } };
  const goal = event(4, "goal_for", 100_000, { playerId: "p2" });
  assert.match(exportEventsCsv([goal], state), /player_name/);
  assert.match(exportEventsCsv([goal], state), /Blair/);
  assert.equal(JSON.parse(exportMatchJson([goal], state)).playerDirectory.p2, "Blair");
});

test("the live clock advances while started and holds while stopped", async () => {
  const ticks = [];
  const clock = new MatchClock({ onTick: elapsedMs => ticks.push(elapsedMs) });
  clock.start();
  await new Promise(resolve => setTimeout(resolve, 280));
  const runningTime = clock.elapsedMs;
  clock.pause();
  const stoppedTime = clock.elapsedMs;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(runningTime >= 200);
  assert.ok(ticks.length >= 1);
  assert.ok(Math.abs(clock.elapsedMs - stoppedTime) < 5);
  clock.destroy();
});

test("displayed game time can move without changing tracking event time", () => {
  const adjustment = event(4, "clock_adjusted", 600_000, { displayTimeMs: 750_000 });
  assert.equal(displayedGameTime([...base, adjustment], 600_000), 750_000);
  assert.equal(displayedGameTime([...base, adjustment], 660_000), 810_000);
  assert.equal(adjustment.gameTimeMs, 600_000);
});

test("team match lists only include matches owned by that team", () => {
  const matches = [
    { ...event(1, "match_created", 0, { teamId: "team-a" }), matchId: "match-a" },
    { ...event(1, "match_created", 0, { teamId: "team-b" }), matchId: "match-b" }
  ];
  assert.deepEqual(matchIdsForTeam(matches, "team-a"), ["match-a"]);
});

test("projects substitutions, player minutes, score, and stints", () => {
  const events = [...base, event(4, "goal_for", 300_000), moved(5, 600_000,
    { playerId: "p2", from: "forward_striker", to: "off_field" },
    { playerId: "p3", from: "off_field", to: "forward_striker" })];
  const state = new LineupProjector().project(events, 900_000);
  assert.equal(state.scoreFor, 1);
  assert.equal(state.players.p1.totalMs, 900_000);
  assert.equal(state.players.p2.totalMs, 600_000);
  assert.equal(state.players.p3.totalMs, 300_000);
  assert.equal(state.field.forward_striker, "p3");
  assert.equal(state.stints.length, 2);
  assert.equal(state.stints[0].goalsFor, 1);
});

test("undo retracts an event without deleting history", () => {
  const goal = event(4, "goal_against", 100_000);
  const undo = event(5, "event_retracted", 110_000, { targetEventId: goal.eventId });
  assert.equal(activeTimeline([...base, goal, undo]).some(item => item.eventId === goal.eventId), false);
  assert.equal(new LineupProjector().project([...base, goal, undo], 200_000).scoreAgainst, 0);
});

test("correction changes event time while preserving its stable identifier", () => {
  const goal = event(4, "goal_for", 100_000);
  const correction = event(5, "event_replaced", 200_000, { targetEventId: goal.eventId, replacement: { type: "goal_for", gameTimeMs: 150_000, payload: {}, timeSource: "manual" } });
  const corrected = activeTimeline([...base, goal, correction]).find(item => item.eventId === goal.eventId);
  assert.equal(corrected.gameTimeMs, 150_000);
  assert.equal(corrected.correctedBy, correction.eventId);
});

test("a timeline correction can change the named goal scorer", () => {
  const goal = event(4, "goal_for", 100_000, { playerId: "p2" });
  const correction = event(5, "event_replaced", 110_000, { targetEventId: goal.eventId, replacement: { type: "goal_for", gameTimeMs: 100_000, payload: { playerId: "p3" }, timeSource: "manual" } });
  const corrected = activeTimeline([...base, goal, correction]).find(item => item.eventId === goal.eventId);
  assert.equal(corrected.payload.playerId, "p3");
});

test("a timeline correction can change the event type", () => {
  const goal = event(4, "goal_for", 100_000, { playerId: "p2" });
  const correction = event(5, "event_replaced", 110_000, { targetEventId: goal.eventId, replacement: { type: "player_moved", gameTimeMs: 100_000, payload: { moves: [{ playerId: "p2", from: "forward_striker", to: "not_here" }] }, timeSource: "manual" } });
  const state = new LineupProjector().project([...base, goal, correction], 150_000);
  assert.equal(state.scoreFor, 0);
  assert.equal(state.unavailable[0].playerId, "p2");
});

test("suggestion explains both continuous play and rest", () => {
  const state = new LineupProjector().project(base, 700_000);
  const suggestion = new SuggestionEngine().suggest(state);
  assert.equal(suggestion.playerOutId, "p2");
  assert.equal(suggestion.playerInId, "p3");
  assert.ok(suggestion.reasons.some(reason => reason.includes("continuously")));
  assert.ok(suggestion.reasons.some(reason => reason.includes("rested")));
});

test("supports dragging a player off and back onto a short field", () => {
  const events = [
    ...base,
    moved(4, 300_000, { playerId: "p2", from: "forward_striker", to: "off_field" }),
    moved(5, 500_000, { playerId: "p3", from: "off_field", to: "forward_striker" })
  ];
  const state = new LineupProjector().project(events, 600_000);
  assert.equal(state.fieldCount, 2);
  assert.equal(state.field.forward_striker, "p3");
  assert.equal(state.players.p2.totalMs, 300_000);
  assert.equal(state.players.p3.totalMs, 100_000);
  assert.equal(state.stints.length, 3);
});

test("recent substitutions identify who moved on and off the field", () => {
  const substitution = moved(4, 120_000,
    { playerId: "p2", from: "forward_striker", to: "off_field" },
    { playerId: "p3", from: "off_field", to: "forward_striker" });
  const movedAt = Date.parse(substitution.realTimestamp);
  const recent = recentSubstitutionChanges([...base, substitution], movedAt + SUBSTITUTION_HIGHLIGHT_MS - 1);
  assert.deepEqual([...recent.on], ["p3"]);
  assert.deepEqual([...recent.off], ["p2"]);
  const expired = recentSubstitutionChanges([...base, substitution], movedAt + SUBSTITUTION_HIGHLIGHT_MS);
  assert.equal(expired.on.size, 0);
  assert.equal(expired.off.size, 0);
});

test("lineup changes within one minute are grouped into one substitution stint", () => {
  const stints = [
    { startMs: 0, endMs: 600_000, durationMs: 600_000, goalsFor: 1, goalsAgainst: 0, field: { gk: "p1", forward_striker: "p2" } },
    { startMs: 600_000, endMs: 620_000, durationMs: 20_000, goalsFor: 0, goalsAgainst: 1, field: { gk: "p1" } },
    { startMs: 620_000, endMs: 900_000, durationMs: 280_000, goalsFor: 2, goalsAgainst: 0, field: { gk: "p1", forward_striker: "p3" } }
  ];
  const grouped = groupLineupStints(stints);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[1], { ...stints[2], startMs: 600_000, durationMs: 300_000, goalsFor: 2, goalsAgainst: 1 });
  assert.equal(stints[2].startMs, 620_000);
});

test("new matches can start with every position blank", () => {
  const blank = [base[0], event(2, "starting_lineup_confirmed", 0, { assignments: [], goalkeeperId: null })];
  const state = new LineupProjector().project(blank, 0);
  assert.equal(state.fieldCount, 0);
  assert.deepEqual(state.bench.map(player => player.playerId), ["p1", "p2", "p3"]);
});

test("a layout change updates the available position slots", () => {
  const changed = event(4, "layout_changed", 0, { name: "1-1", positions: ["forward_striker", "gk"] });
  const state = new LineupProjector().project([...base, changed], 0);
  assert.equal(state.config.layoutName, "1-1");
  assert.deepEqual(state.config.positions, ["forward_striker", "gk"]);
});

test("formation changes split stints and formation outcome analysis", () => {
  const created = { ...base[0], payload: { ...base[0].payload, layoutName: "Opening shape" } };
  const goal = event(4, "goal_for", 300_000);
  const changed = event(5, "layout_changed", 450_000, { name: "Closing shape", positions: ["forward_striker", "gk"] });
  const attempt = event(6, "goal_attempt", 600_000, { team: "for" });
  const completed = event(7, "match_completed", 900_000);
  const matchEvents = [created, ...base.slice(1), goal, changed, attempt, completed];
  const matchState = new LineupProjector().project(matchEvents, 900_000);
  const analysis = analyzeTeam([{ events: matchEvents, state: matchState }]);

  assert.deepEqual(matchState.stints.map(stint => stint.layoutName), ["Opening shape", "Closing shape"]);
  assert.deepEqual(matchState.stints.map(stint => stint.durationMs), [450_000, 450_000]);
  const opening = analysis.formations.find(formation => formation.name === "Opening shape");
  const closing = analysis.formations.find(formation => formation.name === "Closing shape");
  assert.equal(opening.goalsFor, 1);
  assert.equal(opening.completedAppearances, 1);
  assert.ok(opening.smoothedMarginPer60 > 4 && opening.smoothedMarginPer60 < opening.marginPer60);
  assert.equal(closing.attemptsFor, 1);
  assert.equal(closing.completedAppearances, 1);
  assert.ok(closing.smoothedAttemptsForPer60 > 4 && closing.smoothedAttemptsForPer60 < closing.attemptsForPer60);
});

test("a player marked not here disappears from the match bench and can be restored", () => {
  const blank = [
    base[0],
    event(2, "starting_lineup_confirmed", 0, { assignments: [], goalkeeperId: null }),
    moved(3, 0, { playerId: "p2", from: "off_field", to: "not_here" })
  ];
  let state = new LineupProjector().project(blank, 0);
  assert.deepEqual(state.bench.map(player => player.playerId), ["p1", "p3"]);
  assert.deepEqual(state.unavailable.map(player => player.playerId), ["p2"]);
  state = new LineupProjector().project([...blank, moved(4, 0, { playerId: "p2", from: "not_here", to: "off_field" })], 0);
  assert.equal(state.bench.length, 3);
});

test("clear field moves every player to the bench as one undoable event", () => {
  const clear = moved(4, 300_000,
    { playerId: "p1", from: "gk", to: "off_field" },
    { playerId: "p2", from: "forward_striker", to: "off_field" });
  let state = new LineupProjector().project([...base, clear], 300_000);
  assert.equal(state.fieldCount, 0);
  assert.equal(state.bench.length, 3);
  assert.equal(state.goalkeeperId, null);
  const undo = event(5, "event_retracted", 300_000, { targetEventId: clear.eventId });
  state = new LineupProjector().project([...base, clear, undo], 300_000);
  assert.equal(state.fieldCount, 2);
  assert.equal(state.goalkeeperId, "p1");
});

test("moving an on-field player to not here removes them and allows restoration", () => {
  const unavailable = moved(4, 300_000, { playerId: "p2", from: "forward_striker", to: "not_here" });
  let state = new LineupProjector().project([...base, unavailable], 400_000);
  assert.equal(state.fieldCount, 1);
  assert.equal(state.players.p2.totalMs, 300_000);
  assert.deepEqual(state.unavailable.map(player => player.playerId), ["p2"]);
  const available = moved(5, 400_000, { playerId: "p2", from: "not_here", to: "off_field" });
  state = new LineupProjector().project([...base, unavailable, available], 400_000);
  assert.ok(state.bench.some(player => player.playerId === "p2"));
});

test("team goals and assists are separate flat events", () => {
  const scored = event(4, "goal_for", 120_000, { playerId: "p2" });
  const assisted = event(5, "assist_for", 120_000, { playerId: "p1" });
  const noScorer = event(6, "goal_for", 180_000);
  const events = [...base, scored, assisted, noScorer];
  const state = new LineupProjector().project(events, 200_000);
  assert.equal(state.scoreFor, 2);
  const goals = activeTimeline(events).filter(item => item.type === "goal_for");
  assert.equal(goals[0].payload.playerId, "p2");
  assert.equal(activeTimeline(events).find(item => item.type === "assist_for").payload.playerId, "p1");
  assert.deepEqual(goals[1].payload, {});
  assert.equal(state.field.forward_striker, "p2");
});

test("goal attempts for both teams are logged without changing the score", () => {
  const ourAttempt = event(4, "goal_attempt", 120_000, { team: "for" });
  const opponentAttempt = event(5, "goal_attempt", 125_000, { team: "against" });
  const attempts = [ourAttempt, opponentAttempt];
  const state = new LineupProjector().project([...base, ...attempts], 125_000);
  assert.equal(state.scoreFor, 0);
  assert.equal(state.scoreAgainst, 0);
  assert.deepEqual(activeTimeline([...base, ...attempts]).slice(-2).map(item => item.payload.team), ["for", "against"]);
});

test("team analysis unlocks progressively and attributes stint outcomes", () => {
  const completed = event(6, "match_completed", 900_000);
  const attemptFor = event(4, "goal_attempt", 120_000, { team: "for" });
  const goal = event(5, "goal_for", 300_000);
  const matchEvents = [...base, attemptFor, goal, completed];
  const matchState = new LineupProjector().project(matchEvents, 900_000);
  const analysis = analyzeTeam([{ events: matchEvents, state: matchState }]);
  assert.equal(analysis.matches, 1);
  assert.equal(analysis.wins, 1);
  assert.equal(analysis.attemptsFor, 1);
  assert.equal(analysis.attemptsMargin, 1);
  assert.equal(analysis.readiness.playingTime.ready, true);
  assert.equal(analysis.readiness.attempts.ready, true);
  assert.equal(analysis.readiness.fatigue.ready, false);
  assert.equal(analysis.readiness.impact.ready, false);
  assert.equal(analysis.readyCount, 2);
  assert.equal(analysis.outcomeReadyCount, 5);
  assert.equal(analysis.outcomeReportReadyCount, 1);
  assert.equal(analysis.outcomeReportPartialCount, 0);
  assert.equal(analysis.outcomeReadiness.team.attemptsMargin.ready, true);
  assert.equal(analysis.players.find(player => player.playerId === "p2").onFieldMarginPer60, 4);
  const playerPosition = analysis.playerPositions.find(item => item.playerId === "p2");
  assert.equal(playerPosition.marginPer60, 4);
  assert.equal(playerPosition.winRate, 1);
  assert.equal(playerPosition.scoreMargin, 1);
  assert.equal(playerPosition.attemptsForPer60, 4);
  assert.equal(playerPosition.attemptDifferentialPer60, 4);
  const playerLine = analysis.playerLines.find(item => item.playerId === "p2" && item.line === "Forward");
  assert.equal(playerLine.winRate, 1);
  assert.equal(playerLine.attemptsForPer60, 4);
  assert.equal(playerLine.attemptDifferentialPer60, 4);
  assert.equal(analysis.lineups.length, 1);
  assert.equal(analysis.lineups[0].label, "Alex · Blair");
  assert.equal(analysis.lineups[0].winRate, 1);
  assert.equal(analysis.lineups[0].attemptsForPer60, 4);
  assert.equal(analysis.playerTiming.find(player => player.playerId === "p2").buckets[0].marginPer60, 4);
  assert.equal(analysis.playerTiming.find(player => player.playerId === "p2").buckets[0].attemptsForPer60, 4);
  assert.equal(analysis.playerTiming.find(player => player.playerId === "p2").buckets[0].attemptDifferentialPer60, 4);
  assert.equal(analysis.playerTime[0].exposureMs, 30 * 60_000);
  assert.equal(analysis.playerTime[0].goalsFor, 2);
  assert.equal(analysis.playerTime[0].marginPer60, 4);
  const threeMatchAnalysis = analyzeTeam(Array.from({ length: 3 }, () => ({ events: matchEvents, state: matchState })));
  assert.equal(threeMatchAnalysis.readiness.fatigue.ready, true);
  assert.equal(threeMatchAnalysis.readiness.playerTime.ready, false);
  assert.equal(threeMatchAnalysis.readiness.impact.ready, false);
  const fiveMatchAnalysis = analyzeTeam(Array.from({ length: 5 }, () => ({ events: matchEvents, state: matchState })));
  assert.equal(fiveMatchAnalysis.outcomeReadiness.fatigue.win.ready, true);
  assert.equal(fiveMatchAnalysis.outcomeReadiness.playerTime.win.ready, false);
  assert.equal(fiveMatchAnalysis.outcomeReadiness.impact.win.ready, true);

  const frequentAttempts = Array.from({ length: 7 }, (_, index) => event(4 + index, "goal_attempt", 60_000 + index * 60_000, { team: index % 3 ? "for" : "against" }));
  const attemptRichEvents = [...base, ...frequentAttempts, event(11, "match_completed", 900_000)];
  const attemptRichState = new LineupProjector().project(attemptRichEvents, 900_000);
  const attemptRichAnalysis = analyzeTeam(Array.from({ length: 3 }, () => ({ events: attemptRichEvents, state: attemptRichState })));
  assert.equal(attemptRichAnalysis.outcomeReadiness.impact.attemptsFor.ready, true);
  assert.equal(attemptRichAnalysis.outcomeReadiness.impact.win.ready, false);
  assert.equal(attemptRichAnalysis.outcomeReadiness.fatigue.attemptsAgainst.ready, true);
  assert.equal(attemptRichAnalysis.outcomeReadiness.fatigue.attemptsMargin.ready, true);
  assert.equal(attemptRichAnalysis.outcomeReadiness.playerTime.attemptsMargin.ready, false);
});

test("reports only treat stopped matches with a few tracked minutes as finished", () => {
  const shortEvents = [...base, event(4, "goal_for", 60_000), event(5, "clock_paused", MIN_FINISHED_MATCH_MS - 1)];
  const shortState = new LineupProjector().project(shortEvents, MIN_FINISHED_MATCH_MS - 1);
  const shortAnalysis = analyzeTeam([{ events: shortEvents, state: shortState }]);
  assert.equal(shortAnalysis.matches, 1);
  assert.equal(shortAnalysis.completedMatches, 0);
  assert.equal(shortAnalysis.wins, 0);
  assert.equal(shortAnalysis.readiness.playingTime.ready, true);

  const finishedEvents = [...base, event(4, "goal_for", 60_000), event(5, "clock_paused", MIN_FINISHED_MATCH_MS)];
  const finishedState = new LineupProjector().project(finishedEvents, MIN_FINISHED_MATCH_MS);
  const finishedAnalysis = analyzeTeam([{ events: finishedEvents, state: finishedState }]);
  assert.equal(finishedAnalysis.completedMatches, 1);
  assert.equal(finishedAnalysis.wins, 1);

  const resumedEvents = [...finishedEvents, event(6, "clock_resumed", MIN_FINISHED_MATCH_MS)];
  const resumedState = new LineupProjector().project(resumedEvents, MIN_FINISHED_MATCH_MS + 60_000);
  const resumedAnalysis = analyzeTeam([{ events: resumedEvents, state: resumedState }]);
  assert.equal(resumedAnalysis.completedMatches, 0);
});

test("playing-time analysis supports per-game averages and season totals", () => {
  const firstState = new LineupProjector().project(base, 15 * 60_000);
  const secondState = new LineupProjector().project(base, 10 * 60_000);
  const analysis = analyzeTeam([{ events: base, state: firstState }, { events: base, state: secondState }]);
  const player = analysis.players.find(item => item.playerId === "p2");

  assert.equal(player.appearances, 2);
  assert.equal(player.averageMinutes, 12.5);
  assert.equal(player.seasonMinutes, 25);
});

test("time-on-field outcomes use each player's accumulated minutes instead of the match clock", () => {
  const substitute = moved(4, 20 * 60_000,
    { playerId: "p2", from: "forward_striker", to: "off_field" },
    { playerId: "p3", from: "off_field", to: "forward_striker" });
  const goal = event(5, "goal_for", 25 * 60_000);
  const completed = event(6, "match_completed", 40 * 60_000);
  const matchEvents = [...base, substitute, goal, completed];
  const matchState = new LineupProjector().project(matchEvents, 40 * 60_000);
  const analysis = analyzeTeam([{ events: matchEvents, state: matchState }]);
  const substituteTiming = analysis.playerTiming.find(player => player.playerId === "p3");

  assert.deepEqual(substituteTiming.buckets.map(bucket => bucket.label), ["First 15 on field", "Next 15 on field", "After 30 on field"]);
  assert.equal(substituteTiming.buckets[0].exposureMs, 15 * 60_000);
  assert.equal(substituteTiming.buckets[1].exposureMs, 5 * 60_000);
  assert.equal(substituteTiming.buckets[0].goalsFor, 1);
  assert.equal(substituteTiming.buckets[1].goalsFor, 0);
  assert.equal(substituteTiming.buckets[0].marginPer60, 4);
});

test("deleting a goal recalculates the score while deleting an assist does not", () => {
  const goal = event(4, "goal_for", 120_000, { playerId: "p2" });
  const assist = event(5, "assist_for", 120_000, { playerId: "p1" });
  const assistDeleted = event(6, "event_retracted", 130_000, { targetEventId: assist.eventId });
  assert.equal(new LineupProjector().project([...base, goal, assist, assistDeleted], 150_000).scoreFor, 1);
  const goalDeleted = event(7, "event_retracted", 140_000, { targetEventId: goal.eventId });
  assert.equal(new LineupProjector().project([...base, goal, assist, assistDeleted, goalDeleted], 150_000).scoreFor, 0);
});

test("players can be added during a match and become available off field", () => {
  const emptyConfig = event(1, "match_created", 0, { team: "Home", opponent: "Away", periodCount: 2, periodMinutes: 25, playersOnField: 5, maxStintMinutes: 10, restAlertMinutes: 5, roster: [] });
  const emptyLineup = event(2, "starting_lineup_confirmed", 0, { assignments: [], goalkeeperId: null });
  const player = { playerId: "new-player", name: "Taylor", status: "available", defaultPositions: [], goalkeeperEligible: true };
  const added = event(3, "player_added", 100_000, { player });
  const state = new LineupProjector().project([emptyConfig, emptyLineup, added], 200_000);
  assert.equal(state.config.roster.length, 1);
  assert.equal(state.bench[0].playerId, "new-player");
  assert.equal(state.players["new-player"].benchMs, 100_000);
});

test("deleting a player removes them from the active roster but keeps recorded stats", () => {
  const removed = event(4, "player_removed", 100_000, { playerId: "p1" });
  const state = new LineupProjector().project([...base, removed], 200_000);
  assert.equal(state.config.roster.some(player => player.playerId === "p1"), false);
  assert.equal(state.field.gk, undefined);
  assert.equal(state.goalkeeperId, null);
  assert.equal(state.players.p1.removed, true);
  assert.equal(state.players.p1.totalMs, 100_000);
});

test("re-adding the same name restores the same player identity and continues history", () => {
  const removed = event(4, "player_removed", 100_000, { playerId: "p2" });
  const restoredPlayer = { playerId: "p2", name: "Blair", status: "available", defaultPositions: [], goalkeeperEligible: true };
  const readded = event(5, "player_added", 150_000, { player: restoredPlayer });
  const entered = moved(6, 200_000, { playerId: "p2", from: "off_field", to: "forward_striker" });
  const state = new LineupProjector().project([...base, removed, readded, entered], 300_000);
  assert.equal(state.players.p2.removed, false);
  assert.equal(state.players.p2.totalMs, 200_000);
  assert.equal(state.field.forward_striker, "p2");
});

test("a malformed legacy player event cannot prevent recording a goal", () => {
  const malformed = event(4, "player_added", 100_000, {});
  const goal = event(5, "goal_for", 120_000, { scorerId: null });
  const state = new LineupProjector().project([...base, malformed, goal], 150_000);
  assert.equal(state.scoreFor, 1);
  assert.ok(state.errors.some(error => error.includes("Invalid player added")));
});

test("the goalkeeper assignment follows the dedicated keeper position", () => {
  let state = new LineupProjector().project([...base, moved(4, 100_000,
    { playerId: "p1", from: "gk", to: "forward_striker" },
    { playerId: "p2", from: "forward_striker", to: "gk" })], 100_000);
  assert.equal(state.field.gk, "p2");
  assert.equal(state.goalkeeperId, "p2");
  state = new LineupProjector().project([...base, moved(4, 100_000, { playerId: "p1", from: "gk", to: "back_left_fullback" })], 100_000);
  assert.equal(state.goalkeeperId, null);
  assert.equal(state.field.gk, undefined);
});
