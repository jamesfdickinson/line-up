import { createId } from "./id.js";

const EVENT_TYPES = new Set([
  "match_created", "starting_lineup_confirmed", "period_started",
  "clock_paused", "clock_resumed", "clock_adjusted", "period_ended",
  "player_added", "player_removed", "player_moved", "layout_changed",
  "goal_for", "assist_for", "goal_against", "note_added", "match_completed",
  "event_retracted", "event_replaced"
]);

export class MatchEvent {
  constructor({ eventId, matchId, type, gameTimeMs = 0, realTimestamp, sequence, payload = {}, timeSource = "automatic" }) {
    if (!eventId || !matchId) throw new Error("Events require stable event and match identifiers.");
    if (!EVENT_TYPES.has(type)) throw new Error(`Unsupported event type: ${type}`);
    if (!Number.isFinite(gameTimeMs) || gameTimeMs < 0) throw new Error("Game time must be non-negative.");
    this.eventId = eventId;
    this.matchId = matchId;
    this.type = type;
    this.gameTimeMs = Math.round(gameTimeMs);
    this.realTimestamp = realTimestamp || new Date().toISOString();
    this.sequence = Number.isInteger(sequence) ? sequence : 0;
    this.payload = structuredClone(payload);
    this.timeSource = timeSource;
  }

  static create(matchId, type, gameTimeMs, payload = {}, sequence = 0, timeSource = "automatic") {
    return new MatchEvent({
      eventId: createId(), matchId, type, gameTimeMs,
      realTimestamp: new Date().toISOString(), sequence, payload, timeSource
    });
  }

  toJSON() { return { ...this, payload: structuredClone(this.payload) }; }
}

export function activeTimeline(events) {
  const retracted = new Set();
  const replacements = new Map();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "event_retracted") retracted.add(event.payload.targetEventId);
    if (event.type === "event_replaced") replacements.set(event.payload.targetEventId, event);
  }
  return events
    .filter(event => !event.type.startsWith("event_") && !retracted.has(event.eventId))
    .map(event => {
      const correction = replacements.get(event.eventId);
      if (!correction) return event;
      const replacement = correction.payload.replacement;
      return { ...event, ...replacement, eventId: event.eventId, sequence: event.sequence, correctedBy: correction.eventId };
    })
    .sort((a, b) => a.gameTimeMs - b.gameTimeMs || a.sequence - b.sequence);
}

export const isCorrection = type => type === "event_retracted" || type === "event_replaced";
