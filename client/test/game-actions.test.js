import test from "node:test";
import assert from "node:assert/strict";
import { LineupProjector } from "../src/domain/lineup-projector.js";
import { MatchEvent, activeTimeline } from "../src/domain/match-event.js";
import { displayedGameTime } from "../src/domain/game-time.js";
import { stageMoves, validPendingMoves, validateMoves, periodStartPayload, normalizedPlayerName } from "../src/domain/game-actions.js";
import { analyzeTeam } from "../src/domain/analytics.js";

const projector = new LineupProjector();
const event = (sequence, type, gameTimeMs, payload = {}) => MatchEvent.create("game", type, gameTimeMs, payload, sequence).toJSON();
const roster = Array.from({ length: 8 }, (_, i) => ({ playerId: `p${i + 1}`, name: `Player ${i + 1}`, status: "available" }));
const base = [
  event(1, "match_created", 0, { playersOnField: 3, periodCount: 2, periodMinutes: 45, roster }),
  event(2, "starting_lineup_confirmed", 0, { assignments: [{ playerId: "p1", position: "gk" }, { playerId: "p2", position: "mid_center" }, { playerId: "p3", position: "forward_striker" }], goalkeeperId: "p1" }),
  event(3, "period_started", 0, { period: 1 })
];
const swap = (incoming, outgoing, position) => [{ playerId: outgoing, from: position, to: "off_field" }, { playerId: incoming, from: "off_field", to: position }];

test("drafts do not affect minutes or events; confirmation applies multiple swaps at one instant", () => {
  const atDraft = projector.project(base, 300_000);
  let pending = stageMoves([], swap("p4", "p2", "mid_center"), atDraft);
  pending = stageMoves(pending, swap("p5", "p3", "forward_striker"), atDraft);
  const before = projector.project(base, 600_000);
  assert.equal(before.players.p2.totalMs, 600_000);
  assert.equal(before.players.p4.totalMs, 0);
  assert.equal(before.timeline.length, 3);
  const confirmation = event(4, "player_moved", 600_000, { moves: pending.flat() });
  const after = projector.project([...base, confirmation], 900_000);
  assert.equal(after.field.mid_center, "p4");
  assert.equal(after.field.forward_striker, "p5");
  assert.equal(after.players.p2.totalMs, 600_000);
  assert.equal(after.players.p3.totalMs, 600_000);
  assert.equal(after.players.p4.totalMs, 300_000);
  assert.equal(after.players.p5.totalMs, 300_000);
  assert.equal(after.players.p4.lastEnteredAt, after.players.p5.lastEnteredAt);
  assert.equal(after.stints.length, 2);
  assert.deepEqual(after.errors, []);
});

test("changing a pending player or destination replaces conflicting drafts, preserving unrelated swaps", () => {
  const state = projector.project(base, 100_000);
  let pending = stageMoves([], swap("p4", "p2", "mid_center"), state);
  pending = stageMoves(pending, swap("p5", "p3", "forward_striker"), state);
  pending = stageMoves(pending, swap("p6", "p2", "mid_center"), state);
  assert.equal(pending.length, 2);
  assert.ok(!pending.flat().some(move => move.playerId === "p4"));
  pending = stageMoves(pending, swap("p5", "p2", "mid_center"), state);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0], swap("p5", "p2", "mid_center"));
  assert.throws(() => validateMoves(state, [...pending[0], ...pending[0]]), /only be used once/);
  const changed = projector.project([...base, event(4, "player_moved", 120_000, { moves: swap("p7", "p2", "mid_center") })], 120_000);
  assert.deepEqual(validPendingMoves(pending, changed), []);
});

test("selecting the same pending substitution again removes it", () => {
  const state = projector.project(base, 100_000);
  const first = swap("p4", "p2", "mid_center");
  const second = swap("p5", "p3", "forward_striker");
  let pending = stageMoves([], first, state);
  pending = stageMoves(pending, second, state);
  pending = stageMoves(pending, first, state);
  assert.deepEqual(pending, [second]);
});

test("two extra players accrue normal minutes and rest; moving them does not split their playing time", () => {
  const first = event(4, "player_moved", 100_000, { moves: [{ playerId: "p4", from: "off_field", to: "extra_1" }] });
  const second = event(5, "player_moved", 200_000, { moves: [{ playerId: "p5", from: "off_field", to: "extra_2" }] });
  const positioned = event(6, "extra_positioned", 300_000, { position: "extra_1", x: 30, y: 65 });
  const state = projector.project([...base, first, second, positioned], 600_000);
  assert.equal(state.fieldCount, 5);
  assert.equal(state.players.p4.totalMs, 500_000);
  assert.equal(state.players.p4.benchMs, 100_000);
  assert.equal(state.players.p5.totalMs, 400_000);
  assert.deepEqual(state.config.extraLocations.extra_1, { x: 30, y: 65 });
  assert.deepEqual(state.errors, []);
  assert.throws(() => validateMoves(state, [{ playerId: "p6", from: "off_field", to: "extra_3" }]), /two extra/);
  const replace = event(7, "player_moved", 600_000, { moves: swap("p6", "p4", "extra_1") });
  const leave = event(8, "player_moved", 700_000, { moves: [{ playerId: "p5", from: "extra_2", to: "off_field" }] });
  const final = projector.project([...base, first, second, positioned, replace, leave], 800_000);
  assert.equal(final.fieldCount, 4);
  assert.equal(final.players.p4.totalMs, 500_000);
  assert.equal(final.players.p4.benchMs, 300_000);
  assert.equal(final.players.p5.totalMs, 500_000);
  assert.equal(final.players.p5.benchMs, 300_000);
  assert.equal(final.players.p6.totalMs, 200_000);
  const analysis = analyzeTeam([{ events: [...base, first, second], state }]);
  assert.ok(analysis.playerLines.some(row => row.playerId === "p4" && row.line === "Unassigned"));
});

test("renaming preserves IDs, scorer references, accumulated durations and saved replay", () => {
  assert.throws(() => normalizedPlayerName("  \t "), /Enter a player name/);
  const name = normalizedPlayerName("  New Name  ");
  const goal = event(4, "goal_for", 100_000, { playerId: "p2" });
  const renamed = event(5, "player_renamed", 200_000, { playerId: "p2", name });
  const saved = JSON.parse(JSON.stringify([...base, goal, renamed]));
  const state = projector.project(saved, 500_000);
  assert.equal(state.players.p2.name, "New Name");
  assert.equal(state.config.roster.find(player => player.playerId === "p2").name, "New Name");
  assert.equal(state.field.mid_center, "p2");
  assert.equal(state.players.p2.totalMs, 500_000);
  assert.equal(state.scoreFor, 1);
  assert.equal(state.timeline.find(item => item.type === "goal_for").payload.playerId, "p2");
});

for (const trackingTime of [40 * 60_000, 50 * 60_000]) {
  test(`halftime display sync at tracking minute ${trackingTime / 60_000} preserves all time and timeline invariants`, () => {
    const settings = event(4, "match_settings_changed", 0, { syncHalfClock: true, stageSubstitutions: true, periodMinutes: 45 });
    const paused = event(5, "clock_paused", trackingTime);
    const before = [...base, settings, paused];
    const state = projector.project(before, trackingTime);
    const transition = event(6, "period_started", trackingTime, periodStartPayload(state.config, 2, false));
    const after = [...before, transition];
    const second = projector.project(after, trackingTime);
    assert.equal(displayedGameTime(after, trackingTime), 45 * 60_000);
    assert.deepEqual(second.players, state.players);
    assert.deepEqual(second.stints, state.stints);
    assert.equal(second.periodRunning, false);
    assert.equal(second.config.stageSubstitutions, true);
    assert.deepEqual(second.timeline.slice(0, -1), activeTimeline(before));
    const resumed = event(7, "clock_resumed", trackingTime);
    const substituted = event(8, "player_moved", trackingTime + 60_000, { moves: swap("p4", "p2", "mid_center") });
    const history = JSON.parse(JSON.stringify([...after, resumed, substituted]));
    const final = projector.project(history, trackingTime + 120_000);
    assert.equal(final.players.p2.totalMs, trackingTime + 60_000);
    assert.equal(final.players.p4.totalMs, 60_000);
    assert.equal(displayedGameTime(history, final.elapsedMs), 47 * 60_000);
    assert.ok(final.stints.every(stint => stint.durationMs >= 0));
    assert.deepEqual(final.errors, []);
  });
}

test("halftime sync is off by default, preserves running state and uses the configured half length", () => {
  const state = projector.project(base, 500_000);
  const transition = event(4, "period_started", 500_000, periodStartPayload(state.config, 2));
  assert.equal(displayedGameTime([...base, transition], 510_000), 510_000);
  assert.equal(projector.project([...base, transition], 510_000).periodRunning, true);
  assert.equal(periodStartPayload({ ...state.config, syncHalfClock: true, periodMinutes: 25 }, 2).displayTimeMs, 25 * 60_000);
  assert.equal(periodStartPayload({ ...state.config, syncHalfClock: true }, 1).displayTimeMs, undefined);
});
