export const BROAD_ROLE_SAMPLE_MS = 30 * 60_000;
export const EXACT_POSITION_SAMPLE_MS = 60 * 60_000;

export function rankPlayerDeployments(rows, playerId, objective = "balanced", priorMs = 60 * 60_000) {
  const samples = rows.filter(row => row.playerId === playerId && row.minutesMs > 0);
  const totalMs = samples.reduce((sum, row) => sum + row.minutesMs, 0);
  const totalFor = samples.reduce((sum, row) => sum + row.attemptsFor, 0);
  const totalAgainst = samples.reduce((sum, row) => sum + row.attemptsAgainst, 0);
  const baselineForPerMs = totalMs ? totalFor / totalMs : 0;
  const baselineAgainstPerMs = totalMs ? totalAgainst / totalMs : 0;
  const baselineForPer60 = baselineForPerMs * 3_600_000;
  const baselineAgainstPer60 = baselineAgainstPerMs * 3_600_000;
  return samples.map(row => {
    const exposureHours = (row.minutesMs + priorMs) / 3_600_000;
    const attemptsForCount = row.attemptsFor + baselineForPerMs * priorMs;
    const attemptsAgainstCount = row.attemptsAgainst + baselineAgainstPerMs * priorMs;
    const attemptsForPer60 = attemptsForCount / exposureHours;
    const attemptsAgainstPer60 = attemptsAgainstCount / exposureHours;
    const attemptsForEffect = attemptsForPer60 - baselineForPer60;
    const attemptsPreventedEffect = baselineAgainstPer60 - attemptsAgainstPer60;
    const attemptMarginEffect = attemptsForEffect + attemptsPreventedEffect;
    const attemptsForSe = Math.sqrt(Math.max(1, attemptsForCount)) / exposureHours;
    const attemptsAgainstSe = Math.sqrt(Math.max(1, attemptsAgainstCount)) / exposureHours;
    const marginSe = Math.sqrt(attemptsForSe ** 2 + attemptsAgainstSe ** 2);
    const effect = objective === "attack" ? attemptsForEffect : objective === "defend" ? attemptsPreventedEffect : attemptMarginEffect;
    const standardError = objective === "attack" ? attemptsForSe : objective === "defend" ? attemptsAgainstSe : marginSe;
    const rangeHalfWidth = 1.282 * standardError;
    return {
      ...row,
      smoothedAttemptsForPer60: attemptsForPer60,
      smoothedAttemptsAgainstPer60: attemptsAgainstPer60,
      attemptsForEffect,
      attemptsPreventedEffect,
      attemptMarginEffect,
      guidanceEffect: effect,
      guidanceLow: effect - rangeHalfWidth,
      guidanceHigh: effect + rangeHalfWidth
    };
  }).sort((a, b) => b.guidanceEffect - a.guidanceEffect || b.minutesMs - a.minutesMs);
}

export function positionGuidanceReadiness(analysis) {
  const attemptEvents = analysis.attemptsFor + analysis.attemptsAgainst;
  const supportedByPlayer = new Map();
  for (const row of analysis.playerLines) {
    if (row.minutesMs < BROAD_ROLE_SAMPLE_MS) continue;
    supportedByPlayer.set(row.playerId, (supportedByPlayer.get(row.playerId) || 0) + 1);
  }
  const comparablePlayers = [...supportedByPlayer.values()].filter(count => count >= 2).length;
  const ready = analysis.attemptMatches >= 3 && attemptEvents >= 20 && comparablePlayers > 0;
  const progress = Math.round(Math.min(
    1,
    analysis.attemptMatches / 3,
    attemptEvents / 20,
    comparablePlayers ? 1 : Math.max(0, ...supportedByPlayer.values(), 0) / 2
  ) * 100);
  const needs = [];
  if (analysis.attemptMatches < 3) needs.push(`${3 - analysis.attemptMatches} more match${3 - analysis.attemptMatches === 1 ? "" : "es"} with attempts`);
  if (attemptEvents < 20) needs.push(`${20 - attemptEvents} more attempts`);
  if (!comparablePlayers) needs.push("one player with 30 minutes in two broad roles");
  return { ready, progress, needs: needs.join(" and ") || "More varied position time will strengthen guidance", comparablePlayers };
}
