export const EXTRA_POSITIONS = ["extra_1", "extra_2"];
export const isFieldPosition = position => !["off_field", "not_here"].includes(position);

export function playerLocation(state, playerId) {
  return Object.keys(state.field).find(position => state.field[position] === playerId)
    || (state.unavailable?.some(player => player.playerId === playerId) ? "not_here" : "off_field");
}

export function validateMoves(state, moves) {
  if (!moves.length) throw new Error("Choose players to move.");
  const ids = new Set(moves.map(move => move.playerId));
  const destinations = moves.map(move => move.to).filter(isFieldPosition);
  if (ids.size !== moves.length || new Set(destinations).size !== destinations.length) throw new Error("A player or position can only be used once.");
  for (const move of moves) {
    if (!state.config.roster.some(player => player.playerId === move.playerId)
      || !move.to || playerLocation(state, move.playerId) !== move.from) throw new Error("The lineup changed. Select the substitution again.");
    if (isFieldPosition(move.to) && state.field[move.to] && !ids.has(state.field[move.to])) throw new Error("That position is occupied.");
  }
  const next = { ...state.field };
  for (const [position, id] of Object.entries(next)) if (ids.has(id)) delete next[position];
  for (const move of moves) if (isFieldPosition(move.to)) next[move.to] = move.playerId;
  if (Object.keys(next).length > state.config.playersOnField + 2) throw new Error("Only two extra players may be on the field.");
}

// Re-selecting the same pairing toggles it off. A different player or
// destination replaces the conflicting draft in full.
export function stageMoves(pending, moves, state) {
  validateMoves(state, moves);
  const sameDraft = pending.findIndex(group => group.length === moves.length && group.every(move => moves.some(candidate =>
    candidate.playerId === move.playerId && candidate.from === move.from && candidate.to === move.to)));
  if (sameDraft !== -1) {
    const next = pending.filter((_, index) => index !== sameDraft);
    if (next.length) validateMoves(state, next.flat());
    return next;
  }
  const ids = new Set(moves.map(move => move.playerId));
  const positions = new Set(moves.flatMap(move => [move.from, move.to]).filter(isFieldPosition));
  const remaining = pending.filter(group => !group.some(move => ids.has(move.playerId)
    || [move.from, move.to].some(position => isFieldPosition(position) && positions.has(position))));
  const next = [...remaining, moves];
  validateMoves(state, next.flat());
  return next;
}

export function validPendingMoves(pending, state) {
  return pending.filter(moves => {
    try { validateMoves(state, moves); return true; } catch { return false; }
  });
}

export function periodStartPayload(config, period, running = true) {
  return { period, running, ...(config.syncHalfClock && period === 2
    ? { displayTimeMs: config.periodMinutes * 60_000 } : {}) };
}

export function normalizedPlayerName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("Enter a player name.");
  return name;
}
