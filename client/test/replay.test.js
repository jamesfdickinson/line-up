import test from "node:test";
import assert from "node:assert/strict";
import { replayMoments, replayMomentAt } from "../src/domain/replay.js";

test("replay groups simultaneous changes and follows corrected and retracted history", () => {
  const event = (eventId, sequence, type, gameTimeMs, payload = {}) => ({ eventId, sequence, type, gameTimeMs, payload });
  const moments = replayMoments([
    event("start", 1, "period_started", 0),
    event("move", 2, "player_moved", 1000),
    event("goal", 3, "goal_for", 2000),
    event("assist", 4, "assist_for", 2000),
    event("pause", 5, "clock_paused", 3000),
    event("fix", 6, "event_replaced", 3000, { targetEventId: "move", replacement: { type: "player_moved", gameTimeMs: 2000, payload: {} } }),
    event("undo", 7, "event_retracted", 3000, { targetEventId: "goal" })
  ]);
  assert.deepEqual(moments.map(moment => moment.timeMs), [0, 2000]);
  assert.deepEqual(moments[1].events.map(event => event.eventId), ["move", "assist"]);
  assert.equal(replayMomentAt(moments, 1999), moments[0]);
  assert.equal(replayMomentAt(moments, 2000), moments[1]);
  assert.equal(replayMomentAt([], 0), null);
});
