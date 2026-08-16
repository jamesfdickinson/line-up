import { activeTimeline } from "./match-event.js";

export function displayedGameTime(events, trackingTimeMs, throughSequence = Infinity) {
  const adjustment = activeTimeline(events)
    .filter(event => event.type === "clock_adjusted"
      && (event.gameTimeMs < trackingTimeMs || (event.gameTimeMs === trackingTimeMs && event.sequence <= throughSequence)))
    .at(-1);
  if (!adjustment) return Math.max(0, trackingTimeMs);
  return Math.max(0, adjustment.payload.displayTimeMs + trackingTimeMs - adjustment.gameTimeMs);
}
