import { activeTimeline } from "./match-event.js";

const replayTypes = new Set(["starting_lineup_confirmed", "player_moved", "layout_changed", "extra_positioned", "goal_for", "goal_against", "assist_for", "goal_attempt", "period_started", "period_ended", "match_completed", "player_added", "player_removed", "note_added"]);

export function replayMoments(events) {
  const moments = [];
  for (const event of activeTimeline(events)) {
    if (!replayTypes.has(event.type)) continue;
    let moment = moments.at(-1);
    if (!moment || moment.timeMs !== event.gameTimeMs) {
      moment = { timeMs: event.gameTimeMs, events: [] };
      moments.push(moment);
    }
    moment.events.push(event);
  }
  return moments;
}

export function replayMomentAt(moments, timeMs) {
  return moments.findLast(moment => moment.timeMs <= timeMs) || null;
}
