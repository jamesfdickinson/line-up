export const SUBSTITUTION_HIGHLIGHT_MS = 30_000;

const isOffField = location => location === "off_field" || location === "not_here";

export function recentSubstitutionChanges(timeline, nowMs = Date.now(), windowMs = SUBSTITUTION_HIGHLIGHT_MS) {
  const on = new Set();
  const off = new Set();
  let nextExpiryMs = null;
  for (const event of timeline || []) {
    if (event.type !== "player_moved") continue;
    const occurredAt = Date.parse(event.realTimestamp);
    const age = nowMs - occurredAt;
    if (!Number.isFinite(occurredAt) || age < 0 || age >= windowMs) continue;
    const expiry = occurredAt + windowMs;
    nextExpiryMs = nextExpiryMs === null ? expiry : Math.min(nextExpiryMs, expiry);
    for (const move of event.payload?.moves || []) {
      if (isOffField(move.from) && !isOffField(move.to)) on.add(move.playerId);
      if (!isOffField(move.from) && isOffField(move.to)) off.add(move.playerId);
    }
  }
  return { on, off, nextExpiryMs };
}
