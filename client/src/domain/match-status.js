export const STALE_PAUSE_MS = 3 * 60 * 60 * 1000;

export function mainMenuMatchStatus(match, pausedAt, now = Date.now()) {
  if (match.completed) return "Final";
  if (match.periodRunning) return "Running";
  if (!match.currentPeriod) return "Ready";
  const pausedAtMs = new Date(pausedAt).getTime();
  if (Number.isFinite(pausedAtMs) && now - pausedAtMs >= STALE_PAUSE_MS) return "Over";
  return "Paused";
}
