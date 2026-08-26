export const LINEUP_CHANGE_GROUP_MS = 60_000;

export function groupLineupStints(stints, windowMs = LINEUP_CHANGE_GROUP_MS) {
  const grouped = (stints || []).map(stint => ({ ...stint, field: structuredClone(stint.field) }));
  for (let index = 0; index < grouped.length - 1;) {
    const current = grouped[index];
    if (current.durationMs > windowMs) {
      index += 1;
      continue;
    }
    const next = grouped[index + 1];
    next.startMs = current.startMs;
    next.durationMs = next.endMs - next.startMs;
    next.goalsFor += current.goalsFor;
    next.goalsAgainst += current.goalsAgainst;
    grouped.splice(index, 1);
  }
  return grouped;
}
