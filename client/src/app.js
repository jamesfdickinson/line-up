import { MatchEvent, activeTimeline, isCorrection } from "./domain/match-event.js";
import { MatchClock } from "./domain/match-clock.js";
import { LineupProjector } from "./domain/lineup-projector.js";
import { EventStore } from "./storage/event-store.js";
import { exportMatchJson, exportEventsCsv, downloadFile } from "./domain/exporter.js";
import { orderedScorerGroups, playerIdFromName } from "./domain/player-label.js";
import { matchIdsForTeam } from "./domain/team.js";
import { displayedGameTime } from "./domain/game-time.js";
import { mainMenuMatchStatus } from "./domain/match-status.js";
import { createId } from "./domain/id.js";

const FORMATIONS = {
  3: [{ name: "1-1", shape: [1, 0, 1] }],
  4: [{ name: "1-1-1", shape: [1, 1, 1] }, { name: "2-1", shape: [2, 0, 1] }],
  5: [{ name: "2-1-1", shape: [2, 1, 1] }, { name: "1-2-1", shape: [1, 2, 1] }],
  6: [{ name: "2-2-1", shape: [2, 2, 1] }, { name: "3-1-1", shape: [3, 1, 1] }, { name: "2-1-2", shape: [2, 1, 2] }],
  7: [{ name: "2-3-1", shape: [2, 3, 1] }, { name: "3-2-1", shape: [3, 2, 1] }, { name: "2-2-2", shape: [2, 2, 2] }],
  8: [{ name: "3-2-2", shape: [3, 2, 2] }, { name: "2-3-2", shape: [2, 3, 2] }, { name: "3-3-1", shape: [3, 3, 1] }],
  9: [{ name: "3-3-2", shape: [3, 3, 2] }, { name: "2-3-3", shape: [2, 3, 3] }, { name: "3-2-3", shape: [3, 2, 3] }],
  10: [{ name: "3-3-3", shape: [3, 3, 3] }, { name: "4-3-2", shape: [4, 3, 2] }, { name: "3-4-2", shape: [3, 4, 2] }],
  11: [{ name: "4-3-3", shape: [4, 3, 3] }, { name: "4-4-2", shape: [4, 4, 2] }, { name: "3-5-2", shape: [3, 5, 2] }]
};
const defaults = Object.fromEntries(Object.entries(FORMATIONS).map(([size, layouts]) => [size, formationPositions(layouts[0].shape)]));
const POSITIONS = [...new Set(Object.values(FORMATIONS).flatMap(layouts => layouts.flatMap(layout => formationPositions(layout.shape))))];
const SILENT_EVENT_TYPES = new Set([
  "player_moved",
  "layout_changed",
  "period_started", "period_ended", "clock_paused", "clock_resumed"
]);

const $ = selector => document.querySelector(selector);
const store = new EventStore();
const projector = new LineupProjector();
let events = [];
let state = projector.empty();
let matchId = null;
let clock = null;
let toastTimer = null;
let selectedPlayerId = null;
let pointerDrag = null;
let nativeDragging = false;
let suppressClickUntil = 0;
let team = null;
let teams = [];
let readinessMatchId = null;
let fieldWasFull = false;
let stoppedFullPulse = false;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindStaticEvents();
  try {
    await store.open();
    const storedTeams = await store.getMeta("teams");
    if (storedTeams) teams = normalizeTeams(storedTeams.value);
    else {
      const legacyTeam = (await store.getMeta("team"))?.value || await createInitialTeam();
      teams = normalizeTeams([legacyTeam]);
    }
    const activeTeamId = (await store.getMeta("activeTeamId"))?.value;
    team = teams.find(item => item.teamId === activeTeamId) || teams[0] || null;
    await persistTeams();
    await renderTeamDashboard();
    if (teams.length > 1) openTeamMenu();
    setSaveStatus("Saved on this device");
  } catch (error) {
    setSaveStatus("Storage unavailable", true);
  }
  if ("serviceWorker" in navigator && !import.meta.env.DEV) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function bindStaticEvents() {
  const matchTabs = document.querySelector(".tabs");
  matchTabs.prepend($("#match-back"));
  matchTabs.append($("#more-actions"));
  $("#team-name-input").addEventListener("change", saveTeam);
  $("#create-new-match").addEventListener("click", createBlankMatch);
  $("#season-analysis").addEventListener("click", showSeasonAnalysis);
  $("#team-menu").addEventListener("click", openTeamMenu);
  $("#add-first-team").addEventListener("click", openAddTeam);
  $("#back-to-team").addEventListener("click", () => { $("#season-analysis-panel").classList.add("hidden"); $("#team-dashboard").classList.remove("hidden"); });
  $("#team-matches").addEventListener("click", event => { const button = event.target.closest("[data-open-match]"); if (button) loadMatch(button.dataset.openMatch); });
  $("#clock-button").addEventListener("click", openClockAdjust);
  $("#match-control").addEventListener("click", toggleClock);
  $("#score-for-button").onclick = event => { event.preventDefault(); event.stopPropagation(); openGoalFor(); };
  $("#score-against-button").onclick = event => { event.preventDefault(); event.stopPropagation(); recordSimple("goal_against").catch(showActionError); };
  $("#clear-field").addEventListener("click", clearField);
  $("#layout-button").addEventListener("click", openLayoutPicker);
  $("#more-actions").addEventListener("click", openMoreActions);
  $("#match-back").addEventListener("click", returnToTeam);
  $("#add-note").addEventListener("click", openTimelineAdd);
  $("#undo").addEventListener("click", undoLatest);
  $("#export-json").addEventListener("click", () => downloadFile(fileBase() + ".json", exportMatchJson(events, state), "application/json"));
  $("#export-csv").addEventListener("click", () => downloadFile(fileBase() + "-events.csv", exportEventsCsv(events, state), "text/csv"));
  document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.view)));
}

async function createInitialTeam() {
  const initial = { teamId: createId(), name: $("#team-name-input").value.trim() || "My Team", players: [] };
  await store.setMeta("team", initial);
  return initial;
}

async function saveTeam() {
  if (!team) return;
  team = { teamId: team?.teamId || createId(), name: $("#team-name-input").value.trim() || "My Team", players: team?.players || [] };
  teams = teams.map(item => item.teamId === team.teamId ? team : item);
  await persistTeams();
  setSaveStatus("Team saved");
}

async function persistTeams() {
  await store.setMeta("teams", teams);
  await store.setMeta("activeTeamId", team?.teamId || null);
  await store.setMeta("team", team);
}

function openTeamMenu() {
  const rows = teams.map(item => `<div class="team-menu-row"><button type="button" class="team-select ${item.teamId === team?.teamId ? "active" : ""}" data-team-select="${escapeHtml(item.teamId)}"><strong>${escapeHtml(item.name)}</strong>${item.teamId === team?.teamId ? "<small>Current</small>" : ""}</button><button type="button" class="team-delete" data-team-delete="${escapeHtml(item.teamId)}" aria-label="Delete ${escapeHtml(item.name)}">Delete</button></div>`).join("");
  openDialog("Teams", `<div class="team-menu-list">${rows || "<p class='hint'>No teams yet.</p>"}<button type="button" class="primary add-team-menu" data-add-team>+ Add team</button></div>`, null, false);
  $("#dialog-body").onclick = event => {
    const add = event.target.closest("[data-add-team]");
    const select = event.target.closest("[data-team-select]");
    const remove = event.target.closest("[data-team-delete]");
    if (add) { $("#action-dialog").close(); openAddTeam(); }
    if (select) { $("#action-dialog").close(); selectTeam(select.dataset.teamSelect); }
    if (remove) { $("#action-dialog").close(); openDeleteTeam(remove.dataset.teamDelete); }
  };
}

function openAddTeam() {
  openDialog("Add team", `<div class="dialog-fields"><label>Team name<input name="teamName" autocomplete="off" required autofocus></label></div>`, async data => {
    const name = String(data.get("teamName") || "").trim();
    if (!name) throw new Error("Enter a team name.");
    if (teams.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("A team with that name already exists.");
    team = { teamId: createId(), name, players: [] };
    teams.push(team);
    await persistTeams();
    $("#season-analysis-panel").classList.add("hidden");
    await renderTeamDashboard();
    setSaveStatus("Team added");
  });
}

async function selectTeam(teamId) {
  const selected = teams.find(item => item.teamId === teamId);
  if (!selected) return;
  team = selected;
  await persistTeams();
  $("#season-analysis-panel").classList.add("hidden");
  await renderTeamDashboard();
  setSaveStatus(`${team.name} selected`);
}

function openDeleteTeam(teamId) {
  const target = teams.find(item => item.teamId === teamId);
  if (!target) return;
  openDialog("Delete team?", `<p>Permanently delete <strong>${escapeHtml(target.name)}</strong> and all of its matches? Other teams will not be changed.</p>`, async () => {
    const all = await store.allEvents();
    for (const id of matchIdsForTeam(all, teamId)) await store.deleteMatch(id);
    teams = teams.filter(item => item.teamId !== teamId);
    if (team?.teamId === teamId) team = teams[0] || null;
    await persistTeams();
    $("#season-analysis-panel").classList.add("hidden");
    await renderTeamDashboard();
    setSaveStatus("Team deleted");
  });
}

async function createBlankMatch() {
  if (!team) return openAddTeam();
  await saveTeam();
  const playersOnField = Number($("#team-format").value);
  matchId = createId();
  events = [];
  clock?.destroy();
  clock = new MatchClock({ onTick: renderAt });
  const config = {
    teamId: team.teamId, team: team.name, opponent: $("#new-opponent").value.trim() || "Opponent",
    date: new Date().toISOString().slice(0, 10), competition: "Season", opponentStrength: "Similar",
    periodCount: 2, periodMinutes: 25, playersOnField, maxStintMinutes: 12, restAlertMinutes: 8,
    roster: team.players.map(player => ({ ...player, status: "available", defaultPositions: [], goalkeeperEligible: true })),
    expectedComplete: true, clockMode: "count_up", layoutName: FORMATIONS[playersOnField][0].name,
    positions: defaults[playersOnField]
  };
  await append("match_created", 0, config, false);
  await append("starting_lineup_confirmed", 0, { assignments: [], goalkeeperId: null }, false);
  showMatch();
  renderAt(0);
  if (!config.roster.length) openAddPlayer();
}

async function loadMatch(id) {
  clock?.destroy();
  matchId = id;
  events = await store.eventsFor(matchId);
  if (events.length) restoreMatch();
}

async function renderTeamDashboard() {
  const hasTeam = Boolean(team);
  $("#no-team-panel").classList.toggle("hidden", hasTeam);
  $("#team-dashboard").classList.toggle("hidden", !hasTeam);
  $("#team-name-input").disabled = !hasTeam;
  $("#season-analysis").disabled = !hasTeam;
  if (!hasTeam) { $("#team-name-input").value = ""; return; }
  $("#team-name-input").value = team.name;
  const all = await store.allEvents();
  const ids = matchIdsForTeam(all, team.teamId);
  const matches = ids.map(id => { const matchEvents = all.filter(event => event.matchId === id); return projector.project(matchEvents); }).sort((a, b) => b.config.date.localeCompare(a.config.date));
  const pausedAtByMatch = new Map(ids.map(id => {
    const matchEvents = activeTimeline(all.filter(event => event.matchId === id));
    const pausedEvent = [...matchEvents].reverse().find(event => ["clock_paused", "period_ended"].includes(event.type));
    return [id, pausedEvent?.realTimestamp];
  }));
  $("#team-matches").innerHTML = matches.map(match => `<button class="match-row" data-open-match="${match.matchId}"><span><strong>${escapeHtml(match.config.opponent)}</strong><small>${escapeHtml(match.config.date)} · ${match.config.playersOnField}v${match.config.playersOnField}</small></span><b>${match.scoreFor}–${match.scoreAgainst}</b><span>→</span></button>`).join("") || "<p class='hint'>No matches yet. New matches begin with every position empty.</p>";
  [...$("#team-matches").querySelectorAll(".match-row")].forEach((row, index) => {
    const match = matches[index];
    const status = mainMenuMatchStatus(match, pausedAtByMatch.get(match.matchId));
    row.querySelector("span")?.insertAdjacentHTML("beforeend", `<em class="match-state ${status.toLowerCase()}">${status}</em>`);
  });
}

function openAddPlayer() {
  const fields = () => `<input name="playerName" autocomplete="off" placeholder="Player name">`;
  openDialog("Add players", `<div class="dialog-fields"><label>Player names<div id="player-name-list" class="player-name-list">${fields()}</div></label><p class="hint">Players will also be available in every future match for ${escapeHtml(team.name)}.</p></div>`, async data => {
    const names = data.getAll("playerName").map(value => String(value).trim()).filter(Boolean);
    if (!names.length) throw new Error("Enter at least one player name.");
    const keys = names.map(name => name.toLocaleLowerCase());
    if (new Set(keys).size !== keys.length) throw new Error("Each player name can only be added once.");
    const existing = new Set(state.config.roster.map(player => player.name.toLocaleLowerCase()));
    const duplicate = names.find((name, index) => existing.has(keys[index]));
    if (duplicate) throw new Error(`${duplicate} is already in this match.`);
    let teamChanged = false;
    const players = names.map((name, index) => {
      let player = team.players.find(item => item.name.toLocaleLowerCase() === keys[index]);
      if (!player) { player = { playerId: playerIdFromName(name), name }; team.players.push(player); teamChanged = true; }
      return player;
    });
    if (teamChanged) await persistTeams();
    for (const player of players) await append("player_added", clock.elapsedMs, { player: { ...player, status: "available", defaultPositions: [], goalkeeperEligible: true } }, false);
  });
  $("#dialog-confirm").textContent = "Add";
  bindGrowingPlayerInputs(fields);
  $("#player-name-list input").focus();
}

function bindGrowingPlayerInputs(fields) {
  const list = $("#player-name-list");
  list.oninput = () => {
    const inputs = [...list.querySelectorAll('input[name="playerName"]')];
    if (inputs.at(-1)?.value.trim()) list.insertAdjacentHTML("beforeend", fields());
  };
}

async function showSeasonAnalysis() {
  if (!team) return;
  const all = await store.allEvents();
  const ids = matchIdsForTeam(all, team.teamId);
  const matches = ids.map(id => projector.project(all.filter(event => event.matchId === id)));
  const goalsFor = matches.reduce((sum, match) => sum + match.scoreFor, 0), goalsAgainst = matches.reduce((sum, match) => sum + match.scoreAgainst, 0);
  const playerMinutes = {};
  for (const match of matches) for (const player of Object.values(match.players)) playerMinutes[player.name] = (playerMinutes[player.name] || 0) + player.totalMs;
  $("#season-summary").innerHTML = `<div class="analysis-kpis"><article><strong>${matches.length}</strong><span>Matches</span></article><article><strong>${goalsFor}</strong><span>Goals for</span></article><article><strong>${goalsAgainst}</strong><span>Goals against</span></article></div><div class="minutes-report">${Object.entries(playerMinutes).sort((a,b)=>b[1]-a[1]).map(([name,ms]) => `<article class="minute-card"><div class="minute-top"><strong>${escapeHtml(name)}</strong><strong>${formatMinutes(ms)}</strong></div></article>`).join("")}</div>`;
  $("#team-dashboard").classList.add("hidden"); $("#season-analysis-panel").classList.remove("hidden");
}

function restoreMatch() {
  const projected = projector.project(events);
  const last = activeTimeline(events).at(-1);
  let elapsedMs = projected.elapsedMs;
  if (projected.periodRunning && last) elapsedMs += Math.max(0, Date.now() - new Date(last.realTimestamp).getTime());
  clock = new MatchClock({ elapsedMs, running: projected.periodRunning, onTick: renderAt });
  showMatch();
  renderAt(elapsedMs);
}

function showMatch() {
  document.body.classList.add("match-open");
  $("#setup-view").classList.add("hidden");
  $("#match-view").classList.remove("hidden", "draft-match");
  switchTab("live");
}

async function append(type, gameTimeMs = clock?.elapsedMs || 0, payload = {}, notify = true, timeSource = "automatic") {
  setSaveStatus("Saving…");
  const event = MatchEvent.create(matchId, type, gameTimeMs, payload, (events.at(-1)?.sequence || 0) + 1, timeSource).toJSON();
  await store.append(event);
  events.push(event);
  setSaveStatus("Saved on this device");
  renderAt(clock?.elapsedMs ?? gameTimeMs);
  if (notify && !isCorrection(type) && !SILENT_EVENT_TYPES.has(type)) showUndo(`${eventLabel(event)} saved`);
  return event;
}

function renderAt(elapsedMs) {
  if (!matchId) return;
  state = projector.project(events, elapsedMs);
  renderScoreboard();
  if (pointerDrag || nativeDragging) return;
  renderField(); renderBench(); renderUnavailable(); bindPlayerInteractions();
  if (!$("#timeline-panel").classList.contains("hidden")) renderTimeline();
  if (!$("#report-panel").classList.contains("hidden")) renderReport();
}

function renderScoreboard() {
  const c = state.config;
  $("#match-topbar-team").textContent = c.team;
  $("#team-name").textContent = c.team; $("#opponent-name").textContent = c.opponent;
  $("#match-label").textContent = `${c.competition} · ${c.date}`;
  $("#score-for").textContent = state.scoreFor; $("#score-against").textContent = state.scoreAgainst;
  const gameClock = formatClock(displayedGameTime(events, state.elapsedMs));
  $("#clock-button").textContent = gameClock;
  $("#compact-team-name").textContent = c.team;
  $("#compact-opponent-name").textContent = c.opponent;
  $("#compact-score-for").textContent = state.scoreFor;
  $("#compact-score-against").textContent = state.scoreAgainst;
  $("#compact-clock").textContent = gameClock;
  const halfLabel = c.periodCount === 2 && state.currentPeriod ? (state.currentPeriod === 1 ? "First half" : "Second half") : state.currentPeriod ? `Period ${state.currentPeriod}` : "Ready";
  $("#period-label").textContent = state.completed ? "Full time" : isBetweenPeriods() ? "Half time" : halfLabel;
  $("#live-status").textContent = state.completed ? "FINAL" : state.periodRunning ? "LIVE" : state.currentPeriod ? "PAUSED" : "READY";
  $("#live-status").style.color = state.periodRunning ? "#c9ff5b" : "#ff9d4d";
  renderMatchControls();
}

function renderMatchControls() {
  const control = $("#match-control");
  control.classList.toggle("hidden", state.completed || (isBetweenPeriods() && state.currentPeriod >= state.config.periodCount));
  const fieldReady = state.fieldCount === state.config.playersOnField;
  if (readinessMatchId !== state.matchId) {
    readinessMatchId = state.matchId;
    fieldWasFull = fieldReady;
    stoppedFullPulse = false;
  } else {
    const becameFullWhileStopped = fieldReady && !fieldWasFull && !clock?.running;
    if (becameFullWhileStopped) stoppedFullPulse = true;
    if (!fieldReady || clock?.running || state.completed) stoppedFullPulse = false;
    fieldWasFull = fieldReady;
  }
  control.classList.toggle("kickoff-pulse", stoppedFullPulse);
  control.textContent = clock?.running ? "Stop" : "Start";
}

function isBetweenPeriods() {
  const boundary = [...state.timeline].reverse().find(event => event.type === "period_started" || event.type === "period_ended");
  return boundary?.type === "period_ended";
}

function renderField() {
  $("#field-count").textContent = `${state.fieldCount} / ${state.config.playersOnField}`;
  $("#clear-field").disabled = state.fieldCount === 0;
  const basePositions = activePositions();
  const positions = [...basePositions, ...Object.keys(state.field).filter(position => !basePositions.includes(position))];
  const renderPosition = (position, rowLength, index) => {
    const id = state.field[position];
    const column = positionColumn(position, rowLength, index);
    if (!id) return `<div class="empty-field-slot ${position === "gk" ? "keeper-slot" : ""}" style="grid-column:${column}" data-position="${escapeHtml(position)}"><span>＋</span><small>${escapeHtml(shortPosition(position))}</small></div>`;
    const p = state.players[id];
    return `<article class="player-card player-token ${id === state.goalkeeperId ? "gk" : ""} ${id === selectedPlayerId ? "selected" : ""}" style="grid-column:${column}" draggable="true" data-player-id="${escapeHtml(id)}" data-position="${escapeHtml(position)}" data-location="field" aria-label="${escapeHtml(p.name)}"><span class="shirt-icon">${escapeHtml(shortPlayerName(p.name))}</span><span class="player-time">${formatMinutes(p.currentStintMs)}</span></article>`;
  };
  const bands = ["attack", "attacking-mid", "midfield", "utility", "defensive-mid", "defense", "keeper"];
  $("#field").innerHTML = bands.map(band => {
    const row = positions.filter(position => positionBand(position) === band);
    return row.length ? `<div class="position-band position-band-${band}" style="grid-template-columns:repeat(${Math.max(3, row.length)},minmax(0,1fr))">${row.map((position, index) => renderPosition(position, row.length, index)).join("")}</div>` : "";
  }).join("") + `<button type="button" class="field-score field-score-for" data-field-score="goal_for">＋ Score for</button><button type="button" class="field-score field-score-against" data-field-score="goal_against">＋ Score against</button>`;
  $("#field").insertAdjacentHTML("beforeend", `<span class="pitch-goal opponent-goal" aria-hidden="true"></span><span class="pitch-goal keeper-goal" aria-hidden="true"></span>`);
}

async function clearField() {
  if (!state.fieldCount) return;
  await movePlayers(Object.entries(state.field).map(([from, playerId]) => ({ playerId, from, to: "off_field" })));
}

function openLayoutPicker() {
  const layouts = FORMATIONS[state.config.playersOnField] || [];
  const choices = layouts.map(layout => `<button type="button" class="layout-choice ${layout.name === state.config.layoutName ? "selected" : ""}" data-layout="${escapeHtml(layout.name)}"><strong>${escapeHtml(layout.name)}</strong><small>${layout.shape.join(" · ")}</small></button>`).join("");
  openDialog("Choose layout", `<div class="layout-choices">${choices}</div>`, null, false);
  $("#dialog-body").onclick = async event => {
    const button = event.target.closest("[data-layout]");
    if (!button) return;
    const layout = layouts.find(item => item.name === button.dataset.layout);
    if (!layout) return;
    $("#action-dialog").close();
    await append("layout_changed", clock.elapsedMs, { name: layout.name, positions: formationPositions(layout.shape) }, false);
  };
}

function renderBench() {
  const offFieldTime = player => Math.max(0, state.elapsedMs - (state.players[player.playerId]?.lastExitedAt ?? state.elapsedMs));
  const players = state.bench.filter(Boolean).sort((a, b) => offFieldTime(b) - offFieldTime(a) || a.name.localeCompare(b.name));
  const playerTokens = players.map(player => {
    const offFieldMs = offFieldTime(player);
    return `<article class="bench-card player-token ${player.playerId === selectedPlayerId ? "selected" : ""}" draggable="true" data-player-id="${escapeHtml(player.playerId)}" data-location="bench" aria-label="${escapeHtml(player.name)}"><span class="shirt-icon">${escapeHtml(shortPlayerName(player.name))}</span><span class="player-time">${formatMinutes(offFieldMs)}</span></article>`;
  }).join("");
  $("#bench").innerHTML = `${playerTokens}<button id="add-player" class="add-player-tile" type="button" aria-label="Add players"><span class="add-player-icon" aria-hidden="true">+</span></button><div id="unavailable" class="unavailable-zone" aria-label="Not here"></div>`;
}

function renderUnavailable() {
  const unavailable = (state.unavailable || []).filter(Boolean);
  const zone = $("#unavailable");
  zone.classList.toggle("has-players", unavailable.length > 0);
  zone.style.setProperty("--unavailable-columns", Math.min(unavailable.length + 1, 4));
  const playerTokens = unavailable.map(player => `<article class="bench-card player-token unavailable-card ${player.playerId === selectedPlayerId ? "selected" : ""}" draggable="true" data-player-id="${escapeHtml(player.playerId)}" data-location="unavailable" aria-label="${escapeHtml(player.name)}"><span class="shirt-icon">${escapeHtml(shortPlayerName(player.name))}</span></article>`).join("");
  zone.innerHTML = `<span class="unavailable-label">Not here</span>${playerTokens}`;
}

function bindPlayerInteractions() {
  $("#add-player")?.addEventListener("click", openAddPlayer);
  document.querySelectorAll("[data-field-score]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    if (button.dataset.fieldScore === "goal_for") openGoalFor();
    else recordSimple("goal_against");
  }));
  const cards = [...document.querySelectorAll("[data-player-id]")];
  for (const card of cards) {
    card.addEventListener("dragstart", event => {
      nativeDragging = true;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/player-id", card.dataset.playerId);
      requestAnimationFrame(() => card.classList.add("dragging"));
    });
    card.addEventListener("dragend", () => {
      nativeDragging = false;
      card.classList.remove("dragging");
      clearDragTargets();
      renderAt(clock?.elapsedMs || state.elapsedMs);
    });
    card.addEventListener("dragover", event => { event.preventDefault(); event.stopPropagation(); card.classList.add("drag-target"); });
    card.addEventListener("dragleave", () => card.classList.remove("drag-target"));
    card.addEventListener("drop", event => {
      event.preventDefault(); event.stopPropagation();
      handlePlayerDrop(event.dataTransfer.getData("text/player-id"), card.dataset.playerId);
    });
    card.addEventListener("click", () => selectPlayer(card.dataset.playerId));
    card.addEventListener("pointerdown", startPointerDrag);
  }
  const field = $("#field"), bench = $("#bench"), unavailable = $("#unavailable"), emptySlots = [...document.querySelectorAll(".empty-field-slot[data-position]")];
  for (const slot of emptySlots) {
    slot.addEventListener("dragover", event => { event.preventDefault(); event.stopPropagation(); slot.classList.add("drag-target"); });
    slot.addEventListener("dragleave", () => slot.classList.remove("drag-target"));
    slot.addEventListener("drop", event => { event.preventDefault(); event.stopPropagation(); handlePositionDrop(event.dataTransfer.getData("text/player-id"), slot.dataset.position); });
    slot.addEventListener("click", () => { if (selectedPlayerId) handlePositionDrop(selectedPlayerId, slot.dataset.position); });
  }
  field.ondragover = event => { event.preventDefault(); field.classList.add("drag-target"); };
  field.ondragleave = event => { if (!field.contains(event.relatedTarget)) field.classList.remove("drag-target"); };
  field.ondrop = event => { event.preventDefault(); clearDragTargets(); };
  bench.ondragover = event => { event.preventDefault(); bench.classList.add("drag-target"); };
  bench.ondragleave = event => { if (!bench.contains(event.relatedTarget)) bench.classList.remove("drag-target"); };
  bench.ondrop = event => { event.preventDefault(); clearDragTargets(); moveToBench(event.dataTransfer.getData("text/player-id")); };
  unavailable.ondragover = event => { event.preventDefault(); event.stopPropagation(); unavailable.classList.add("drag-target"); };
  unavailable.ondragleave = event => { event.stopPropagation(); if (!unavailable.contains(event.relatedTarget)) unavailable.classList.remove("drag-target"); };
  unavailable.ondrop = event => { event.preventDefault(); event.stopPropagation(); clearDragTargets(); markUnavailable(event.dataTransfer.getData("text/player-id")); };
}

async function handlePositionDrop(playerId, position) {
  if (!playerId || !position || state.field[position] === playerId) return;
  selectedPlayerId = null;
  const onField = Object.values(state.field).includes(playerId);
  if (onField || state.fieldCount < state.config.playersOnField) await movePlayer(playerId, position);
}

function selectPlayer(playerId) {
  if (Date.now() < suppressClickUntil) return;
  openPlayerMenu(playerId);
}

async function handlePlayerDrop(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  selectedPlayerId = null;
  const sourceOnField = Object.values(state.field).includes(sourceId);
  const targetOnField = Object.values(state.field).includes(targetId);
  const sourceUnavailable = state.unavailable?.some(player => player.playerId === sourceId);
  const targetUnavailable = state.unavailable?.some(player => player.playerId === targetId);
  if (sourceUnavailable && !targetOnField && !targetUnavailable) {
    await movePlayer(sourceId, "off_field");
    return;
  }
  if (!sourceUnavailable && targetUnavailable) {
    await movePlayer(sourceId, "not_here");
    return;
  }
  if (sourceOnField && targetOnField) {
    await movePlayers([
      { playerId: sourceId, from: playerLocation(sourceId), to: playerLocation(targetId) },
      { playerId: targetId, from: playerLocation(targetId), to: playerLocation(sourceId) }
    ]);
    return;
  }
  if (sourceOnField && !targetOnField) {
    await movePlayer(sourceId, "off_field");
    return;
  }
  if (!sourceOnField && targetOnField) {
    const playerOutId = targetId;
    const playerInId = sourceId;
    const position = Object.keys(state.field).find(pos => state.field[pos] === playerOutId);
    await movePlayers([
      { playerId: playerOutId, from: position, to: "off_field" },
      { playerId: playerInId, from: playerLocation(playerInId), to: position }
    ]);
  }
}

function enterFromBench(playerId) {
  if (!playerId || Object.values(state.field).includes(playerId) || state.fieldCount >= state.config.playersOnField) return;
  const free = activePositions().filter(position => !state.field[position]);
  openDialog("Place on field", `<div class="dialog-fields"><p><strong>${escapeHtml(nameOf(playerId))}</strong></p><label>Position<select name="position">${optionList(free)}</select></label></div>`, async data => {
    selectedPlayerId = null;
    await movePlayer(playerId, data.get("position"));
  });
}

async function leaveForBench(playerId) {
  if (!playerId || !Object.values(state.field).includes(playerId)) return;
  selectedPlayerId = null;
  await movePlayer(playerId, "off_field");
}

async function moveToBench(playerId) {
  if (!playerId) return;
  if (state.unavailable?.some(player => player.playerId === playerId)) {
    await movePlayer(playerId, "off_field");
    return;
  }
  await leaveForBench(playerId);
}

async function markUnavailable(playerId) {
  if (!playerId || state.unavailable?.some(player => player.playerId === playerId)) return;
  selectedPlayerId = null;
  await movePlayer(playerId, "not_here");
}

function playerLocation(playerId) {
  return Object.keys(state.field).find(position => state.field[position] === playerId)
    || (state.unavailable?.some(player => player.playerId === playerId) ? "not_here" : "off_field");
}

async function movePlayer(playerId, to) {
  if (!playerId || !to) return;
  const from = playerLocation(playerId);
  if (from === to) return;
  await movePlayers([{ playerId, from, to }]);
}

async function movePlayers(moves) {
  if (!moves.length) return;
  await append("player_moved", clock.elapsedMs, { moves });
}

function startPointerDrag(event) {
  if (event.pointerType === "mouse") return;
  const card = event.currentTarget;
  pointerDrag = { playerId: card.dataset.playerId, card, x: event.clientX, y: event.clientY, active: false, pointerId: event.pointerId };
  card.setPointerCapture(event.pointerId);
  card.addEventListener("pointermove", movePointerDrag);
  card.addEventListener("pointerup", finishPointerDrag, { once: true });
  card.addEventListener("pointercancel", cancelPointerDrag, { once: true });
}

function movePointerDrag(event) {
  if (!pointerDrag) return;
  const distance = Math.hypot(event.clientX - pointerDrag.x, event.clientY - pointerDrag.y);
  if (!pointerDrag.active && distance < 8) return;
  event.preventDefault();
  if (!pointerDrag.active) {
    pointerDrag.active = true;
    pointerDrag.ghost = pointerDrag.card.cloneNode(true);
    pointerDrag.ghost.classList.add("drag-ghost");
    document.body.append(pointerDrag.ghost);
    pointerDrag.card.classList.add("dragging");
  }
  pointerDrag.lastX = event.clientX; pointerDrag.lastY = event.clientY;
  pointerDrag.ghost.style.transform = `translate(${event.clientX + 12}px,${event.clientY + 12}px)`;
}

function finishPointerDrag(event) {
  if (!pointerDrag) return;
  const drag = pointerDrag;
  const wasActive = drag.active;
  const target = wasActive ? document.elementFromPoint(event.clientX, event.clientY) : null;
  cleanupPointerDrag();
  if (!wasActive) return;
  suppressClickUntil = Date.now() + 400;
  const playerTarget = target?.closest("[data-player-id]");
  if (playerTarget) handlePlayerDrop(drag.playerId, playerTarget.dataset.playerId);
  else if (target?.closest(".empty-field-slot")) handlePositionDrop(drag.playerId, target.closest(".empty-field-slot").dataset.position);
  else if (target?.closest("#unavailable")) markUnavailable(drag.playerId);
  else if (target?.closest("#bench")) moveToBench(drag.playerId);
  else renderAt(clock?.elapsedMs || state.elapsedMs);
}

function cancelPointerDrag() { cleanupPointerDrag(); renderAt(clock?.elapsedMs || state.elapsedMs); }
function cleanupPointerDrag() {
  if (!pointerDrag) return;
  pointerDrag.card.classList.remove("dragging");
  pointerDrag.card.removeEventListener("pointermove", movePointerDrag);
  pointerDrag.ghost?.remove();
  pointerDrag = null;
  clearDragTargets();
}
function clearDragTargets() { document.querySelectorAll(".drag-target").forEach(element => element.classList.remove("drag-target")); }

async function toggleClock() {
  if (state.completed) return;
  if (!state.currentPeriod) {
    await append("period_started", clock.elapsedMs, { period: 1 }); startClock(); return;
  }
  if (isBetweenPeriods()) {
    const period = state.currentPeriod + 1;
    if (period <= state.config.periodCount) { await append("period_started", clock.elapsedMs, { period }); startClock(); }
    return;
  }
  if (clock.running) { clock.pause(); await append("clock_paused", clock.elapsedMs); }
  else { await append("clock_resumed", clock.elapsedMs); startClock(); }
}

function openClockAdjust() {
  const current = displayedGameTime(events, clock?.elapsedMs || 0);
  openDialog("Set game time", `<div class="dialog-fields"><label>Displayed game time (MM:SS)<input name="displayTime" inputmode="numeric" value="${formatClock(current)}" required autofocus></label><p class="hint">This changes only the displayed game clock. Player time and event logs keep their original tracking time.</p></div>`, async data => {
    const displayTimeMs = parseClock(data.get("displayTime"));
    if (displayTimeMs === null) throw new Error("Enter time as minutes:seconds.");
    await append("clock_adjusted", clock?.elapsedMs || 0, { displayTimeMs }, false);
  });
}

function startClock() { clock.start(); renderAt(clock.elapsedMs); }

async function recordSimple(type) {
  if (state.completed) return;
  await append(type);
}

function openGoalFor(preselectedPlayerId = "") {
  if (state.completed) return openMessage("Match complete", "Reopen or correct the match timeline to change the final score.");
  const { onField, offField } = orderedScorerGroups(state.field, state.bench);
  const shirt = (playerId, detail) => {
    const name = nameOf(playerId);
    return `<button type="button" class="goal-scorer ${playerId === preselectedPlayerId ? "selected" : ""}" data-scorer-id="${escapeHtml(playerId)}"><span class="shirt-icon">${escapeHtml(shortPlayerName(name))}</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></button>`;
  };
  const onFieldShirts = onField.map(playerId => { const position = Object.keys(state.field).find(item => state.field[item] === playerId); return shirt(playerId, shortPosition(position)); }).join("");
  const offFieldShirts = offField.map(playerId => shirt(playerId, "Off field")).join("");
  const unknown = `<button type="button" class="goal-scorer unknown-scorer" data-scorer-id=""><span class="shirt-icon">?</span><strong>Unknown</strong><small>No player</small></button>`;
  const body = `<div class="goal-scorer-list"><section class="goal-scorer-group"><h3>On field</h3><div class="goal-scorer-grid">${onFieldShirts}${unknown}</div></section>${offFieldShirts ? `<section class="goal-scorer-group"><h3>Off field</h3><div class="goal-scorer-grid">${offFieldShirts}</div></section>` : ""}</div>`;
  openDialog("Who scored?", body, null, false);
  $("#dialog-body").onclick = async event => {
    const button = event.target.closest("[data-scorer-id]");
    if (!button) return;
    const scorerId = button.dataset.scorerId || null;
    const goalTimeMs = clock.elapsedMs;
    document.querySelectorAll("[data-scorer-id]").forEach(option => { option.disabled = true; });
    try {
      $("#action-dialog").close();
      if (scorerId) openGoalAssist(scorerId, goalTimeMs);
      else await append("goal_for", goalTimeMs);
    } catch (error) {
      $("#dialog-error").textContent = error.message;
      document.querySelectorAll("[data-scorer-id]").forEach(option => { option.disabled = false; });
    }
  };
}

function openGoalAssist(scorerId, goalTimeMs = clock.elapsedMs) {
  const { onField } = orderedScorerGroups(state.field, state.bench);
  const choices = onField.filter(playerId => playerId !== scorerId).map(playerId => {
    const name = nameOf(playerId);
    const position = Object.keys(state.field).find(item => state.field[item] === playerId);
    return `<button type="button" class="goal-scorer" data-assist-id="${escapeHtml(playerId)}"><span class="shirt-icon">${escapeHtml(shortPlayerName(name))}</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(shortPosition(position))}</small></button>`;
  }).join("");
  const noAssist = `<button type="button" class="goal-scorer unknown-scorer" data-assist-id=""><span class="shirt-icon">–</span><strong>No assist</strong><small>Unassisted</small></button>`;
  openDialog("Who assisted?", `<div class="goal-scorer-list"><section class="goal-scorer-group"><div class="goal-scorer-grid">${choices}${noAssist}</div></section></div>`, null, false);
  $("#dialog-body").onclick = async event => {
    const button = event.target.closest("[data-assist-id]");
    if (!button) return;
    document.querySelectorAll("[data-assist-id]").forEach(option => { option.disabled = true; });
    try {
      const assistId = button.dataset.assistId || null;
      await append("goal_for", goalTimeMs, { playerId: scorerId }, !assistId);
      if (assistId) await append("assist_for", goalTimeMs, { playerId: assistId });
      $("#action-dialog").close();
    } catch (error) {
      $("#dialog-error").textContent = error.message;
      document.querySelectorAll("[data-assist-id]").forEach(option => { option.disabled = false; });
    }
  };
}

function showActionError(error) { openMessage("Could not save", error?.message || "Try again."); }

function openPlayerMenu(playerId) {
  const onField = Object.values(state.field).includes(playerId);
  const unavailable = state.unavailable?.some(player => player.playerId === playerId);
  let actions = "";
  if (onField && !state.completed) actions += `<button type="button" class="primary" data-player-action="goal">⚽ Goal by ${escapeHtml(nameOf(playerId))}</button><button type="button" class="secondary" data-player-action="off">Move off field</button>`;
  else if (unavailable) actions += `<button type="button" class="secondary" data-player-action="restore">Move to off field</button>`;
  else actions += `<button type="button" class="secondary" data-player-action="absent">Move to not here</button>`;
  actions += `<button type="button" class="secondary danger-action" data-player-action="delete">Delete player</button>`;
  openDialog(nameOf(playerId), `<div class="dialog-fields action-list">${actions}</div>`, null, false);
  document.querySelectorAll("[data-player-action]").forEach(button => button.addEventListener("click", async () => {
    $("#action-dialog").close();
    if (button.dataset.playerAction === "goal") openGoalAssist(playerId);
    if (button.dataset.playerAction === "off") await leaveForBench(playerId);
    if (button.dataset.playerAction === "restore") await moveToBench(playerId);
    if (button.dataset.playerAction === "absent") await markUnavailable(playerId);
    if (button.dataset.playerAction === "delete") openDeletePlayer(playerId);
  }));
}

function openDeletePlayer(playerId) {
  const playerName = nameOf(playerId);
  openDialog("Delete player?", `<p>Remove <strong>${escapeHtml(playerName)}</strong> from this match and the team roster? Their recorded match history will be kept.</p>`, async () => {
    await append("player_removed", clock.elapsedMs, { playerId }, false);
    team.players = team.players.filter(player => player.playerId !== playerId);
    await persistTeams();
    setSaveStatus("Player deleted");
  });
}

function openMoreActions() {
  const halfTime = state.currentPeriod === 1 && !isBetweenPeriods() && !state.completed ? `<button type="button" class="secondary" data-action="period">Mark half time</button>` : "";
  openDialog("More", `<div class="dialog-fields action-list"><button type="button" class="secondary" data-action="undo">Undo last action</button>${halfTime}<button type="button" class="secondary" data-action="add-team">+ Add new team</button><button type="button" class="secondary danger-action" data-action="delete">Delete match</button></div>`, null, false);
  document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => {
    $("#action-dialog").close(); ({ undo: undoLatest, period: endPeriod, "add-team": addTeamFromMatch, delete: openDeleteMatch })[button.dataset.action]();
  }));
}

async function addTeamFromMatch() {
  await returnToTeam();
  openAddTeam();
}

function openDeleteMatch() {
  const opponent = state.config?.opponent || "this opponent";
  openDialog("Delete match?", `<p>Permanently delete the match against <strong>${escapeHtml(opponent)}</strong>? The team and player roster will be kept.</p>`, async () => {
    clock?.destroy();
    await store.deleteMatch(matchId);
    events = []; matchId = null; clock = null; state = projector.empty(); selectedPlayerId = null;
    document.body.classList.remove("match-open");
    $("#match-view").classList.add("hidden");
    $("#setup-view").classList.remove("hidden");
    $("#team-dashboard").classList.remove("hidden");
    $("#season-analysis-panel").classList.add("hidden");
    await renderTeamDashboard();
    setSaveStatus("Match deleted");
  });
}

async function returnToTeam() {
  clock?.destroy();
  document.body.classList.remove("match-open");
  $("#match-view").classList.add("hidden");
  $("#setup-view").classList.remove("hidden");
  $("#team-dashboard").classList.remove("hidden");
  $("#season-analysis-panel").classList.add("hidden");
  await renderTeamDashboard();
}

async function endPeriod() {
  if (!state.currentPeriod || isBetweenPeriods()) return;
  clock.pause(); await append("period_ended", clock.elapsedMs, { period: state.currentPeriod });
}

function openNote() {
  openDialog("Add match note", `<div class="dialog-fields"><label>Type<select name="category"><option>Note</option><option>Injury</option><option>Yellow card</option><option>Red card</option><option>Unusual event</option></select></label><label>Details<textarea name="note" required></textarea></label></div>`, async data => append("note_added", clock.elapsedMs, { category: data.get("category"), note: data.get("note") }));
}

async function undoLatest() {
  const protectedTypes = new Set(["match_created", "starting_lineup_confirmed"]);
  const target = activeTimeline(events).filter(event => !protectedTypes.has(event.type)).at(-1);
  if (!target) return;
  await append("event_retracted", clock.elapsedMs, { targetEventId: target.eventId }, false);
  if (state.periodRunning && !clock.running) clock.start();
  if (!state.periodRunning && clock.running) clock.pause();
  $("#undo-toast").classList.add("hidden");
}

function renderTimeline() {
  const active = activeTimeline(events);
  $("#timeline").innerHTML = [...active].reverse().map(event => `<article class="timeline-event"><time>${formatClock(displayedGameTime(events, event.gameTimeMs, event.sequence))}</time><div><strong>${escapeHtml(eventLabel(event))}</strong><small>${escapeHtml(eventDetail(event))}${event.correctedBy ? " · corrected" : ""}</small></div>${["match_created", "starting_lineup_confirmed"].includes(event.type) ? "" : `<div class="timeline-actions"><button class="text-button" data-edit="${event.eventId}">Edit</button><button class="text-button delete-event" data-delete-event="${event.eventId}" aria-label="Delete ${escapeHtml(eventTypeName(event.type))}" title="Delete">×</button></div>`}</article>`).join("");
  document.querySelectorAll("[data-edit]").forEach(button => button.addEventListener("click", () => openTimelineEdit(button.dataset.edit)));
  document.querySelectorAll("[data-delete-event]").forEach(button => button.addEventListener("click", () => openTimelineDelete(button.dataset.deleteEvent)));
}

function openTimelineDelete(eventId) {
  const timeline = activeTimeline(events);
  const event = timeline.find(item => item.eventId === eventId);
  if (!event) return;
  const linkedAssist = event.type === "goal_for" ? timeline.find(item => item.type === "assist_for" && item.gameTimeMs === event.gameTimeMs && item.sequence > event.sequence && !timeline.some(other => ["goal_for", "goal_against"].includes(other.type) && other.sequence > event.sequence && other.sequence < item.sequence)) : null;
  const detail = linkedAssist ? " Its linked assist will also be deleted." : "";
  openDialog("Delete event?", `<p>Delete <strong>${escapeHtml(eventLabel(event))}</strong> at ${formatClock(event.gameTimeMs)}?${detail}</p>`, async () => {
    await append("event_retracted", clock.elapsedMs, { targetEventId: event.eventId }, false);
    if (linkedAssist) await append("event_retracted", clock.elapsedMs, { targetEventId: linkedAssist.eventId }, false);
    setSaveStatus("Event deleted");
  });
}

const MANUAL_TIMELINE_TYPES = ["goal_for", "assist_for", "goal_against", "player_moved", "clock_adjusted", "note_added"];

function openTimelineEdit(eventId) {
  const event = activeTimeline(events).find(item => item.eventId === eventId);
  if (event) openTimelineEventEditor(event);
}

function openTimelineAdd() { openTimelineEventEditor(null); }

function openTimelineEventEditor(event) {
  const playerIds = Object.values(state.players).filter(Boolean).map(player => player.playerId);
  const types = event && !MANUAL_TIMELINE_TYPES.includes(event.type) ? [event.type, ...MANUAL_TIMELINE_TYPES] : MANUAL_TIMELINE_TYPES;
  const initialType = event?.type || "goal_for";
  const initialTime = event?.gameTimeMs ?? clock.elapsedMs;
  openDialog(event ? eventTypeName(event.type) : "Add event", `<div class="dialog-fields"><label>Event<select id="timeline-event-type" name="eventType">${eventTypeOptions(types, initialType)}</select></label><div id="timeline-event-fields"></div><label>Tracking time (MM:SS)<input name="time" value="${formatClock(initialTime)}" required></label></div>`, async data => {
    const gameTimeMs = parseClock(data.get("time"));
    if (gameTimeMs === null) throw new Error("Enter time as minutes:seconds.");
    const type = data.get("eventType");
    const payload = timelineEventPayload(type, data, event?.payload || {});
    if (event) await append("event_replaced", clock.elapsedMs, { targetEventId: event.eventId, replacement: { type, gameTimeMs, payload, timeSource: "manual" } }, false, "manual");
    else await append(type, gameTimeMs, payload, false, "manual");
  });
  const typeSelect = $("#timeline-event-type");
  const renderFields = () => { $("#timeline-event-fields").innerHTML = timelineEventFields(typeSelect.value, event, playerIds); };
  typeSelect.addEventListener("change", renderFields);
  renderFields();
}

function timelineEventFields(type, event, playerIds) {
  const p = event?.payload || {};
  const move = p.moves?.[0] || {};
  const selectedPlayer = p.playerId || move.playerId || playerIds[0];
  const playerSelect = (name = "playerId", selected = selectedPlayer, label = "Player name", unknown = false) => `<label>${label}<select name="${name}">${unknown && !selected ? '<option value="">Unknown</option>' : ''}${playerOptions(playerIds, selected)}${unknown && selected ? '<option value="">Unknown</option>' : ''}</select></label>`;
  if (type === "goal_for") return playerSelect("playerId", p.playerId, "Player name", true);
  if (type === "assist_for") return playerSelect("playerId", p.playerId, "Player name");
  if (type === "goal_against") return "";
  if (type === "clock_adjusted") return `<label>Displayed game time (MM:SS)<input name="displayTime" inputmode="numeric" value="${formatClock(p.displayTimeMs ?? event?.gameTimeMs ?? 0)}" required></label>`;
  if (type === "player_moved") {
    const playerId = move.playerId || selectedPlayer;
    const from = move.from || playerLocation(playerId);
    const to = move.to || "off_field";
    return `${playerSelect("playerId", playerId)}<input type="hidden" name="from" value="${escapeHtml(from)}"><label>Destination<select name="to">${moveDestinationOptions(to)}</select></label>`;
  }
  if (type === "note_added") return `<label>Category<select name="category">${optionList(["Note", "Injury", "Yellow card", "Red card", "Unusual event"], p.category)}</select></label><label>Details<textarea name="note">${escapeHtml(p.note || "")}</textarea></label>`;
  return "";
}

function timelineEventPayload(type, data, existing) {
  const requirePlayer = name => { const value = data.get(name); if (!value) throw new Error("Choose a player."); return value; };
  if (type === "goal_for") { const playerId = data.get("playerId") || null; return playerId ? { playerId } : {}; }
  if (type === "assist_for") return { playerId: requirePlayer("playerId") };
  if (type === "goal_against") return {};
  if (type === "clock_adjusted") { const displayTimeMs = parseClock(data.get("displayTime")); if (displayTimeMs === null) throw new Error("Enter displayed time as minutes:seconds."); return { displayTimeMs }; }
  if (type === "player_moved") return { moves: [{ playerId: requirePlayer("playerId"), from: data.get("from") || "off_field", to: data.get("to") }] };
  if (type === "note_added") { const note = String(data.get("note") || "").trim(); if (!note) throw new Error("Enter note details."); return { category: data.get("category"), note }; }
  return structuredClone(existing);
}

function renderReportDetails() {
  const matchMs = state.config.periodCount * state.config.periodMinutes * 60_000;
  const timeline = activeTimeline(events);
  const goals = timeline.filter(event => ["goal_for", "goal_against"].includes(event.type));
  $("#goal-lineups").innerHTML = goals.map(goal => {
    const eventsThroughGoal = timeline.filter(event => event.gameTimeMs < goal.gameTimeMs || (event.gameTimeMs === goal.gameTimeMs && event.sequence <= goal.sequence));
    const atGoal = projector.project(eventsThroughGoal, goal.gameTimeMs);
    const players = Object.entries(atGoal.field).map(([position, id]) => `${atGoal.players[id].name} · ${shortPosition(position)}`).join(", ");
    const scorer = goal.type === "goal_for" && goal.payload.playerId ? atGoal.players[goal.payload.playerId]?.name : null;
    const nextGoalSequence = goals.find(item => item.sequence > goal.sequence)?.sequence ?? Infinity;
    const assistEvent = goal.type === "goal_for" ? timeline.find(item => item.type === "assist_for" && item.gameTimeMs === goal.gameTimeMs && item.sequence > goal.sequence && item.sequence < nextGoalSequence) : null;
    const assist = assistEvent?.payload.playerId ? atGoal.players[assistEvent.payload.playerId]?.name : null;
    return `<article class="goal-lineup"><span class="goal-icon ${goal.type}">${goal.type === "goal_for" ? "+" : "-"}</span><div><strong>${goal.type === "goal_for" ? "Goal for" : "Goal against"} · ${formatClock(displayedGameTime(events, goal.gameTimeMs, goal.sequence))}${scorer ? ` · ${escapeHtml(scorer)} scored` : ""}${assist ? ` · ${escapeHtml(assist)} assisted` : ""}</strong><small>${escapeHtml(players || "No players recorded on field")}</small></div></article>`;
  }).join("") || "<p class='hint'>Score events will show the exact on-field players here.</p>";
  $("#minutes-report").innerHTML = Object.values(state.players).sort((a, b) => b.totalMs - a.totalMs).map(p => `<article class="minute-card"><div class="minute-top"><strong>${escapeHtml(p.name)}</strong><strong>${formatMinutes(p.totalMs)}</strong></div><div class="bar"><span style="width:${Math.min(100, p.totalMs / matchMs * 100)}%"></span></div><small>${Object.entries(p.positionMs).map(([pos, ms]) => `${escapeHtml(positionName(pos))} ${formatMinutes(ms)}`).join(" · ") || "No field time yet"}${p.goalkeeperMs ? ` · GK ${formatMinutes(p.goalkeeperMs)}` : ""}</small></article>`).join("");
  $("#stints-report").innerHTML = state.stints.map(stint => `<div class="stint-row"><strong>${formatClock(stint.startMs)}–${formatClock(stint.endMs)}</strong><span>${stint.goalsFor}–${stint.goalsAgainst}</span><span>${Object.entries(stint.field).map(([pos, id]) => `${nameOf(id)} (${shortPosition(pos)})`).join(", ")}</span></div>`).join("") || "<p class='hint'>Stints appear after the clock advances.</p>";
}

function renderReport() {
  renderReportDetails();
  document.querySelectorAll("#goal-lineups .goal-lineup small").forEach(lineup => lineup.remove());
  const emptyMessage = $("#goal-lineups .hint");
  if (emptyMessage) emptyMessage.textContent = "Goals will appear here.";
}

function switchTab(view) {
  document.querySelectorAll(".tab").forEach(tab => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active);
  });
  ["live", "timeline", "report"].forEach(name => $("#" + name + "-panel").classList.toggle("hidden", name !== view));
  $("#field-scoreboard").classList.toggle("hidden", view !== "live");
  $("#compact-scoreboard").classList.toggle("hidden", view === "live");
  if (view === "timeline") renderTimeline(); if (view === "report") renderReport();
}

function openDialog(title, body, handler, showConfirm = true, closeOnConfirm = true) {
  const dialog = $("#action-dialog"), form = $("#action-form"), confirm = $("#dialog-confirm");
  $("#dialog-title").textContent = title; $("#dialog-body").onclick = null; $("#dialog-body").innerHTML = body; $("#dialog-error").textContent = "";
  confirm.textContent = "Confirm";
  confirm.classList.toggle("hidden", !showConfirm);
  confirm.onclick = async event => {
    event.preventDefault();
    try { if (handler) await handler(new FormData(form)); if (closeOnConfirm) dialog.close(); }
    catch (error) { $("#dialog-error").textContent = error.message; }
  };
  form.onsubmit = event => { event.preventDefault(); confirm.click(); };
  form.querySelectorAll('[value="cancel"]').forEach(button => { button.onclick = () => dialog.close(); });
  dialog.showModal();
}

function openMessage(title, message) { openDialog(title, `<p>${escapeHtml(message)}</p>`, () => {}); }
function showUndo(label) { clearTimeout(toastTimer); $("#undo-label").textContent = label; $("#undo-toast").classList.remove("hidden"); toastTimer = setTimeout(() => $("#undo-toast").classList.add("hidden"), 6000); }
function setSaveStatus(text, error = false) { $("#save-status").textContent = text; $("#save-status").style.color = error ? "#ff7068" : ""; }
function nameOf(id) { return state.players[id]?.name || state.config?.roster.find(p => p.playerId === id)?.name || "Unknown"; }
function shortPlayerName(name) { return Array.from(String(name || "").trim().split(/\s+/)[0] || "?").slice(0, 3).join("").toUpperCase(); }
function playerOptions(ids, selected) { const ordered = selected && ids.includes(selected) ? [selected, ...ids.filter(id => id !== selected)] : ids; return ordered.map(id => `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(nameOf(id))}</option>`).join(""); }
function optionList(values, selected) { return values.map(value => `<option ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join(""); }
function moveDestinationName(value) { return ({ off_field: "Off field", not_here: "Not here" })[value] || positionName(value); }
function moveDestinationOptions(selected) { const positions = [...activePositions(), ...(!["off_field", "not_here"].includes(selected) && !activePositions().includes(selected) ? [selected] : [])]; return ["off_field", "not_here", ...positions].map(value => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(moveDestinationName(value))}</option>`).join(""); }
function eventTypeName(type) { return ({ goal_for: "Goal for", assist_for: "Assist for", goal_against: "Goal against", player_moved: "Player moved", note_added: "Note", clock_adjusted: "Game time changed", clock_paused: "Clock stopped", clock_resumed: "Clock started", period_started: "Half started", period_ended: "Half time", match_completed: "Game ended" })[type] || type.replaceAll("_", " "); }
function eventTypeOptions(types, selected) { return types.map(type => `<option value="${type}" ${type === selected ? "selected" : ""}>${escapeHtml(eventTypeName(type))}</option>`).join(""); }
function formatClock(ms) { const total = Math.floor(ms / 1000); return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function formatMinutes(ms) { return `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`; }
function parseClock(value) { const match = String(value).match(/^(\d+):([0-5]\d)$/); return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : null; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]); }
function normalizeTeamPlayers(players) {
  const seen = new Set();
  return (Array.isArray(players) ? players : []).filter(player => player?.name).map(player => {
    const name = String(player.name).trim();
    return { ...player, playerId: playerIdFromName(name), name };
  }).filter(player => {
    const key = player.playerId.toLocaleLowerCase();
    if (!player.playerId || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function normalizeTeams(value) {
  return (Array.isArray(value) ? value : []).filter(item => item?.name).map(item => ({
    ...item,
    teamId: item.teamId || createId(),
    name: String(item.name).trim(),
    players: normalizeTeamPlayers(item.players)
  })).filter(item => item.name);
}
function positionName(position) { return ({ gk: "Goalkeeper", forward_striker: "Striker", forward_left: "Left forward", forward_right: "Right forward", forward_left_wing: "Left wing", forward_right_wing: "Right wing", mid_left: "Left midfield", mid_left_center: "Left center midfield", mid_center: "Center midfield", mid_right_center: "Right center midfield", mid_right: "Right midfield", back_left_fullback: "Left fullback", back_left_center: "Left center back", back_center: "Center back", back_right_center: "Right center back", back_right_fullback: "Right fullback" })[position] || position || "Unknown"; }
function shortPosition(position) { return ({ gk: "GK", forward_striker: "ST", forward_left: "LF", forward_right: "RF", forward_left_wing: "LW", forward_right_wing: "RW", mid_left: "LM", mid_left_center: "LCM", mid_center: "CM", mid_right_center: "RCM", mid_right: "RM", back_left_fullback: "LB", back_left_center: "LCB", back_center: "CB", back_right_center: "RCB", back_right_fullback: "RB" })[position] || position; }
function formationLine(role, count) {
  const lines = {
    defense: { 0: [], 1: ["back_center"], 2: ["back_left_fullback", "back_right_fullback"], 3: ["back_left_fullback", "back_center", "back_right_fullback"], 4: ["back_left_fullback", "back_left_center", "back_right_center", "back_right_fullback"] },
    midfield: { 0: [], 1: ["mid_center"], 2: ["mid_left", "mid_right"], 3: ["mid_left", "mid_center", "mid_right"], 4: ["mid_left", "mid_left_center", "mid_right_center", "mid_right"], 5: ["mid_left", "mid_left_center", "mid_center", "mid_right_center", "mid_right"] },
    attack: { 0: [], 1: ["forward_striker"], 2: ["forward_left", "forward_right"], 3: ["forward_left_wing", "forward_striker", "forward_right_wing"] }
  };
  return lines[role][count] || [];
}
function formationPositions([defenders, midfielders, attackers]) { return [...formationLine("attack", attackers), ...formationLine("midfield", midfielders), ...formationLine("defense", defenders), "gk"]; }
function activePositions() { return state.config?.positions || defaults[state.config?.playersOnField] || POSITIONS.slice(0, state.config?.playersOnField || 0); }
function positionBand(position) {
  if (position === "gk") return "keeper";
  if (position.startsWith("forward_")) return "attack";
  if (position.startsWith("mid_attacking_")) return "attacking-mid";
  if (position.startsWith("mid_defensive_")) return "defensive-mid";
  if (position.startsWith("back_")) return "defense";
  if (position.startsWith("utility_")) return "utility";
  return "midfield";
}
function positionColumn(position, rowLength, index) {
  if (rowLength > 3) return index + 1;
  if (position.includes("_left")) return 1;
  if (position.includes("_right")) return 3;
  return 2;
}
function fileBase() { return `coachjd-${state.config.date}-${state.config.opponent.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`; }
function eventLabel(event) {
  const payload = event.payload || {};
  if (event.type === "player_moved") {
    const moves = payload.moves || [];
    return moves.length === 1 ? `${nameOf(moves[0].playerId)} moved to ${moveDestinationName(moves[0].to)}` : `${moves.length} players moved`;
  }
  return ({ match_created: "Match created", starting_lineup_confirmed: "Field started empty", layout_changed: `Layout changed to ${payload.name}`, period_started: `Period ${payload.period} started`, clock_paused: "Clock paused", clock_resumed: "Clock resumed", clock_adjusted: `Game time set to ${formatClock(payload.displayTimeMs)}`, period_ended: `Period ${payload.period} ended`, player_added: payload.player?.playerId ? `${nameOf(payload.player.playerId)} added` : "Player added", player_removed: `${nameOf(payload.playerId)} deleted`, goal_for: payload.playerId ? `Goal by ${nameOf(payload.playerId)}` : "Goal for", assist_for: `Assist by ${nameOf(payload.playerId)}`, goal_against: "Goal against", note_added: payload.category || "Note", match_completed: "Match completed", event_retracted: "Event undone", event_replaced: "Event corrected" })[event.type] || event.type;
}
function eventDetail(event) {
  const p = event.payload || {};
  if (event.type === "player_moved") return (p.moves || []).map(move => `${nameOf(move.playerId)}: ${moveDestinationName(move.from)} → ${moveDestinationName(move.to)}`).join(" · ");
  if (event.type === "note_added") return p.note;
  return new Date(event.realTimestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
