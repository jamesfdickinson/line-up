export class SuggestionEngine {
  suggest(state) {
    if (!state.config || state.completed || !state.fieldCount) return null;
    const eligibleBench = state.bench
      .filter(p => p.status === "available")
      .map(p => state.players[p.playerId])
      .sort((a, b) => b.benchMs - a.benchMs);
    const allField = Object.values(state.field).map(id => state.players[id]);
    const field = allField.filter(player => player.playerId !== state.goalkeeperId).length
      ? allField.filter(player => player.playerId !== state.goalkeeperId)
      : allField;
    if (!eligibleBench.length || !field.length) return null;
    const out = [...field].sort((a, b) => b.currentStintMs - a.currentStintMs)[0];
    const incoming = eligibleBench[0];
    const maxStintMs = state.config.maxStintMinutes * 60_000;
    const restAlertMs = state.config.restAlertMinutes * 60_000;
    if (out.currentStintMs < maxStintMs && incoming.benchMs < restAlertMs) return null;
    const reasons = [];
    if (out.currentStintMs >= maxStintMs) reasons.push(`${out.name} has played ${minutes(out.currentStintMs)} continuously.`);
    if (incoming.benchMs >= restAlertMs) reasons.push(`${incoming.name} has rested ${minutes(incoming.benchMs)}.`);
    const position = Object.keys(state.field).find(pos => state.field[pos] === out.playerId);
    reasons.push("This moves both players toward balanced playing time.");
    return { playerOutId: out.playerId, playerInId: incoming.playerId, position, reasons };
  }
}

const minutes = ms => `${Math.floor(ms / 60_000)} min`;
