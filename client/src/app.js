import { MatchEvent, activeTimeline, isCorrection } from "./domain/match-event.js";
import { MatchClock } from "./domain/match-clock.js";
import { LineupProjector } from "./domain/lineup-projector.js";
import { EventStore } from "./storage/event-store.js";
import { exportMatchJson, downloadFile } from "./domain/exporter.js";
import { eventPlayerRecord, orderedScorerGroups, playerIdFromName } from "./domain/player-label.js";
import { matchIdsForTeam } from "./domain/team.js";
import { displayedGameTime } from "./domain/game-time.js";
import { mainMenuMatchStatus } from "./domain/match-status.js";
import { createId } from "./domain/id.js";
import { analyzeTeam } from "./domain/analytics.js";
import { recentSubstitutionChanges } from "./domain/substitution-highlight.js";
import { groupLineupStints } from "./domain/lineup-stint.js";
import { BROAD_ROLE_SAMPLE_MS, EXACT_POSITION_SAMPLE_MS, positionGuidanceReadiness, rankPlayerDeployments } from "./domain/position-guidance.js";
import { createSampleDataset, sampleDataOptions } from "./domain/sample-data.js";
import { createFullBackup, mergeEventHistories, parseFullBackup } from "./domain/backup.js";

const FORMATIONS = {
  3: [{ name: "1-1", shape: [1, 0, 1] }],
  4: [{ name: "1-1-1", shape: [1, 1, 1] }, { name: "2-1", shape: [2, 0, 1] }],
  5: [{ name: "2-1-1", shape: [2, 1, 1] }, { name: "1-2-1", shape: [1, 2, 1] }],
  6: [{ name: "2-2-1", shape: [2, 2, 1] }, { name: "3-1-1", shape: [3, 1, 1] }, { name: "2-1-2", shape: [2, 1, 2] }],
  7: [{ name: "2-3-1", shape: [2, 3, 1] }, { name: "3-2-1", shape: [3, 2, 1] }, { name: "2-2-2", shape: [2, 2, 2] }],
  8: [{ name: "3-2-2", shape: [3, 2, 2] }, { name: "2-3-2", shape: [2, 3, 2] }, { name: "3-3-1", shape: [3, 3, 1] }],
  9: [{ name: "3-3-2", shape: [3, 3, 2] }, { name: "2-3-3", shape: [2, 3, 3] }, { name: "3-2-3", shape: [3, 2, 3] }],
  10: [{ name: "3-3-3", shape: [3, 3, 3] }, { name: "4-3-2", shape: [4, 3, 2] }, { name: "3-4-2", shape: [3, 4, 2] }],
  11: [
    { name: "4-3-3", shape: [4, 3, 3] },
    { name: "4-4-2", shape: [4, 4, 2] },
    { name: "3-5-2", shape: [3, 5, 2] },
    { name: "4-2-3-1", shape: [4, 2, 3, 1], lines: [["defense", 4], ["defensive-mid", 2], ["attacking-mid", 3], ["attack", 1]] },
    { name: "4-1-2-3", shape: [4, 1, 2, 3], lines: [["defense", 4], ["defensive-mid", 1], ["midfield", 2], ["attack", 3]] },
    { name: "3-4-1-2", shape: [3, 4, 1, 2], lines: [["defense", 3], ["midfield", 4], ["attacking-mid", 1], ["attack", 2]] },
    { name: "3-4-2-1", shape: [3, 4, 2, 1], lines: [["defense", 3], ["midfield", 4], ["attacking-mid", 2], ["attack", 1]] },
    { name: "4-1-2-1-2", shape: [4, 1, 2, 1, 2], lines: [["defense", 4], ["defensive-mid", 1], ["midfield", 2], ["attacking-mid", 1], ["attack", 2]] }
  ]
};
const defaults = Object.fromEntries(Object.entries(FORMATIONS).map(([size, layouts]) => [size, layoutPositions(layouts[0])]));
const POSITIONS = [...new Set(Object.values(FORMATIONS).flatMap(layouts => layouts.flatMap(layoutPositions)))];
const SILENT_EVENT_TYPES = new Set([
  "player_moved",
  "layout_changed",
  "period_started", "period_ended", "clock_paused", "clock_resumed"
]);
const ANALYSIS_CATEGORY_KEYS = ["team", "impact", "formations", "lines", "positions", "fatigue", "playerTime"];
const ANALYSIS_OUTCOME_METRICS = ["attemptsFor", "attemptsAgainst", "attemptsMargin", "win", "margin"];
const ANALYSIS_REPORT_COUNT = ANALYSIS_OUTCOME_METRICS.length + 2;
const ANALYSIS_OUTCOME_COUNT = ANALYSIS_CATEGORY_KEYS.length * ANALYSIS_OUTCOME_METRICS.length + 2;
const DEMO_ANALYSIS = Object.freeze({
  matches: 8, completedMatches: 8, wins: 5, draws: 1, losses: 2, winRate: .625,
  scoreMargin: 6, goalsFor: 18, goalsAgainst: 12, attemptsFor: 91, attemptsAgainst: 67,
  players: [
    { name: "Alex M.", averageMinutes: 42, appearances: 8, winRate: .75, scoreMargin: 1.1, onFieldMarginPer60: 1.4, winLift: 12, scoreMarginLift: .8, attemptsForPer60: 11.8, attemptsAgainstPer60: 9.4, attemptDifferentialPer60: 2.4 },
    { name: "Jordan K.", averageMinutes: 37, appearances: 7, winRate: .71, scoreMargin: .8, onFieldMarginPer60: .9, winLift: 8, scoreMarginLift: .5, attemptsForPer60: 11.1, attemptsAgainstPer60: 9.5, attemptDifferentialPer60: 1.6 },
    { name: "Sam R.", averageMinutes: 34, appearances: 8, winRate: .63, scoreMargin: .4, onFieldMarginPer60: .4, winLift: 3, scoreMarginLift: .2, attemptsForPer60: 10.4, attemptsAgainstPer60: 9.7, attemptDifferentialPer60: .7 },
    { name: "Casey T.", averageMinutes: 31, appearances: 6, winRate: .50, scoreMargin: -.2, onFieldMarginPer60: -.5, winLift: -4, scoreMarginLift: -.3, attemptsForPer60: 9.2, attemptsAgainstPer60: 10.0, attemptDifferentialPer60: -.8 },
    { name: "Taylor B.", averageMinutes: 29, appearances: 7, winRate: .43, scoreMargin: -.5, onFieldMarginPer60: -.8, winLift: -9, scoreMarginLift: -.6, attemptsForPer60: 8.8, attemptsAgainstPer60: 10.5, attemptDifferentialPer60: -1.7 }
  ],
  positions: [
    { position: "forward_striker", minutesMs: 311 * 60_000, marginPer60: 1.2, attemptDifferentialPer60: 3.1 },
    { position: "mid_center", minutesMs: 348 * 60_000, marginPer60: .7, attemptDifferentialPer60: 1.8 },
    { position: "back_center", minutesMs: 362 * 60_000, marginPer60: .2, attemptDifferentialPer60: .6 },
    { position: "gk", minutesMs: 400 * 60_000, marginPer60: -.1, attemptDifferentialPer60: -.3 }
  ],
  lineups: [
    { label: "Alex · Jordan · Riley +2", minutesMs: 96 * 60_000, winRate: .75, scoreMargin: 1.1, attemptsForPer60: 13.2, attemptsAgainstPer60: 7.8 },
    { label: "Alex · Sam · Morgan +2", minutesMs: 82 * 60_000, winRate: .67, scoreMargin: .7, attemptsForPer60: 11.6, attemptsAgainstPer60: 8.9 },
    { label: "Jordan · Riley · Casey +2", minutesMs: 74 * 60_000, winRate: .60, scoreMargin: .3, attemptsForPer60: 10.4, attemptsAgainstPer60: 9.5 },
    { label: "Sam · Casey · Taylor +2", minutesMs: 61 * 60_000, winRate: .43, scoreMargin: -.5, attemptsForPer60: 8.7, attemptsAgainstPer60: 11.4 }
  ],
  formations: [
    { name: "2-2-1", minutesMs: 184 * 60_000, winRateLift: 10, scoreMarginLift: .8, attemptsForEffect: 2.6, attemptsAgainstEffect: -1.4 },
    { name: "3-1-1", minutesMs: 142 * 60_000, winRateLift: 3, scoreMarginLift: .2, attemptsForEffect: .7, attemptsAgainstEffect: -.8 },
    { name: "2-1-2", minutesMs: 96 * 60_000, winRateLift: -6, scoreMarginLift: -.5, attemptsForEffect: 1.4, attemptsAgainstEffect: 2.1 }
  ],
  timing: [
    { label: "First 15 played", winRate: .69, marginPer60: 1.4, attemptsForPer60: 12.4, attemptsAgainstPer60: 8.2, attemptDifferentialPer60: 4.2 },
    { label: "Next 15 played", winRate: .63, marginPer60: .6, attemptsForPer60: 10.8, attemptsAgainstPer60: 9.1, attemptDifferentialPer60: 1.7 },
    { label: "After 30 played", winRate: .48, marginPer60: -.4, attemptsForPer60: 8.9, attemptsAgainstPer60: 11.2, attemptDifferentialPer60: -2.3 }
  ],
  playerPositions: [
    { name: "Jordan K.", position: "mid_center", minutesMs: 214 * 60_000, winRateLift: 9, scoreMarginLift: .6, attemptsForEffect: 2.9, attemptsAgainstEffect: -.8 },
    { name: "Alex M.", position: "forward_striker", minutesMs: 196 * 60_000, winRateLift: 7, scoreMarginLift: .5, attemptsForEffect: 2.2, attemptsAgainstEffect: .3 },
    { name: "Riley S.", position: "back_center", minutesMs: 219 * 60_000, winRateLift: 5, scoreMarginLift: .4, attemptsForEffect: .6, attemptsAgainstEffect: -2.0 },
    { name: "Morgan P.", position: "gk", minutesMs: 238 * 60_000, winRateLift: 3, scoreMarginLift: .2, attemptsForEffect: -.2, attemptsAgainstEffect: -2.4 },
    { name: "Casey T.", position: "mid_left", minutesMs: 144 * 60_000, winRateLift: -6, scoreMarginLift: -.4, attemptsForEffect: -.8, attemptsAgainstEffect: 1.1 }
  ],
  playerLines: [
    { name: "Jordan K.", line: "Midfield", minutesMs: 286 * 60_000, winRateLift: 9, scoreMarginLift: .6, attemptsForEffect: 2.5, attemptsAgainstEffect: -.7 },
    { name: "Alex M.", line: "Forward", minutesMs: 272 * 60_000, winRateLift: 7, scoreMarginLift: .5, attemptsForEffect: 2.1, attemptsAgainstEffect: .2 },
    { name: "Riley S.", line: "Defense", minutesMs: 301 * 60_000, winRateLift: 6, scoreMarginLift: .4, attemptsForEffect: .5, attemptsAgainstEffect: -2.0 },
    { name: "Morgan P.", line: "Keeper", minutesMs: 238 * 60_000, winRateLift: 3, scoreMarginLift: .2, attemptsForEffect: -.2, attemptsAgainstEffect: -2.4 },
    { name: "Casey T.", line: "Midfield", minutesMs: 205 * 60_000, winRateLift: -4, scoreMarginLift: -.3, attemptsForEffect: -.7, attemptsAgainstEffect: .8 }
  ],
  playerTiming: [
    { name: "Alex M.", buckets: [{ label: "First 15 min", winRate: .75, marginPer60: 1.8, attemptsForPer60: 13.1, attemptsAgainstPer60: 7.9 }, { label: "15-30 min", winRate: .68, marginPer60: .9, attemptsForPer60: 11.4, attemptsAgainstPer60: 8.8 }, { label: "After 30 min", winRate: .58, marginPer60: .2, attemptsForPer60: 10.0, attemptsAgainstPer60: 9.7 }] },
    { name: "Jordan K.", buckets: [{ label: "First 15 min", winRate: .71, marginPer60: 1.1, attemptsForPer60: 12.6, attemptsAgainstPer60: 8.3 }, { label: "15-30 min", winRate: .73, marginPer60: 1.4, attemptsForPer60: 12.9, attemptsAgainstPer60: 8.1 }, { label: "After 30 min", winRate: .51, marginPer60: -.3, attemptsForPer60: 9.2, attemptsAgainstPer60: 10.7 }] },
    { name: "Riley S.", buckets: [{ label: "First 15 min", winRate: .62, marginPer60: .4, attemptsForPer60: 10.8, attemptsAgainstPer60: 8.7 }, { label: "15-30 min", winRate: .65, marginPer60: .7, attemptsForPer60: 10.5, attemptsAgainstPer60: 8.4 }, { label: "After 30 min", winRate: .43, marginPer60: -.8, attemptsForPer60: 8.1, attemptsAgainstPer60: 11.6 }] },
    { name: "Casey T.", buckets: [{ label: "First 15 min", winRate: .52, marginPer60: -.2, attemptsForPer60: 9.3, attemptsAgainstPer60: 10.1 }, { label: "15-30 min", winRate: .57, marginPer60: .3, attemptsForPer60: 9.8, attemptsAgainstPer60: 9.7 }, { label: "After 30 min", winRate: .36, marginPer60: -1.1, attemptsForPer60: 7.4, attemptsAgainstPer60: 12.3 }] }
  ]
});
const DEMO_FACTOR_REPORTS = Object.freeze({
  win: {
    label: "Win rate", unit: "pts", description: "Estimated lift to win probability", favorable: 1,
    factors: [
      { name: "Alex M.", kind: "Player", detail: "8 match appearances", value: 11, low: 3, high: 18, evidence: "Strong" },
      { name: "Jordan K. · Midfield", kind: "Player + line", detail: "286 minutes in midfield", value: 9, low: 2, high: 16, evidence: "Supported" },
      { name: "Jordan K. at center mid", kind: "Player + position", detail: "214 minutes in position", value: 8, low: 1, high: 15, evidence: "Supported" },
      { name: "Riley S. · Defense", kind: "Player + line", detail: "241 minutes in defense", value: 5, low: -1, high: 11, evidence: "Early" },
      { name: "Taylor B.", kind: "Player", detail: "7 match appearances", value: -7, low: -14, high: 1, evidence: "Early" }
    ]
  },
  margin: {
    label: "Score margin", unit: "goals", description: "Estimated change in score margin per match", favorable: 1,
    factors: [
      { name: "Alex M.", kind: "Player", detail: "336 on-field minutes", value: .7, low: .2, high: 1.2, evidence: "Strong" },
      { name: "Jordan K. · Midfield", kind: "Player + line", detail: "286 minutes in midfield", value: .6, low: .1, high: 1.0, evidence: "Supported" },
      { name: "Jordan K. at center mid", kind: "Player + position", detail: "214 minutes in position", value: .5, low: .1, high: .9, evidence: "Supported" },
      { name: "Riley S. · Defense", kind: "Player + line", detail: "241 minutes in defense", value: .3, low: -.1, high: .7, evidence: "Early" },
      { name: "Casey T.", kind: "Player", detail: "186 on-field minutes", value: -.4, low: -.9, high: .1, evidence: "Early" }
    ]
  },
  attemptsFor: {
    label: "Attempts for", unit: "/ 60", description: "Estimated change in team attempts created", favorable: 1,
    factors: [
      { name: "Jordan K. at center mid", kind: "Player + position", detail: "38 attempts in shared stints", value: 2.9, low: 1.2, high: 4.5, evidence: "Strong" },
      { name: "Jordan K. · Midfield", kind: "Player + line", detail: "46 attempts in midfield", value: 2.5, low: 1.0, high: 4.0, evidence: "Strong" },
      { name: "Alex M.", kind: "Player", detail: "52 attempts in on-field stints", value: 2.1, low: .7, high: 3.5, evidence: "Supported" },
      { name: "Alex M. · Forward", kind: "Player + line", detail: "272 minutes as a forward", value: 1.6, low: .3, high: 2.9, evidence: "Supported" },
      { name: "Casey T.", kind: "Player", detail: "24 attempts in on-field stints", value: -.8, low: -2.1, high: .5, evidence: "Early" }
    ]
  },
  attemptsAgainst: {
    label: "Attempts against", unit: "/ 60", description: "Estimated change in opponent attempts allowed", favorable: -1,
    factors: [
      { name: "Riley S. at goalkeeper", kind: "Player + position", detail: "238 minutes in position", value: -2.4, low: -4.1, high: -.8, evidence: "Strong" },
      { name: "Riley S. · Defense", kind: "Player + line", detail: "301 minutes in defense", value: -2.0, low: -3.5, high: -.6, evidence: "Strong" },
      { name: "Morgan P. at center back", kind: "Player + position", detail: "219 minutes in position", value: -1.7, low: -3.0, high: -.4, evidence: "Supported" },
      { name: "Alex M.", kind: "Player", detail: "336 on-field minutes", value: -1.1, low: -2.4, high: .1, evidence: "Early" },
      { name: "Taylor B.", kind: "Player", detail: "203 on-field minutes", value: 1.3, low: -.2, high: 2.8, evidence: "Early" }
    ]
  },
  attemptsMargin: {
    label: "Attempts margin", unit: "/ 60", description: "Estimated change in attempts for minus attempts against", favorable: 1,
    factors: [
      { name: "Jordan K. · Midfield", kind: "Player + line", detail: "286 minutes in midfield", value: 3.2, low: 1.2, high: 5.1, evidence: "Strong" },
      { name: "Riley S. · Defense", kind: "Player + line", detail: "301 minutes in defense", value: 2.5, low: .7, high: 4.3, evidence: "Strong" },
      { name: "Jordan K. at center mid", kind: "Player + position", detail: "214 minutes in position", value: 2.1, low: .4, high: 3.8, evidence: "Supported" },
      { name: "Alex M.", kind: "Player", detail: "336 on-field minutes", value: 1.7, low: .1, high: 3.3, evidence: "Supported" },
      { name: "Casey T.", kind: "Player", detail: "186 on-field minutes", value: -1.9, low: -3.8, high: .1, evidence: "Early" }
    ]
  }
});

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
let substitutionHighlightTimer = null;
let recentSubstitutionState = { on: new Set(), off: new Set(), nextExpiryMs: null };

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
  $("#analysis-card").addEventListener("click", showSeasonAnalysis);
  $("#data-tools-link").addEventListener("click", openDataTools);
  $("#team-menu").addEventListener("click", openTeamMenu);
  $("#add-first-team").addEventListener("click", openAddTeam);
  $("#back-to-team").addEventListener("click", returnFromAnalysis);
  $("#back-to-analysis").addEventListener("click", () => { $("#analysis-method-panel").classList.add("hidden"); $("#season-analysis-panel").classList.remove("hidden"); window.scrollTo(0, 0); });
  $("#team-matches").addEventListener("click", event => { const button = event.target.closest("[data-open-match]"); if (button) loadMatch(button.dataset.openMatch); });
  $("#clock-button").addEventListener("click", openClockAdjust);
  $("#half-toggle").addEventListener("click", toggleHalf);
  $("#match-control").addEventListener("click", toggleClock);
  $("#score-for-button").onclick = event => { event.preventDefault(); event.stopPropagation(); openGoalFor(); };
  $("#goal-attempt-button").onclick = event => { event.preventDefault(); event.stopPropagation(); recordSimple("goal_attempt", { team: "for" }).catch(showActionError); };
  $("#score-against-button").onclick = event => { event.preventDefault(); event.stopPropagation(); recordSimple("goal_against").catch(showActionError); };
  $("#opponent-goal-attempt-button").onclick = event => { event.preventDefault(); event.stopPropagation(); recordSimple("goal_attempt", { team: "against" }).catch(showActionError); };
  $("#clear-field").addEventListener("click", clearField);
  $("#layout-button").addEventListener("click", openLayoutPicker);
  $("#more-actions").addEventListener("click", openMoreActions);
  $("#match-back").addEventListener("click", returnToTeam);
  $("#add-note").addEventListener("click", openTimelineAdd);
  $("#undo").addEventListener("click", undoLatest);
  $("#export-json").addEventListener("click", () => downloadFile(fileBase() + ".json", exportMatchJson(events, state), "application/json"));
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
  const rows = teams.map(item => `<div class="team-menu-row"><button type="button" class="team-select ${item.teamId === team?.teamId ? "active" : ""}" data-team-select="${escapeHtml(item.teamId)}"><strong>${escapeHtml(item.name)}</strong>${item.teamId === team?.teamId ? "<small>Current</small>" : ""}</button><button type="button" class="team-delete" data-team-delete="${escapeHtml(item.teamId)}" aria-label="More options for ${escapeHtml(item.name)}" title="More options">•••</button></div>`).join("");
  openDialog("Teams", `<div class="team-menu-list">${rows || "<p class='hint'>No teams yet.</p>"}<button type="button" class="primary add-team-menu" data-add-team>+ Add team</button></div>`, null, false);
  $("#dialog-body").onclick = event => {
    const add = event.target.closest("[data-add-team]");
    const select = event.target.closest("[data-team-select]");
    const remove = event.target.closest("[data-team-delete]");
    if (add) { $("#action-dialog").close(); openAddTeam(); }
    if (select) { $("#action-dialog").close(); selectTeam(select.dataset.teamSelect); }
    if (remove) { $("#action-dialog").close(); openTeamOptions(remove.dataset.teamDelete); }
  };
}

function openDataTools() {
  const cards = sampleDataOptions().map(sample => `<button type="button" class="sample-data-card" data-load-sample="${sample.key}"><span><strong>${escapeHtml(sample.name.replace("Sample · ", ""))}</strong><small>${sample.matches} match${sample.matches === 1 ? "" : "es"}</small></span><p>${escapeHtml(sample.description)}</p><em>Load as a new team →</em></button>`).join("");
  openDialog("Data tools", `<section class="backup-tools"><h3>Backup</h3><p>Export one team or every team, then add new data from another device. Existing data remains when a file is loaded.</p><div><button type="button" class="secondary" data-export-team ${team ? "" : "disabled"}>Export this team</button><button type="button" class="secondary" data-export-backup>Export all teams</button><button type="button" class="secondary" data-import-backup>Load from file</button><input type="file" data-backup-file accept=".json,application/json" hidden></div><small>For the same team on two devices, first load a primary-device backup onto the second device so both share the same team identity. Deletions made elsewhere are not removed.</small></section><section class="sample-data-tools"><h3>Test data</h3><p class="sample-data-note">Samples are added as new teams and do not replace existing data.</p><div class="sample-data-list">${cards}</div></section><section class="clear-data-tools"><h3>Reset</h3><button type="button" class="secondary danger-action" data-clear-all>Clear all data</button></section>`, null, false);
  const fileInput = $("[data-backup-file]");
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const backup = parseFullBackup(await file.text());
      const storedTeams = backup.meta.find(record => record.key === "teams")?.value || [];
      const matchCount = new Set(backup.events.map(event => event.matchId)).size;
      $("#action-dialog").close();
      openDialog("Add backup data?", `<p>This backup contains <strong>${Array.isArray(storedTeams) ? storedTeams.length : 0} team${storedTeams?.length === 1 ? "" : "s"}</strong> and <strong>${matchCount} match${matchCount === 1 ? "" : "es"}</strong>.</p><p>New teams, players, matches, and events will be added. Data already on this device will remain.</p>`, async () => mergeFullBackup(backup));
      $("#dialog-confirm").textContent = "Add data";
    } catch (error) {
      $("#dialog-error").textContent = error.message;
    }
  });
  $("#dialog-body").onclick = async event => {
    const button = event.target.closest("[data-load-sample]");
    if (event.target.closest("[data-export-team]")) {
      await exportCurrentTeamBackup();
      $("#action-dialog").close();
      return;
    }
    if (event.target.closest("[data-export-backup]")) {
      await exportFullBackup();
      $("#action-dialog").close();
      return;
    }
    if (event.target.closest("[data-import-backup]")) { fileInput.click(); return; }
    if (event.target.closest("[data-clear-all]")) { $("#action-dialog").close(); openClearAllData(); return; }
    if (button && !button.disabled) {
      button.disabled = true;
      $("#dialog-error").textContent = "Loading…";
      try {
        await loadSampleData(button.dataset.loadSample);
        $("#action-dialog").close();
      } catch (error) {
        button.disabled = false;
        $("#dialog-error").textContent = error.message;
      }
    }
  };
}

async function exportFullBackup() {
  const backup = createFullBackup(await store.allMeta(), await store.allEvents());
  downloadFile(`lineupjd-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2), "application/json");
  $("#data-tools-status").textContent = "Backup exported";
}

async function exportCurrentTeamBackup() {
  if (!team) return;
  const allEvents = await store.allEvents();
  const teamMatchIds = new Set(matchIdsForTeam(allEvents, team.teamId));
  const teamEvents = allEvents.filter(event => teamMatchIds.has(event.matchId));
  const allMeta = await store.allMeta();
  const teamMeta = allMeta.filter(record => record.key === `analysisReportSeen:${team.teamId}`);
  teamMeta.push(
    { key: "teams", value: [team] },
    { key: "activeTeamId", value: team.teamId },
    { key: "team", value: team }
  );
  const backup = createFullBackup(teamMeta, teamEvents);
  const safeName = team.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team";
  downloadFile(`lineupjd-${safeName}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2), "application/json");
  $("#data-tools-status").textContent = `${team.name} exported`;
}

async function mergeFullBackup(backup) {
  const localEvents = await store.allEvents();
  const localMeta = await store.allMeta();
  const eventMerge = mergeEventHistories(localEvents, backup.events);
  const incomingStoredTeams = backup.meta.find(record => record.key === "teams")?.value;
  const incomingLegacyTeam = backup.meta.find(record => record.key === "team")?.value;
  const incomingTeams = normalizeTeams(incomingStoredTeams || (incomingLegacyTeam ? [incomingLegacyTeam] : []));
  const teamMerge = mergeTeamCollections(teams, incomingTeams);
  const metaByKey = new Map(localMeta.map(record => [record.key, structuredClone(record)]));
  for (const record of backup.meta) {
    if (["teams", "team", "activeTeamId", "activeMatchId"].includes(record.key)) continue;
    if (record.key.startsWith("analysisReportSeen:")) {
      const current = Number(metaByKey.get(record.key)?.value || 0);
      metaByKey.set(record.key, { key: record.key, value: Math.max(current, Number(record.value || 0)) });
    } else if (!metaByKey.has(record.key)) metaByKey.set(record.key, structuredClone(record));
  }
  const localActiveTeamId = team?.teamId;
  const incomingActiveTeamId = backup.meta.find(record => record.key === "activeTeamId")?.value;
  teams = teamMerge.teams;
  team = teams.find(item => item.teamId === localActiveTeamId)
    || teams.find(item => item.teamId === incomingActiveTeamId)
    || teams[0]
    || null;
  metaByKey.set("teams", { key: "teams", value: teams });
  metaByKey.set("activeTeamId", { key: "activeTeamId", value: team?.teamId || null });
  metaByKey.set("team", { key: "team", value: team });
  metaByKey.delete("activeMatchId");
  await store.replaceAll({ events: eventMerge.events, meta: [...metaByKey.values()] });
  await persistTeams();
  await resetAfterDataChange();
  const localMatchIds = new Set(localEvents.map(event => event.matchId));
  const newMatchCount = new Set(eventMerge.addedEvents.map(event => event.matchId).filter(id => !localMatchIds.has(id))).size;
  const parts = [
    teamMerge.addedTeams ? `${teamMerge.addedTeams} team${teamMerge.addedTeams === 1 ? "" : "s"}` : "",
    newMatchCount ? `${newMatchCount} match${newMatchCount === 1 ? "" : "es"}` : "",
    eventMerge.addedEvents.length && !newMatchCount ? `${eventMerge.addedEvents.length} new event${eventMerge.addedEvents.length === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  $("#data-tools-status").textContent = parts.length ? `${parts.join(" and ")} added` : "Already up to date";
}

function mergeTeamCollections(localTeams, incomingTeams) {
  const merged = new Map(localTeams.map(item => [item.teamId, structuredClone(item)]));
  let addedTeams = 0;
  for (const incoming of incomingTeams) {
    const existing = merged.get(incoming.teamId);
    if (!existing) {
      merged.set(incoming.teamId, structuredClone(incoming));
      addedTeams += 1;
      continue;
    }
    const players = new Map(existing.players.map(player => [player.playerId, player]));
    for (const player of incoming.players) {
      const localPlayer = players.get(player.playerId);
      players.set(player.playerId, localPlayer ? { ...player, ...localPlayer } : structuredClone(player));
    }
    merged.set(incoming.teamId, { ...incoming, ...existing, players: [...players.values()] });
  }
  return { teams: [...merged.values()], addedTeams };
}

function openClearAllData() {
  openDialog("Clear all data?", "<p>This permanently removes every team, player, match, event, and report from this device.</p><p>Export a backup first if you may need this data again.</p>", clearAllData);
  $("#dialog-confirm").textContent = "Clear all data";
  $("#dialog-confirm").classList.add("danger-confirm");
}

async function clearAllData() {
  await store.clearAll();
  teams = [];
  team = null;
  await resetAfterDataChange();
  $("#data-tools-status").textContent = "All data cleared";
}

async function resetAfterDataChange() {
  clock?.destroy();
  clock = null;
  matchId = null;
  events = [];
  state = projector.empty();
  document.body.classList.remove("match-open");
  $("#match-view").classList.add("hidden");
  $("#setup-view").classList.remove("hidden", "analysis-open", "analysis-detail-open");
  $("#season-analysis-panel").classList.add("hidden");
  $("#analysis-method-panel").classList.add("hidden");
  $("#team-dashboard").classList.remove("hidden");
  await renderTeamDashboard();
  window.scrollTo(0, 0);
}

async function loadSampleData(kind) {
  const baseName = sampleDataOptions().find(sample => sample.key === kind)?.name || "Sample team";
  const matchingNames = teams.filter(item => item.name === baseName || item.name.startsWith(`${baseName} (`)).length;
  const suffix = matchingNames ? ` (${matchingNames + 1})` : "";
  const dataset = createSampleDataset(kind, suffix);
  await store.appendMany(dataset.events);
  team = dataset.team;
  teams.push(team);
  await persistTeams();
  $("#season-analysis-panel").classList.add("hidden");
  $("#analysis-method-panel").classList.add("hidden");
  $("#setup-view").classList.remove("analysis-open", "analysis-detail-open");
  await renderTeamDashboard();
  $("#data-tools-status").textContent = `${team.name} loaded`;
  window.scrollTo(0, 0);
}

function openTeamOptions(teamId) {
  const target = teams.find(item => item.teamId === teamId);
  if (!target) return;
  openDialog(target.name, `<div class="dialog-fields action-list"><button type="button" class="secondary danger-action" data-delete-team-option>Delete team</button></div>`, null, false);
  $("[data-delete-team-option]").addEventListener("click", () => {
    $("#action-dialog").close();
    openDeleteTeam(teamId);
  });
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
    $("#analysis-method-panel").classList.add("hidden");
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
  $("#analysis-method-panel").classList.add("hidden");
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
    $("#analysis-method-panel").classList.add("hidden");
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
    roster: team.players.map(eventPlayerRecord),
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
  $("#header-team-name").textContent = team?.name || "";
  $("#no-team-panel").classList.toggle("hidden", hasTeam);
  $("#team-dashboard").classList.toggle("hidden", !hasTeam);
  $("#team-name-input").disabled = !hasTeam;
  if (!hasTeam) { $("#team-name-input").value = ""; return; }
  $("#team-name-input").value = team.name;
  const all = await store.allEvents();
  const ids = matchIdsForTeam(all, team.teamId);
  const records = ids.map(id => analysisRecord(all.filter(event => event.matchId === id))).sort((a, b) => b.state.config.date.localeCompare(a.state.config.date));
  const matches = records.map(record => record.state);
  const analysis = analyzeTeam(records);
  const readyReportCount = outcomeMetricReportReadyCount(analysis) + Number(analysis.readiness.playingTime.ready) + Number(positionGuidanceReadiness(analysis).ready);
  const readyPartCount = analysis.outcomeReadyCount + Number(analysis.readiness.playingTime.ready);
  const seenReadyCount = Number((await store.getMeta(`analysisReportSeen:${team.teamId}`))?.value || 0);
  const newReports = Math.max(0, readyReportCount - seenReadyCount);
  $("#analysis-new-badge").classList.toggle("hidden", newReports === 0);
  $("#analysis-new-badge").textContent = newReports > 1 ? `${newReports} new` : "New";
  $("#analysis-card-status").textContent = newReports
    ? `${newReports} new report${newReports === 1 ? "" : "s"} fully unlocked`
    : readyReportCount
      ? `${readyReportCount} of ${ANALYSIS_REPORT_COUNT} reports fully unlocked`
      : readyPartCount
        ? `${readyPartCount} of ${ANALYSIS_OUTCOME_COUNT} report parts ready`
        : "Demo reports ready to preview";
  const pausedAtByMatch = new Map(ids.map(id => {
    const matchEvents = activeTimeline(all.filter(event => event.matchId === id));
    const pausedEvent = [...matchEvents].reverse().find(event => ["clock_paused", "period_ended"].includes(event.type));
    return [id, pausedEvent?.realTimestamp];
  }));
  $("#team-matches").innerHTML = matches.map(match => `<button class="match-row" data-open-match="${match.matchId}"><span><strong>${escapeHtml(match.config.opponent)}</strong><small>${escapeHtml(match.config.date)} · ${match.config.playersOnField}v${match.config.playersOnField}</small></span><b>${match.scoreFor}–${match.scoreAgainst}</b><span>→</span></button>`).join("") || "<p class='hint'>No matches yet. New matches begin with every position empty.</p>";
  [...$("#team-matches").querySelectorAll(".match-row")].forEach((row, index) => {
    const match = matches[index];
    const status = mainMenuMatchStatus(match, pausedAtByMatch.get(match.matchId));
    const menuStatus = status === "Running" ? "Playing" : status === "Ready" ? "Not started" : "";
    if (menuStatus) row.querySelector("span")?.insertAdjacentHTML("beforeend", `<em class="match-state ${menuStatus.toLowerCase().replace(" ", "-")}">${menuStatus}</em>`);
  });
}

function openAddPlayer() {
  const fields = () => `<div class="player-entry-row"><input name="playerName" autocomplete="off" placeholder="Player name" aria-label="Player name"><input class="player-number-input" name="playerNumber" inputmode="numeric" pattern="[0-9]{1,2}" maxlength="2" placeholder="#" aria-label="Jersey number"></div>`;
  openDialog("Add players", `<div class="dialog-fields"><label>Players<div id="player-name-list" class="player-name-list">${fields()}</div></label><p class="hint">Jersey numbers are saved with ${escapeHtml(team.name)} and are not copied into the match event log.</p></div>`, async data => {
    const numberValues = data.getAll("playerNumber");
    const entries = data.getAll("playerName").map((value, index) => ({
      name: String(value).trim(),
      number: normalizePlayerNumber(numberValues[index])
    })).filter(entry => entry.name);
    const names = entries.map(entry => entry.name);
    if (!names.length) throw new Error("Enter at least one player name.");
    const keys = names.map(name => name.toLocaleLowerCase());
    if (new Set(keys).size !== keys.length) throw new Error("Each player name can only be added once.");
    const existing = new Set(state.config.roster.map(player => player.name.toLocaleLowerCase()));
    const duplicate = names.find((name, index) => existing.has(keys[index]));
    if (duplicate) throw new Error(`${duplicate} is already in this match.`);
    let teamChanged = false;
    const players = entries.map(({ name, number }, index) => {
      let player = team.players.find(item => item.name.toLocaleLowerCase() === keys[index]);
      if (!player) { player = { playerId: playerIdFromName(name), name, ...(number ? { number } : {}) }; team.players.push(player); teamChanged = true; }
      else if (number && player.number !== number) { player.number = number; teamChanged = true; }
      return player;
    });
    if (teamChanged) await persistTeams();
    for (const player of players) await append("player_added", clock.elapsedMs, { player: eventPlayerRecord(player) }, false);
  });
  $("#dialog-confirm").textContent = "Add";
  bindGrowingPlayerInputs(fields);
  $("#player-name-list input").focus();
}

function bindGrowingPlayerInputs(fields) {
  const list = $("#player-name-list");
  list.oninput = () => {
    const rows = [...list.querySelectorAll(".player-entry-row")];
    if (rows.at(-1)?.querySelector('input[name="playerName"]')?.value.trim()) list.insertAdjacentHTML("beforeend", fields());
  };
}

async function showSeasonAnalysis() {
  if (!team) return;
  $("#setup-view").classList.remove("analysis-detail-open");
  $("#setup-view").classList.add("analysis-open");
  const all = await store.allEvents();
  const ids = matchIdsForTeam(all, team.teamId);
  const records = ids.map(id => analysisRecord(all.filter(event => event.matchId === id)));
  const analysis = analyzeTeam(records);
  $("#season-summary").innerHTML = teamAnalysisHtml(analysis);
  bindAnalysisControls(analysis);
  await store.setMeta(`analysisReportSeen:${team.teamId}`, outcomeMetricReportReadyCount(analysis) + Number(analysis.readiness.playingTime.ready) + Number(positionGuidanceReadiness(analysis).ready));
  $("#analysis-new-badge").classList.add("hidden");
  $("#team-dashboard").classList.add("hidden"); $("#analysis-method-panel").classList.add("hidden"); $("#season-analysis-panel").classList.remove("hidden");
}

function analysisRecord(matchEvents) {
  const projected = projector.project(matchEvents);
  const pausedEvent = [...activeTimeline(matchEvents)].reverse().find(event => ["clock_paused", "period_ended"].includes(event.type));
  const status = mainMenuMatchStatus(projected, pausedEvent?.realTimestamp);
  return { events: matchEvents, state: projected, isFinal: status === "Final" || status === "Over" };
}

function teamAnalysisHtml(analysis) {
  const groups = [
    ["Playing time", "Track minutes and appearances without recording any goals or attempts.", ["playingTime"]],
    ["Attack & defense", "Explore each pressure measure separately. These reports unlock from recorded attempts.", ["attemptsFor", "attemptsAgainst", "attemptsMargin"]],
    ["Match results", "Explore results separately from attempt tracking. These reports unlock from finished matches and goals.", ["win", "margin"]],
    ["Guidance", "Explore position ideas supported by recorded match data.", ["positionGuidance"]]
  ];
  return `
    ${analysisOverviewBarHtml()}
    <div id="analysis-report-menu" class="analysis-report-menu">
      <section class="analysis-data-note"><div><span class="eyebrow">Your data</span><strong>${analysis.completedMatches} completed match${analysis.completedMatches === 1 ? "" : "es"} · ${analysis.goalsFor + analysis.goalsAgainst} goals · ${analysis.attemptsFor + analysis.attemptsAgainst} attempts</strong></div><button class="info-button" data-analysis-method-link type="button" aria-label="How reports work">i</button></section>
      ${groups.map(([title, blurb, keys]) => `<section class="analysis-menu-group"><div class="analysis-menu-heading"><h3>${title}</h3><p>${blurb}</p></div><div class="analysis-menu-list">${keys.map(key => analysisMenuCardHtml(analysis, key)).join("")}</div></section>`).join("")}
      <p class="analysis-method-note"><strong>Optional data stays optional.</strong> Tracking field time powers playing-time reports. Goals and attempts add lineup analysis when you choose to record them.</p>
    </div>
    <div id="analysis-report-detail" class="hidden"></div>`;
}

function analysisOverviewBarHtml() {
  return `<div class="analysis-overview-bar"><button type="button" class="secondary" data-analysis-team-back>← Team</button><strong>Reports</strong></div>`;
}

const ANALYSIS_REPORTS = Object.freeze({
  playingTime: { title: "Playing time", description: "Average time when present and total time on the field for every player." },
  attemptsFor: { title: "Attempts for", description: "What helps the team create more attempts." },
  attemptsAgainst: { title: "Attempts against", description: "What helps the team allow fewer opponent attempts." },
  attemptsMargin: { title: "Attempts margin", description: "What improves the balance between attempts created and allowed." },
  win: { title: "Win rate", description: "What is associated with a stronger chance of winning." },
  margin: { title: "Score margin", description: "What is associated with scoring more goals than the opponent." },
  positionGuidance: { title: "Position guidance", description: "Rank a player's tested roles using their attacking and defensive attempt patterns." }
});

const ANALYSIS_CATEGORY_REPORTS = Object.freeze({
  team: { title: "Team baseline", description: "Your overall results, goals, and attempt rates." },
  impact: { title: "Players & outcomes", description: "Which players share the field with stronger outcomes." },
  formations: { title: "Formations & outcomes", description: "Compare results and pressure for each formation." },
  lines: { title: "Players by position group", description: "Compare a player as keeper, defender, midfielder, or forward." },
  positions: { title: "Players by exact position", description: "Compare a player in each named field position." },
  fatigue: { title: "Team outcomes by time played", description: "The team pattern during the first, next, and later 15 minutes played." },
  playerTime: { title: "Player outcomes by time played", description: "See each player's outcome pattern as their minutes build." }
});

function analysisReportReadiness(analysis, key) {
  if (key === "playingTime") return { ...analysis.readiness.playingTime, readyCount: analysis.readiness.playingTime.ready ? 1 : 0, total: 1 };
  if (key === "positionGuidance") {
    const readiness = positionGuidanceReadiness(analysis);
    return { ...readiness, readyCount: readiness.comparablePlayers, total: Math.max(1, readiness.comparablePlayers) };
  }
  const parts = ANALYSIS_CATEGORY_KEYS.map(category => analysis.outcomeReadiness[category][key]);
  const readyCount = parts.filter(item => item.ready).length;
  const best = parts.filter(item => !item.ready).sort((a, b) => b.progress - a.progress)[0];
  return { ready: readyCount === parts.length, progress: best?.progress || 0, needs: best?.needs || "Record match data", readyCount, total: parts.length };
}

function outcomeMetricReportReadyCount(analysis) {
  return ANALYSIS_OUTCOME_METRICS.filter(metric => ANALYSIS_CATEGORY_KEYS.every(category => analysis.outcomeReadiness[category][metric].ready)).length;
}

function analysisMenuCardHtml(analysis, key) {
  const report = ANALYSIS_REPORTS[key];
  const readiness = analysisReportReadiness(analysis, key);
  const stateLabel = readiness.ready ? (key === "positionGuidance" ? "Available" : "Strong") : readiness.progress ? "Building" : "Needs data";
  const requirement = readiness.ready
    ? (key === "playingTime"
      ? `${analysis.matches} tracked match${analysis.matches === 1 ? "" : "es"}`
      : key === "positionGuidance"
        ? `${readiness.comparablePlayers} player${readiness.comparablePlayers === 1 ? " has" : "s have"} comparable broad roles`
        : `All ${readiness.total} sections ready`)
    : key === "playingTime" || key === "positionGuidance" ? readiness.needs : `${readiness.readyCount} of ${readiness.total} sections ready · ${readiness.needs}`;
  return `<button class="analysis-menu-card" type="button" data-open-analysis-report="${key}"><span class="analysis-menu-icon" aria-hidden="true">${readiness.ready ? "✓" : readiness.progress ? "◐" : "○"}</span><span><strong>${report.title}</strong><small>${report.description}</small><em>${escapeHtml(requirement)}</em></span><span class="report-strength ${readiness.ready ? "strong" : readiness.progress ? "building" : "weak"}">${stateLabel}</span><span class="analysis-entry-arrow" aria-hidden="true">→</span></button>`;
}

function analysisReportDetailHtml(analysis, key) {
  const report = ANALYSIS_REPORTS[key];
  if (key === "playingTime") {
    const ready = analysis.readiness.playingTime.ready && analysis.players.length;
    const source = ready ? analysis.players : DEMO_ANALYSIS.players;
    return `${analysisDetailBarHtml()}<section class="analysis-report-card playing-time-report"><div class="analysis-report-head"><div><span class="eyebrow">Playing time</span><h3>${report.title}</h3><p>${report.description}</p></div>${sourcePill(ready)}</div><div class="breakdown-toggle playing-time-toggle" data-playing-time-report role="group" aria-label="Playing time period"><button class="active" type="button" data-playing-time-view="game">Per match present</button><button type="button" data-playing-time-view="season">Season total</button></div><div id="playing-time-list" class="playing-time-list" aria-live="polite">${playingTimeListHtml(source, "game")}</div>${reportModelNote("Timeline duration aggregation")}${unlockFooter(analysis.readiness.playingTime, ready ? "Matches marked Not here are excluded from that player's average." : "Preview uses sample players and values.")}</section>`;
  }
  if (key === "positionGuidance") return positionGuidanceReportHtml(analysis);
  return `${analysisDetailBarHtml()}<header class="metric-report-heading"><span class="eyebrow">Outcome report</span><h2>${report.title}</h2><p>${report.description} Each section unlocks independently as enough matching data is recorded.</p></header>${outcomeReportsHtml(analysis, key)}`;
}

function positionGuidanceReportHtml(analysis) {
  const playerIds = [...new Set(analysis.playerLines.map(row => row.playerId))];
  const rankedIds = playerIds.sort((a, b) => {
    const rowsFor = id => analysis.playerLines.filter(row => row.playerId === id);
    const supportedFor = id => rowsFor(id).filter(row => row.minutesMs >= BROAD_ROLE_SAMPLE_MS).length;
    const minutesFor = id => rowsFor(id).reduce((sum, row) => sum + row.minutesMs, 0);
    return supportedFor(b) - supportedFor(a) || minutesFor(b) - minutesFor(a);
  });
  const selectedPlayerId = rankedIds[0] || "";
  const options = rankedIds.map(playerId => {
    const name = analysis.playerLines.find(row => row.playerId === playerId)?.name || playerId;
    return `<option value="${escapeHtml(playerId)}">${escapeHtml(name)}</option>`;
  }).join("");
  return `${analysisDetailBarHtml()}<header class="metric-report-heading position-guidance-heading"><span class="eyebrow">Player positions</span><h2>Position guidance</h2><p>Use recorded attempt patterns to compare positions a player has actually tried.</p></header>
    <section class="analysis-report-card position-guidance-report">
      <div class="guidance-controls"><label><span>Player</span><select data-position-guidance-player ${rankedIds.length ? "" : "disabled"}>${options || "<option>No tracked players</option>"}</select></label><div class="breakdown-toggle guidance-objective-toggle" data-position-guidance-objective role="group" aria-label="Position guidance objective"><button type="button" data-guidance-objective="attack">Attack</button><button class="active" type="button" data-guidance-objective="balanced">Balanced</button><button type="button" data-guidance-objective="defend">Defend</button></div></div>
      <div id="position-guidance-result" aria-live="polite">${positionGuidanceResultHtml(analysis, selectedPlayerId, "balanced")}</div>
    </section>`;
}

function guidanceMetricCopy(objective) {
  return {
    attack: { title: "creating attempts", effect: "attempts created" },
    defend: { title: "preventing attempts", effect: "attempts prevented" },
    balanced: { title: "attempt balance", effect: "attempt margin" }
  }[objective] || { title: "attempt balance", effect: "attempt margin" };
}

function positionGuidanceResultHtml(analysis, playerId, objective) {
  if (!playerId) return `<div class="guidance-empty"><strong>No position evidence yet</strong><p>Position guidance appears after a player has tracked field time. Attempts remain optional.</p></div>`;
  const rows = rankPlayerDeployments(analysis.playerLines, playerId, objective);
  const playerName = rows[0]?.name || "Player";
  const metric = guidanceMetricCopy(objective);
  const attemptEvents = analysis.attemptsFor + analysis.attemptsAgainst;
  const supportedRows = rows.filter(row => row.minutesMs >= BROAD_ROLE_SAMPLE_MS);
  const canCompare = rows.length >= 2 && attemptEvents > 0;
  const top = rows[0];
  const confidence = supportedRows.length >= 2 && analysis.attemptMatches >= 5 && attemptEvents >= 45
    ? "Supported"
    : canCompare ? "Building" : "Needs comparison";
  const confidenceClass = confidence === "Supported" ? "strong" : confidence === "Building" ? "building" : "weak";
  const headline = !attemptEvents
    ? "Attempts have not been recorded yet"
    : canCompare
      ? `${top.line} currently ranks highest for ${metric.title}`
      : `${top?.line || "This role"} is the only tested broad role`;
  const guidance = !attemptEvents
    ? "You can still use playing-time reports. Record attempts only when they are useful to your coaching."
    : rows.length < 2
      ? `If useful, try ${playerName} in another broad role for 20–30 minutes across two matches to create a comparison.`
      : supportedRows.length < 2
        ? `More time across ${playerName}'s tested roles will make this comparison less sensitive to a short stint.`
        : "More matches and different teammate combinations will test whether this pattern remains stable.";
  const roleRows = rows.map((row, index) => `<article class="guidance-role-row ${index === 0 && canCompare ? "recommended" : ""}"><span class="guidance-rank">${index + 1}</span><div><strong>${escapeHtml(row.line)}</strong><small>${Math.round(row.minutesMs / 60_000)} min · ${row.attemptsFor} for · ${row.attemptsAgainst} against</small></div><span><b>${row.smoothedAttemptsForPer60.toFixed(1)}</b><small>for / 60</small></span><span><b>${row.smoothedAttemptsAgainstPer60.toFixed(1)}</b><small>against / 60</small></span></article>`).join("");
  return `<div class="guidance-summary"><div><span class="eyebrow">${escapeHtml(playerName)}</span><h3>${escapeHtml(headline)}</h3><p>Ranks only roles this player has tried, using locally smoothed Attempts For and Attempts Against rates.</p></div><span class="report-strength ${confidenceClass}">${confidence}</span></div>
    <div class="guidance-role-list">${roleRows || "<p>No role minutes recorded.</p>"}</div>
    <div class="guidance-next-step"><span aria-hidden="true">◇</span><p><strong>Build the evidence</strong>${escapeHtml(guidance)}</p></div>
    ${goalkeeperGuidanceHtml(analysis, playerId)}
    ${exactPositionGuidanceHtml(analysis, playerId, objective)}
    <div class="guidance-evidence-links"><span>Explore the evidence</span><button type="button" data-open-analysis-report="attemptsFor">Attempts for →</button><button type="button" data-open-analysis-report="attemptsAgainst">Attempts against →</button></div>
    ${reportModelNote("Local observed-rate smoothing")}`;
}

function goalkeeperGuidanceHtml(analysis, playerId) {
  const keeper = analysis.playerPositions.find(row => row.playerId === playerId && row.position === "gk");
  if (!keeper) return "";
  const recordedChances = keeper.attemptsAgainst + keeper.goalsAgainst;
  const noGoalShare = recordedChances ? keeper.attemptsAgainst / recordedChances * 100 : 0;
  return `<section class="keeper-guidance"><div><span class="eyebrow">Goalkeeper context</span><strong>${Math.round(keeper.minutesMs / 60_000)} minutes in goal</strong></div><div><span><b>${keeper.attemptsAgainst}</b><small>non-goal attempts</small></span><span><b>${keeper.goalsAgainst}</b><small>goals against</small></span><span><b>${recordedChances ? `${Math.round(noGoalShare)}%` : "—"}</b><small>recorded chances without a goal</small></span></div><p>This reflects the goalkeeper and the defense in front of them. It is not save percentage because attempts are not classified as saved, blocked, or off target.</p></section>`;
}

function exactPositionGuidanceHtml(analysis, playerId, objective) {
  const readinessKey = objective === "attack" ? "attemptsFor" : objective === "defend" ? "attemptsAgainst" : "attemptsMargin";
  const readiness = analysis.outcomeReadiness.positions[readinessKey];
  const allRows = analysis.playerPositions.filter(row => row.playerId === playerId && row.minutesMs > 0);
  const supportedRows = allRows.filter(row => row.minutesMs >= EXACT_POSITION_SAMPLE_MS);
  const ready = readiness.ready && supportedRows.length >= 2;
  const sampleProgress = Math.min(100, Math.round(supportedRows.length / 2 * 100));
  const progress = Math.min(readiness.progress, sampleProgress);
  if (!ready) {
    const sampleNeed = supportedRows.length >= 2 ? "" : `${2 - supportedRows.length} more 60-minute exact-position sample${2 - supportedRows.length === 1 ? "" : "s"} for this player`;
    const needs = [readiness.ready ? "" : readiness.needs, sampleNeed].filter(Boolean).join(" and ");
    return `<section class="exact-guidance locked"><div><span class="eyebrow">Deeper guidance</span><h3>Exact-position ranking</h3><p>Later, compare roles such as center midfield, wing, fullback, and striker while accounting for smaller samples.</p></div><span class="report-strength weak">${progress}% ready</span><small>${escapeHtml(needs || "More exact-position variation is needed")}</small></section>`;
  }
  const rows = rankPlayerDeployments(supportedRows, playerId, objective, 120 * 60_000);
  return `<section class="exact-guidance"><div><span class="eyebrow">Deeper guidance</span><h3>Exact-position ranking</h3><p>Higher-evidence comparison of the exact positions this player has tried.</p></div><span class="report-strength strong">Available</span><div class="exact-guidance-list">${rows.map((row, index) => `<article><b>${index + 1}</b><span><strong>${escapeHtml(positionName(row.position))}</strong><small>${Math.round(row.minutesMs / 60_000)} minutes</small></span><em>${formatSigned(row.guidanceEffect, 1)} / 60</em></article>`).join("")}</div></section>`;
}

function analysisDetailBarHtml() {
  return `<div class="analysis-detail-bar"><button type="button" class="analysis-detail-back secondary" data-analysis-menu-back>← All reports</button></div>`;
}

function sourcePill(ready) { return `<span class="source-pill ${ready ? "live" : "demo"}">${ready ? "Your data" : "Demo preview"}</span>`; }

function reportModelNote(name) {
  return `<div class="bayesian-model-note"><span>Model</span><strong>${escapeHtml(name)}</strong><button class="info-button model-info-button" data-analysis-method-link type="button" aria-label="More details about this model" title="More model details">i</button></div>`;
}

function playingTimeListHtml(players, view) {
  const presentMatches = player => Number.isFinite(player.presentMatches) ? player.presentMatches : player.appearances;
  const seasonMinutes = player => Number.isFinite(player.seasonMinutes)
    ? player.seasonMinutes
    : player.averageMinutes * presentMatches(player);
  const value = player => view === "season" ? seasonMinutes(player) : player.averageMinutes;
  const source = [...players].sort((a, b) => value(b) - value(a)).slice(0, 6);
  const maxMinutes = Math.max(1, ...source.map(value));
  return source.map(player => {
    const presence = `${presentMatches(player)} match${presentMatches(player) === 1 ? "" : "es"} present`;
    const detail = view === "season"
      ? `${presence} · ${Math.round(player.averageMinutes)}m average`
      : `${presence} · ${Math.round(seasonMinutes(player))}m this season`;
    const label = view === "season" ? `${Math.round(seasonMinutes(player))}m` : `${Math.round(player.averageMinutes)}m`;
    return `<article><div><strong>${escapeHtml(player.name)}</strong><small>${detail}</small></div><span class="time-bar"><i style="width:${value(player) / maxMinutes * 100}%"></i></span><b>${label}</b></article>`;
  }).join("");
}

function outcomeReportsHtml(analysis, metric) {
  const reports = [
    ["team", "By Team", "The team baseline across completed matches and tracked attempts."],
    ["impact", "By Player", "Which players have the strongest positive or negative effect while on the field."],
    ["lines", "By Player Position Rank", "How each player affects outcomes as a keeper, defender, midfielder, or forward."],
    ["fatigue", "Time on Field vs Outcomes", "The average outcome across all players during their first, second, and later 15 minutes on the field."],
    ["formations", "By Formation", "How each formation relates to results, goal margin, and attacking or defensive pressure."],
    ["playerTime", "Time on Field by Player", "How time on field relates to outcomes for each individual player. This report needs more data before drawing player-level conclusions."],
    ["positions", "By Player Position Name", "How each player affects outcomes in a specific named field position."]
  ];

  return `<div class="metric-report-sections">${reports.map(([category]) => outcomeReportHtml(analysis, category, metric)).join("")}</div>`;
}

function outcomeReportHtml(analysis, category, metric) {
  const report = ANALYSIS_CATEGORY_REPORTS[category];
  const readiness = analysis.outcomeReadiness[category][metric];
  const reportStatus = readiness.ready
    ? `<span class="source-pill live">Your data</span>`
    : category === "impact" && analysis.players.length
      ? `<span class="source-pill partial">Early data</span>`
      : `<span class="source-pill demo">Demo preview</span>`;
  const modelName = category === "team" ? "Basic averages"
    : category === "formations" ? "Bayesian-smoothed formation stint averages"
      : category === "impact" ? "Observed player on-field rates"
        : "Bayesian hierarchical Poisson";
  return `<section class="analysis-report-card outcome-report-card ${category === "team" ? "analysis-feature-report" : ""}" data-category-report-card="${category}"><div class="analysis-report-head"><div><h3>${report.title}</h3><p>${report.description}</p></div><div class="report-head-tools">${reportStatus}</div></div><div id="category-explorer-${category}">${categoryOutcomeHtml(analysis, category, metric)}</div>${reportModelNote(modelName)}</section>`;
}

function teamOutcomeHtml(analysis, metric) {
  const readiness = analysis.outcomeReadiness.team[metric];
  const source = readiness.ready ? analysis : DEMO_ANALYSIS;
  const attemptMetric = metric === "attemptsFor" || metric === "attemptsAgainst" || metric === "attemptsMargin";
  const matches = Math.max(1, metric === "win" || metric === "margin" ? source.completedMatches : source.attemptMatches || source.matches);
  const value = metric === "win" ? source.winRate * 100
    : metric === "margin" ? source.scoreMargin / matches
      : metric === "attemptsMargin" ? (source.attemptsFor - source.attemptsAgainst) / matches
        : source[metric] / matches;
  const label = metric === "attemptsMargin" ? `${formatSigned(value, 1)} / match`
    : attemptMetric ? `${Number(value).toFixed(1)} / match`
      : metricValueLabel(value, metric);
  return `<div class="outcome-summary"><article><span>Team ${metricPresentation(metric).label}</span><strong>${label}</strong><small>${matches} ${metric === "win" || metric === "margin" ? "completed" : "tracked"} match${matches === 1 ? "" : "es"}</small></article><article><span>Record</span><strong>${source.completedMatches ? `${source.wins}-${source.draws}-${source.losses}` : "—"}</strong><small>Win · draw · loss</small></article><article><span>Events</span><strong>${attemptMetric ? source.attemptsFor + source.attemptsAgainst : source.goalsFor + source.goalsAgainst}</strong><small>${attemptMetric ? `${source.attemptsFor} for · ${source.attemptsAgainst} against` : "goals recorded"}</small></article></div>${outcomeStatusHtml(readiness)}`;
}

function categoryOutcomeHtml(analysis, category, metric) {
  const readiness = analysis.outcomeReadiness[category][metric];
  const preview = readiness.ready ? "" : `<div class="metric-preview-notice"><strong>Demo preview</strong><span>${escapeHtml(readiness.needs)}</span></div>`;
  if (category === "team") return `${preview}${teamOutcomeHtml(analysis, metric)}`;
  if (category === "formations") return `${preview}${formationOutcomeHtml(analysis, metric)}`;
  if (category === "impact") {
    const hasPlayerData = analysis.players.length > 0;
    const notice = readiness.ready ? "" : hasPlayerData
      ? `<div class="metric-preview-notice early"><strong>Early data</strong><span>${escapeHtml(readiness.needs)}</span></div>`
      : preview;
    return `${notice}${playerOutcomeHtml(analysis, metric)}${outcomeStatusHtml(readiness)}`;
  }
  if (category === "lines") return `${preview}${lineOutcomeHtml(analysis, metric)}`;
  if (category === "positions") return `${preview}${positionOutcomeHtml(analysis, metric)}`;
  if (category === "fatigue") return `${preview}${averageTimeOutcomeHtml(analysis, metric)}`;
  return `${preview}${timingBreakdownHtml(analysis, "player", metric)}`;
}

function playerOutcomeHtml(analysis, metric) {
  const recordedById = new Map(analysis.players.map(player => [player.playerId, player]));
  const roster = team?.players?.length ? team.players : DEMO_ANALYSIS.players.map(player => ({ playerId: player.name, name: player.name }));
  const rows = roster.map(player => {
    const recorded = recordedById.get(player.playerId) || analysis.players.find(item => item.name === player.name);
    return recorded?.minutesMs > 0 ? { ...recorded, noData: false } : { ...recorded, playerId: player.playerId, name: player.name, noData: true, minutesMs: 0, appearances: 0 };
  });
  const value = player => metric === "win" ? player.winRate * 100
    : metric === "margin" ? player.onFieldMarginPer60
      : metric === "attemptsFor" ? player.attemptsForPer60
        : metric === "attemptsAgainst" ? player.attemptsAgainstPer60
          : player.attemptDifferentialPer60;
  rows.sort((a, b) => {
    if (a.noData !== b.noData) return a.noData ? 1 : -1;
    if (a.noData) return a.name.localeCompare(b.name);
    return metric === "attemptsAgainst" ? value(a) - value(b) : value(b) - value(a);
  });
  const valueLabel = player => {
    if (player.noData) return "—";
    if (metric === "win") return `${Math.round(value(player))}%`;
    if (metric === "attemptsFor" || metric === "attemptsAgainst") return `${value(player).toFixed(1)} / 60`;
    return `${formatSigned(value(player), 1)} / 60`;
  };
  const values = rows.filter(player => !player.noData).map(value);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 0;
  const position = player => high === low ? 50 : (value(player) - low) / (high - low) * 100;
  const rangeLabel = number => metric === "win" ? `${Math.round(number)}%` : Number(number).toFixed(1);
  return `<div class="all-player-outcome-list"><div class="all-player-outcome-head"><span>Player</span><span>Evidence</span><span>${escapeHtml(metricPresentation(metric).label)}<small>${rangeLabel(low)} to ${rangeLabel(high)}</small></span></div>${rows.map((player, index) => `<article><span class="player-outcome-rank">${player.noData ? "—" : index + 1}</span><div><strong>${escapeHtml(player.name)}</strong><small>${player.noData ? "No field time recorded" : `${Math.round(player.minutesMs / 60_000)} min · ${player.appearances} appearance${player.appearances === 1 ? "" : "s"}`}</small></div><span>${player.noData ? "Needs field time" : metric === "win" || metric === "margin" ? `${player.completedAppearances || 0} completed matches` : `${player.attemptsFor + player.attemptsAgainst} shared attempts`}</span><span class="player-outcome-value">${player.noData ? `<b>—</b>` : `<span class="player-team-range" title="Team range ${rangeLabel(low)} to ${rangeLabel(high)}; ${player.name} ${valueLabel(player)}"><i style="left:${position(player)}%"></i></span><b>${valueLabel(player)}</b>`}</span></article>`).join("")}</div>`;
}

function openAnalysisMethod(analysis) {
  $("#method-data-summary").innerHTML = `<article><span>Recorded matches</span><strong>${analysis.matches}</strong></article><article><span>Completed matches</span><strong>${analysis.completedMatches}</strong></article><article><span>Goal events</span><strong>${analysis.goalsFor + analysis.goalsAgainst}</strong></article><article><span>Attempt events</span><strong>${analysis.attemptsFor + analysis.attemptsAgainst}</strong></article>`;
  $("#season-analysis-panel").classList.add("hidden");
  $("#analysis-method-panel").classList.remove("hidden");
  window.scrollTo(0, 0);
}

function outcomeStatusHtml(readiness) {
  if (!readiness) return "";
  return `<p class="outcome-readiness ${readiness.ready ? "ready" : ""}"><strong>${readiness.ready ? "This outcome view is unlocked" : `${readiness.progress}% toward this view`}</strong><span>${readiness.ready ? "More matches and a refreshed model will narrow its uncertainty." : readiness.needs}</span></p>`;
}

function metricPresentation(metric) {
  return {
    win: { label: "Win rate", unit: "%", digits: 0, favorable: 1 },
    margin: { label: "Score margin", unit: "goals", digits: 1, favorable: 1 },
    attemptsFor: { label: "Attempts for", unit: "/ 60", digits: 1, favorable: 1 },
    attemptsAgainst: { label: "Attempts against", unit: "/ 60", digits: 1, favorable: -1 },
    attemptsMargin: { label: "Attempts margin", unit: "/ 60", digits: 1, favorable: 1 }
  }[metric];
}

function metricValueLabel(value, metric) {
  const config = metricPresentation(metric);
  if (metric === "win") return `${Math.round(value)}%`;
  if (metric === "attemptsFor" || metric === "attemptsAgainst") return `${Number(value).toFixed(config.digits)} ${config.unit}`;
  return `${formatSigned(value, config.digits)} ${config.unit}`;
}

function lineOutcomeHtml(analysis, metric) { return deploymentOutcomeHtml(analysis, metric, "line"); }
function positionOutcomeHtml(analysis, metric) { return deploymentOutcomeHtml(analysis, metric, "position"); }

function formationOutcomeHtml(analysis, metric) {
  const readiness = analysis.outcomeReadiness.formations[metric];
  const actualReady = readiness.ready && analysis.formations.length > 0;
  const source = actualReady ? analysis.formations : DEMO_ANALYSIS.formations;
  const teamWinRate = analysis.winRate;
  const teamMarginPer60 = analysis.exposureMs ? analysis.scoreMargin * 3_600_000 / analysis.exposureMs : 0;
  const attemptsForBaseline = analysis.exposureMs ? analysis.attemptsFor * 3_600_000 / analysis.exposureMs : 0;
  const attemptsAgainstBaseline = analysis.exposureMs ? analysis.attemptsAgainst * 3_600_000 / analysis.exposureMs : 0;
  const attemptsMarginBaseline = attemptsForBaseline - attemptsAgainstBaseline;
  const config = {
    win: { label: "smoothed win-rate lift", unit: "pts", favorable: 1, value: item => actualReady ? (item.smoothedWinRate - teamWinRate) * 100 : item.winRateLift },
    margin: { label: "smoothed score-margin effect", unit: "/ 60", favorable: 1, value: item => actualReady ? item.smoothedMarginPer60 - teamMarginPer60 : item.scoreMarginLift },
    attemptsFor: { label: "smoothed attempts-for effect", unit: "/ 60", favorable: 1, value: item => actualReady ? item.smoothedAttemptsForPer60 - attemptsForBaseline : item.attemptsForEffect },
    attemptsAgainst: { label: "smoothed attempts-against effect", unit: "/ 60", favorable: -1, value: item => actualReady ? item.smoothedAttemptsAgainstPer60 - attemptsAgainstBaseline : item.attemptsAgainstEffect },
    attemptsMargin: { label: "smoothed attempts-margin effect", unit: "/ 60", favorable: 1, value: item => actualReady ? item.smoothedAttemptDifferentialPer60 - attemptsMarginBaseline : item.attemptsForEffect - item.attemptsAgainstEffect }
  }[metric];
  const rows = source.map(item => ({ ...item, effect: config.value(item) })).sort((a, b) => (b.effect - a.effect) * config.favorable).slice(0, 6);
  const max = Math.max(1, ...rows.map(item => Math.abs(item.effect)));
  return `<div class="position-outcome-list">${rows.map(item => {
    const favorable = item.effect * config.favorable >= 0;
    const width = Math.min(48, Math.abs(item.effect) / max * 46);
    return `<article><div><strong>${escapeHtml(item.name)}</strong><span>Formation</span><small>${actualReady ? `${Math.round(item.minutesMs / 60_000)} min sample` : "Demo sample"}</small></div><span class="impact-scale"><i class="impact-fill ${item.effect >= 0 ? "positive" : "negative"} ${favorable ? "favorable" : "unfavorable"}" style="--bar:${width}%"></i></span><b class="${favorable ? "positive-text" : "negative-text"}">${formatSigned(item.effect, config.unit === "pts" ? 0 : 1)} ${config.unit}</b></article>`;
  }).join("")}</div><p class="position-outcome-caption">${actualReady ? "Compared with this team's baseline. Low-minute formations are pulled more strongly toward that baseline." : "Demo preview"} · ${escapeHtml(config.label)} by formation.</p>${outcomeStatusHtml(readiness)}`;
}

function deploymentOutcomeHtml(analysis, metric, scope) {
  const isLine = scope === "line";
  const actualSource = isLine ? analysis.playerLines : analysis.playerPositions;
  const demoSource = isLine ? DEMO_ANALYSIS.playerLines : DEMO_ANALYSIS.playerPositions;
  const readiness = analysis.outcomeReadiness[isLine ? "lines" : "positions"][metric];
  const actualReady = readiness.ready && (metric === "win" || metric === "margin" ? actualSource.some(item => item.completedAppearances) : actualSource.length > 0);
  const source = actualReady ? actualSource : demoSource;
  const teamMargin = analysis.completedMatches ? analysis.scoreMargin / analysis.completedMatches : 0;
  const attemptsForBaseline = analysis.exposureMs ? analysis.attemptsFor * 3_600_000 / analysis.exposureMs : 0;
  const attemptsAgainstBaseline = analysis.exposureMs ? analysis.attemptsAgainst * 3_600_000 / analysis.exposureMs : 0;
  const attemptsMarginBaseline = attemptsForBaseline - attemptsAgainstBaseline;
  const config = {
    win: { label: "win-rate lift", unit: "pts", favorable: 1, value: item => actualReady ? (item.winRate - analysis.winRate) * 100 : item.winRateLift },
    margin: { label: "score-margin effect", unit: "goals", favorable: 1, value: item => actualReady ? item.scoreMargin - teamMargin : item.scoreMarginLift },
    attemptsFor: { label: "shots-for effect", unit: "/ 60", favorable: 1, value: item => actualReady ? item.attemptsForPer60 - attemptsForBaseline : item.attemptsForEffect },
    attemptsAgainst: { label: "shots-against effect", unit: "/ 60", favorable: -1, value: item => actualReady ? item.attemptsAgainstPer60 - attemptsAgainstBaseline : item.attemptsAgainstEffect },
    attemptsMargin: { label: "attempts-margin effect", unit: "/ 60", favorable: 1, value: item => actualReady ? item.attemptDifferentialPer60 - attemptsMarginBaseline : item.attemptsForEffect - item.attemptsAgainstEffect }
  }[metric];
  const rows = source.map(item => ({ ...item, effect: config.value(item) })).sort((a, b) => (b.effect - a.effect) * config.favorable).slice(0, 6);
  const max = Math.max(1, ...rows.map(item => Math.abs(item.effect)));
  return `<div class="position-outcome-list">${rows.map(item => {
    const favorable = item.effect * config.favorable >= 0;
    const width = Math.min(48, Math.abs(item.effect) / max * 46);
    const deploymentLabel = isLine ? item.line : positionName(item.position);
    return `<article><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(deploymentLabel)}</span><small>${Math.round(item.minutesMs / 60_000)} min sample</small></div><span class="impact-scale"><i class="impact-fill ${item.effect >= 0 ? "positive" : "negative"} ${favorable ? "favorable" : "unfavorable"}" style="--bar:${width}%"></i></span><b class="${favorable ? "positive-text" : "negative-text"}">${formatSigned(item.effect, config.unit === "pts" ? 0 : 1)} ${config.unit}</b></article>`;
  }).join("")}</div><p class="position-outcome-caption">${actualReady ? "Compared with this team's baseline." : "Demo preview"} · ${escapeHtml(config.label)}. ${isLine ? "Rank" : "Position"} minutes are shown only to explain sample size.</p>${outcomeStatusHtml(readiness)}`;
}

function timingBreakdownHtml(analysis, view, metric) {
  const readiness = analysis.outcomeReadiness.playerTime[metric];
  const actualReady = readiness.ready;
  const config = metricPresentation(metric);
  const bucketValue = bucket => metric === "win" ? bucket.winRate * 100
    : metric === "margin" ? bucket.marginPer60
      : metric === "attemptsFor" ? bucket.attemptsForPer60
        : metric === "attemptsAgainst" ? bucket.attemptsAgainstPer60
          : bucket.attemptDifferentialPer60 ?? bucket.attemptsForPer60 - bucket.attemptsAgainstPer60;
  if (view === "team") {
    const source = actualReady ? analysis.timing : DEMO_ANALYSIS.timing;
    const max = Math.max(1, ...source.map(item => Math.abs(bucketValue(item))));
    return `<div class="timing-list">${source.map(item => `<article><span>${escapeHtml(item.label)}</span><div><i class="${metric === "margin" && bucketValue(item) < 0 ? "negative" : ""}" style="width:${Math.min(100, Math.abs(bucketValue(item)) / max * 100)}%"></i></div><strong>${metricValueLabel(bucketValue(item), metric)}</strong></article>`).join("")}</div><p class="player-timing-caption">${escapeHtml(config.label)} by match phase.</p>${outcomeStatusHtml(readiness)}`;
  }
  const players = actualReady ? analysis.playerTiming : DEMO_ANALYSIS.playerTiming;
  const seasonPlayers = actualReady ? analysis.players : DEMO_ANALYSIS.players;
  return `${playerTimeRelationshipChartHtml(seasonPlayers, metric, actualReady)}<div class="player-timing-detail"><strong>Outcome by accumulated minutes played</strong><span>Player detail</span></div><div class="player-timing-table"><div class="player-timing-head"><span>Player</span><span>First 15 played</span><span>Next 15 played</span><span>After 30 played</span></div>${players.slice(0, 6).map(player => `<article><strong>${escapeHtml(player.name)}</strong>${player.buckets.map(bucket => `<span title="${escapeHtml(`${bucket.label} · ${config.label}`)}">${metricValueLabel(bucketValue(bucket), metric)}</span>`).join("")}</article>`).join("")}</div><p class="player-timing-caption">The graph summarizes the season; the table shows ${escapeHtml(config.label.toLowerCase())} during each player's accumulated minutes, even when they enter late or return after a substitution.</p>${outcomeStatusHtml(readiness)}`;
}

function averageTimeOutcomeHtml(analysis, metric) {
  const readiness = analysis.outcomeReadiness.fatigue[metric];
  const actualReady = readiness.ready;
  const source = actualReady ? analysis.playerTime : DEMO_ANALYSIS.timing;
  const outcomeValue = bucket => metric === "win" ? bucket.winRate * 100
    : metric === "margin" ? bucket.marginPer60
      : metric === "attemptsFor" ? bucket.attemptsForPer60
        : metric === "attemptsAgainst" ? bucket.attemptsAgainstPer60
          : bucket.attemptDifferentialPer60 ?? bucket.attemptsForPer60 - bucket.attemptsAgainstPer60;
  const chartMetricLabel = metric === "margin" ? "score margin per 60 minutes" : metricPresentation(metric).label.toLowerCase();
  const chartValueLabel = value => metric === "margin" ? `${formatSigned(value, 1)} / 60` : metricValueLabel(value, metric);
  const values = source.map(outcomeValue);
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  const padding = Math.max(metric === "win" ? 5 : .5, (maxValue - minValue) * .18);
  minValue -= padding;
  maxValue += padding;
  const left = 72, right = 690, top = 26, bottom = 232;
  const x = index => left + index * (right - left) / Math.max(1, source.length - 1);
  const y = value => bottom - (value - minValue) / (maxValue - minValue) * (bottom - top);
  const yTicks = [maxValue, (minValue + maxValue) / 2, minValue];
  const linePoints = source.map((bucket, index) => `${x(index)},${y(outcomeValue(bucket))}`).join(" ");

  return `<div class="time-outcome-chart-head"><div><strong>All-player average</strong><span>Accumulated time on field vs ${escapeHtml(chartMetricLabel)}</span></div><em>${actualReady ? "Your season" : "Demo preview"}</em></div><div class="time-outcome-chart average-time-chart"><svg viewBox="0 0 720 286" role="img" aria-label="Average outcome across all players by accumulated time on field">
    ${yTicks.map((tick, index) => { const tickY = top + index * (bottom - top) / 2; return `<line class="time-outcome-grid" x1="${left}" y1="${tickY}" x2="${right}" y2="${tickY}"></line><text class="time-outcome-axis" x="61" y="${tickY + 4}" text-anchor="end">${escapeHtml(chartValueLabel(tick))}</text>`; }).join("")}
    <line class="time-outcome-axis-line" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"></line>
    <polyline class="average-time-line" points="${linePoints}"></polyline>
    ${source.map((bucket, index) => `<g class="average-time-point" transform="translate(${x(index)} ${y(outcomeValue(bucket))})"><title>${escapeHtml(`${bucket.label}: ${chartValueLabel(outcomeValue(bucket))}`)}</title><circle r="7"></circle></g><text class="time-outcome-axis average-time-label" x="${x(index)}" y="254" text-anchor="middle">${escapeHtml(bucket.label)}</text>`).join("")}
    <text class="time-outcome-x-label" x="${(left + right) / 2}" y="279" text-anchor="middle">Accumulated minutes each player has played</text>
  </svg></div><p class="time-outcome-chart-caption">All player exposures are pooled into three time bands, allowing this team-level report to build sooner. Rates are normalized for exposure; the pattern is an association, not proof of causation.</p>${outcomeStatusHtml(readiness)}`;
}

function playerTimeRelationshipChartHtml(players, metric, actualReady) {
  const chartMetricLabel = metric === "margin" ? "score margin per 60 minutes" : metricPresentation(metric).label.toLowerCase();
  const chartValueLabel = value => metric === "margin" ? `${formatSigned(value, 1)} / 60` : metricValueLabel(value, metric);
  const outcomeValue = player => metric === "win" ? player.winRate * 100
    : metric === "margin" ? player.onFieldMarginPer60
      : metric === "attemptsFor" ? player.attemptsForPer60
        : metric === "attemptsAgainst" ? player.attemptsAgainstPer60
          : player.attemptDifferentialPer60;
  const points = players.filter(player => player.averageMinutes > 0 && Number.isFinite(outcomeValue(player))).map(player => ({
    name: player.name,
    minutes: player.averageMinutes,
    outcome: outcomeValue(player)
  }));
  if (!points.length) return `<div class="time-outcome-empty">Record player minutes to build the season relationship graph.</div>`;

  const left = 62, right = 700, top = 24, bottom = 250;
  const maxMinutes = Math.max(5, Math.ceil(Math.max(...points.map(point => point.minutes)) / 5) * 5);
  let minOutcome = Math.min(...points.map(point => point.outcome));
  let maxOutcome = Math.max(...points.map(point => point.outcome));
  const outcomePadding = Math.max(metric === "win" ? 5 : .5, (maxOutcome - minOutcome) * .16);
  minOutcome -= outcomePadding;
  maxOutcome += outcomePadding;
  const x = minutes => left + minutes / maxMinutes * (right - left);
  const y = outcome => bottom - (outcome - minOutcome) / (maxOutcome - minOutcome) * (bottom - top);
  const meanMinutes = points.reduce((sum, point) => sum + point.minutes, 0) / points.length;
  const meanOutcome = points.reduce((sum, point) => sum + point.outcome, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.minutes - meanMinutes) ** 2, 0);
  const slope = denominator ? points.reduce((sum, point) => sum + (point.minutes - meanMinutes) * (point.outcome - meanOutcome), 0) / denominator : 0;
  const intercept = meanOutcome - slope * meanMinutes;
  const firstMinutes = Math.min(...points.map(point => point.minutes));
  const lastMinutes = Math.max(...points.map(point => point.minutes));
  const initials = name => name.split(/\s+/).slice(0, 2).map(part => part[0] || "").join("").toUpperCase();
  const yTicks = [maxOutcome, (minOutcome + maxOutcome) / 2, minOutcome];
  const trend = points.length > 1 && lastMinutes > firstMinutes
    ? `<line class="time-outcome-trend" x1="${x(firstMinutes)}" y1="${y(intercept + slope * firstMinutes)}" x2="${x(lastMinutes)}" y2="${y(intercept + slope * lastMinutes)}"></line>`
    : "";

  return `<div class="time-outcome-chart-head"><div><strong>Season relationship</strong><span>Average time on field per appearance vs ${escapeHtml(chartMetricLabel)}</span></div><em>${actualReady ? "Your season" : "Demo preview"}</em></div><div class="time-outcome-chart"><svg viewBox="0 0 720 292" role="img" aria-label="Average player time on field compared with ${escapeHtml(chartMetricLabel)}">
    ${yTicks.map((tick, index) => { const tickY = top + index * (bottom - top) / 2; return `<line class="time-outcome-grid" x1="${left}" y1="${tickY}" x2="${right}" y2="${tickY}"></line><text class="time-outcome-axis" x="52" y="${tickY + 4}" text-anchor="end">${escapeHtml(chartValueLabel(tick))}</text>`; }).join("")}
    <line class="time-outcome-axis-line" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"></line>
    ${[0, maxMinutes / 2, maxMinutes].map(minutes => `<text class="time-outcome-axis" x="${x(minutes)}" y="271" text-anchor="middle">${Math.round(minutes)}m</text>`).join("")}
    ${trend}
    ${points.map(point => `<g class="time-outcome-point" transform="translate(${x(point.minutes)} ${y(point.outcome)})"><title>${escapeHtml(`${point.name}: ${point.minutes.toFixed(1)} average min, ${chartValueLabel(point.outcome)}`)}</title><circle r="10"></circle><text y="3" text-anchor="middle">${escapeHtml(initials(point.name))}</text></g>`).join("")}
    <text class="time-outcome-x-label" x="${(left + right) / 2}" y="289" text-anchor="middle">Average minutes on field per appearance</text>
  </svg></div><p class="time-outcome-chart-caption">Each point is a player; the line shows the season trend. This is an observed association, not proof that playing more or fewer minutes caused the outcome.</p>`;
}

function unlockFooter(readiness, detail) {
  return `<div class="unlock-footer ${readiness.ready ? "ready" : ""}"><span class="lock-mark">${readiness.ready ? "✓" : "○"}</span><div><strong>${readiness.ready ? "Report unlocked" : `${readiness.progress}% toward unlock`}</strong><small>${readiness.ready ? detail : `${readiness.needs}. ${detail}`}</small></div>${readiness.ready ? "" : `<span class="mini-progress"><i style="width:${readiness.progress}%"></i></span>`}</div>`;
}

function factorReportHtml(metric, filter) {
  const report = DEMO_FACTOR_REPORTS[metric] || DEMO_FACTOR_REPORTS.win;
  const factorKinds = { player: "Player", line: "Player + line", position: "Player + position" };
  const factors = report.factors.filter(factor => filter === "all" || factor.kind === factorKinds[filter]);
  const strongest = factors[0] || report.factors[0];
  const max = Math.max(1, ...factors.flatMap(factor => [Math.abs(factor.low), Math.abs(factor.high)]));
  const effect = factorEffectLabel(report, strongest.value);
  const favorable = strongest.value * report.favorable >= 0;
  return `<div class="factor-spotlight"><div><span>Strongest supported factor · ${escapeHtml(report.label)}</span><h4>${escapeHtml(strongest.name)}</h4><p>${escapeHtml(strongest.detail)} · 80% credible range ${factorEffectLabel(report, strongest.low)} to ${factorEffectLabel(report, strongest.high)}</p></div><strong class="${favorable ? "positive-text" : "negative-text"}">${effect}</strong></div>
    <div class="factor-table-head"><span>Factor</span><span>Estimated effect &amp; 80% credible range</span><span>Signal</span></div>
    <div class="factor-ranking">${factors.map((factor, index) => {
      const lowPosition = 50 + factor.low / max * 45;
      const highPosition = 50 + factor.high / max * 45;
      const estimatePosition = 50 + factor.value / max * 45;
      const isFavorable = factor.value * report.favorable >= 0;
      return `<article><span class="factor-rank">${index + 1}</span><div class="factor-name"><strong>${escapeHtml(factor.name)}</strong><small><em>${escapeHtml(factor.kind)}</em>${escapeHtml(factor.detail)}</small></div><div class="factor-estimate"><span class="credible-scale"><i style="left:${Math.min(lowPosition, highPosition)}%;width:${Math.abs(highPosition - lowPosition)}%"></i><b class="${isFavorable ? "favorable" : "unfavorable"}" style="left:${estimatePosition}%"></b></span><strong class="${isFavorable ? "positive-text" : "negative-text"}">${factorEffectLabel(report, factor.value)}</strong></div><span class="evidence-chip ${factor.evidence.toLowerCase()}">${escapeHtml(factor.evidence)}</span></article>`;
    }).join("")}</div>
    <p class="factor-caption">${escapeHtml(report.description)}. The dot is the posterior estimate; the line shows the range of plausible effects. Ranges crossing the center line remain uncertain.</p>`;
}

function factorEffectLabel(report, value) {
  const digits = report.unit === "pts" ? 0 : 1;
  return `${formatSigned(value, digits)} ${report.unit}`;
}

function bindAnalysisControls(analysis) {
  document.querySelectorAll("[data-analysis-team-back]").forEach(button => button.addEventListener("click", returnFromAnalysis));
  bindAnalysisReportLinks(analysis);
  document.querySelectorAll("[data-analysis-menu-back]").forEach(button => button.addEventListener("click", () => {
    $("#analysis-report-detail").classList.add("hidden");
    $("#analysis-report-menu").classList.remove("hidden");
    $("#setup-view").classList.remove("analysis-detail-open");
    window.scrollTo(0, 0);
  }));
  document.querySelectorAll("[data-playing-time-report] [data-playing-time-view]").forEach(button => button.addEventListener("click", () => {
    const controls = button.closest("[data-playing-time-report]");
    controls.querySelectorAll("[data-playing-time-view]").forEach(item => item.classList.toggle("active", item === button));
    $("#playing-time-list").innerHTML = playingTimeListHtml(analysis.readiness.playingTime.ready && analysis.players.length ? analysis.players : DEMO_ANALYSIS.players, button.dataset.playingTimeView);
  }));
  const guidancePlayer = document.querySelector("[data-position-guidance-player]");
  const guidanceControls = document.querySelector("[data-position-guidance-objective]");
  const renderGuidance = () => {
    if (!guidancePlayer || !guidanceControls) return;
    const objective = guidanceControls.querySelector("[data-guidance-objective].active")?.dataset.guidanceObjective || "balanced";
    const result = $("#position-guidance-result");
    result.innerHTML = positionGuidanceResultHtml(analysis, guidancePlayer.value, objective);
    bindAnalysisReportLinks(analysis, result);
  };
  guidancePlayer?.addEventListener("change", renderGuidance);
  guidanceControls?.querySelectorAll("[data-guidance-objective]").forEach(button => button.addEventListener("click", () => {
    guidanceControls.querySelectorAll("[data-guidance-objective]").forEach(item => item.classList.toggle("active", item === button));
    renderGuidance();
  }));
  document.querySelectorAll("[data-analysis-method-link]").forEach(button => button.addEventListener("click", () => openAnalysisMethod(analysis)));
}

function bindAnalysisReportLinks(analysis, root = document) {
  root.querySelectorAll("[data-open-analysis-report]").forEach(button => {
    if (button.dataset.analysisLinkBound) return;
    button.dataset.analysisLinkBound = "true";
    button.addEventListener("click", () => openAnalysisReport(analysis, button.dataset.openAnalysisReport));
  });
}

function openAnalysisReport(analysis, key) {
  const menu = $("#analysis-report-menu");
  const detail = $("#analysis-report-detail");
  detail.innerHTML = analysisReportDetailHtml(analysis, key);
  menu.classList.add("hidden");
  detail.classList.remove("hidden");
  $("#setup-view").classList.add("analysis-detail-open");
  bindAnalysisControls(analysis);
  window.scrollTo(0, 0);
}

function formatSigned(value, digits = 0) {
  const rounded = Number(value).toFixed(digits);
  return `${value > 0 ? "+" : ""}${rounded}`;
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
  window.scrollTo(0, 0);
  document.body.classList.add("match-open");
  $("#setup-view").classList.add("hidden");
  $("#match-view").classList.remove("hidden", "draft-match");
  switchTab("live");
  requestAnimationFrame(() => window.scrollTo(0, 0));
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
  recentSubstitutionState = recentSubstitutionChanges(state.timeline, Date.now());
  scheduleSubstitutionHighlightRefresh();
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
  $("#quick-team-name").textContent = c.team;
  $("#quick-opponent-name").textContent = c.opponent;
  $("#match-label").textContent = `${c.competition} · ${c.date}`;
  $("#score-for").textContent = state.scoreFor; $("#score-against").textContent = state.scoreAgainst;
  const gameClock = formatClock(displayedGameTime(events, state.elapsedMs));
  $("#clock-button").textContent = gameClock;
  $("#live-status").textContent = state.completed ? "FINAL" : state.periodRunning ? "LIVE" : state.currentPeriod ? "PAUSED" : "READY";
  $("#live-status").style.color = state.periodRunning ? "#c9ff5b" : "#ff9d4d";
  const halfToggle = $("#half-toggle");
  const secondHalf = state.currentPeriod === 2;
  halfToggle.classList.toggle("second-half", secondHalf);
  halfToggle.classList.toggle("hidden", c.periodCount !== 2);
  halfToggle.setAttribute("aria-checked", String(secondHalf));
  halfToggle.setAttribute("aria-label", `Switch to ${secondHalf ? "first" : "second"} half`);
  halfToggle.disabled = state.completed;
  renderMatchControls();
}

function scheduleSubstitutionHighlightRefresh() {
  clearTimeout(substitutionHighlightTimer);
  if (recentSubstitutionState.nextExpiryMs === null) return;
  const delay = Math.max(0, recentSubstitutionState.nextExpiryMs - Date.now() + 20);
  substitutionHighlightTimer = setTimeout(() => renderAt(clock?.elapsedMs ?? state.elapsedMs), delay);
}

function renderMatchControls() {
  const control = $("#match-control");
  control.classList.toggle("hidden", state.completed || (isBetweenPeriods() && state.currentPeriod >= state.config.periodCount));
  const running = Boolean(clock?.running);
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
  control.innerHTML = running
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>';
  control.setAttribute("aria-label", running ? "Pause timer" : state.currentPeriod ? "Resume timer" : "Start game");
  control.title = running ? "Pause timer" : state.currentPeriod ? "Resume timer" : "Start game";
}

function isBetweenPeriods() {
  const boundary = [...state.timeline].reverse().find(event => event.type === "period_started" || event.type === "period_ended");
  return boundary?.type === "period_ended";
}

function renderField() {
  $("#field-count").textContent = `${state.fieldCount} / ${state.config.playersOnField}`;
  $("#clear-field").disabled = state.fieldCount === 0;
  const recentChanges = recentSubstitutionState;
  const basePositions = activePositions();
  const positions = [...basePositions, ...Object.keys(state.field).filter(position => !basePositions.includes(position))];
  const renderPosition = (position, rowLength, index) => {
    const id = state.field[position];
    const column = positionColumn(position, rowLength, index);
    if (!id) return `<div class="empty-field-slot ${position === "gk" ? "keeper-slot" : ""}" style="grid-column:${column}" data-position="${escapeHtml(position)}"><span>＋</span><small>${escapeHtml(shortPosition(position))}</small></div>`;
    const p = state.players[id];
    const recentlyOn = recentChanges.on.has(id);
    return `<article class="player-card player-token ${id === state.goalkeeperId ? "gk" : ""} ${id === selectedPlayerId ? "selected" : ""} ${recentlyOn ? "recently-on" : ""}" style="grid-column:${column}" draggable="true" data-player-id="${escapeHtml(id)}" data-position="${escapeHtml(position)}" data-location="field" aria-label="${escapeHtml(`${p.name}, ${shortPosition(position)}, ${formatMinutes(p.currentStintMs)} in current shift${recentlyOn ? ", just moved on" : ""}`)}">${shirtHtml(id, p.name)}${playerTimeHtml(p.currentStintMs, "Time in current shift")}</article>`;
  };
  const bands = ["attack", "attacking-mid", "midfield", "utility", "defensive-mid", "defense", "keeper"];
  const bandCount = bands.filter(band => positions.some(position => positionBand(position) === band)).length;
  $("#field").classList.toggle("dense-layout", state.config.playersOnField >= 7 || bandCount >= 5);
  $("#field").innerHTML = bands.map(band => {
    const row = positions.filter(position => positionBand(position) === band);
    const centeredPair = band === "attack" && row.length === 2 ? " centered-pair" : "";
    return row.length ? `<div class="position-band position-band-${band}${centeredPair}" style="grid-template-columns:repeat(${Math.max(3, row.length)},minmax(0,1fr))">${row.map((position, index) => renderPosition(position, row.length, index)).join("")}</div>` : "";
  }).join("");
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
    await append("layout_changed", clock.elapsedMs, { name: layout.name, positions: layoutPositions(layout) }, false);
  };
}

function renderBench() {
  const recentChanges = recentSubstitutionState;
  const offFieldTime = player => Math.max(0, state.elapsedMs - (state.players[player.playerId]?.lastExitedAt ?? state.elapsedMs));
  const players = state.bench.filter(Boolean).sort((a, b) => offFieldTime(b) - offFieldTime(a) || a.name.localeCompare(b.name));
  const playerTokens = players.map(player => {
    const offFieldMs = offFieldTime(player);
    const recentlyOff = recentChanges.off.has(player.playerId);
    return `<article class="bench-card player-token ${player.playerId === selectedPlayerId ? "selected" : ""} ${recentlyOff ? "recently-off" : ""}" draggable="true" data-player-id="${escapeHtml(player.playerId)}" data-location="bench" aria-label="${escapeHtml(`${player.name}, resting ${formatMinutes(offFieldMs)}${recentlyOff ? ", just moved off" : ""}`)}">${shirtHtml(player.playerId, player.name)}${playerTimeHtml(offFieldMs, "Time off field")}</article>`;
  }).join("");
  $("#bench").innerHTML = `${playerTokens}<button id="add-player" class="add-player-tile" type="button" aria-label="Add players"><span class="add-player-icon" aria-hidden="true">+</span></button><div id="unavailable" class="unavailable-zone" aria-label="Not here"></div>`;
}

function renderUnavailable() {
  const unavailable = (state.unavailable || []).filter(Boolean);
  const recentChanges = recentSubstitutionState;
  const zone = $("#unavailable");
  zone.classList.toggle("has-players", unavailable.length > 0);
  zone.style.setProperty("--unavailable-columns", Math.min(unavailable.length + 1, 4));
  const playerTokens = unavailable.map(player => { const recentlyOff = recentChanges.off.has(player.playerId); return `<article class="bench-card player-token unavailable-card ${player.playerId === selectedPlayerId ? "selected" : ""} ${recentlyOff ? "recently-off" : ""}" draggable="true" data-player-id="${escapeHtml(player.playerId)}" data-location="unavailable" aria-label="${escapeHtml(`${player.name}${recentlyOff ? ", just moved off" : ""}`)}">${shirtHtml(player.playerId, player.name)}</article>`; }).join("");
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
  pointerDrag.ghost.style.left = `${event.clientX}px`;
  pointerDrag.ghost.style.top = `${event.clientY}px`;
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
  if (clock.running) {
    clock.pause();
    await append("clock_paused", clock.elapsedMs);
    setSaveStatus("Timer paused");
  }
  else { await append("clock_resumed", clock.elapsedMs); startClock(); }
}

function returnFromAnalysis() {
  $("#setup-view").classList.remove("analysis-open", "analysis-detail-open");
  $("#season-analysis-panel").classList.add("hidden");
  $("#analysis-method-panel").classList.add("hidden");
  $("#team-dashboard").classList.remove("hidden");
  window.scrollTo(0, 0);
}

async function toggleHalf() {
  if (state.completed || state.config.periodCount !== 2) return;
  const targetPeriod = state.currentPeriod === 2 ? 1 : 2;
  const wasRunning = Boolean(clock?.running);
  const toggle = $("#half-toggle");
  toggle.disabled = true;
  try {
    await append("period_started", clock?.elapsedMs || 0, { period: targetPeriod }, false);
    if (!wasRunning) await append("clock_paused", clock?.elapsedMs || 0, {}, false);
  } catch (error) {
    showActionError(error);
  } finally {
    toggle.disabled = state.completed;
  }
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

async function recordSimple(type, payload = {}) {
  if (state.completed) return;
  await append(type, clock?.elapsedMs || 0, payload);
}

function openGoalFor(preselectedPlayerId = "") {
  if (state.completed) return openMessage("Match complete", "Reopen or correct the match timeline to change the final score.");
  const { onField, offField } = orderedScorerGroups(state.field, state.bench);
  const shirt = (playerId, detail) => {
    const name = nameOf(playerId);
    return `<button type="button" class="goal-scorer ${playerId === preselectedPlayerId ? "selected" : ""}" data-scorer-id="${escapeHtml(playerId)}">${shirtHtml(playerId, name)}<strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></button>`;
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
      await append("goal_for", goalTimeMs, scorerId ? { playerId: scorerId } : {});
    } catch (error) {
      $("#dialog-error").textContent = error.message;
      document.querySelectorAll("[data-scorer-id]").forEach(option => { option.disabled = false; });
    }
  };
}

function showActionError(error) { openMessage("Could not save", error?.message || "Try again."); }

function openPlayerMenu(playerId) {
  const onField = Object.values(state.field).includes(playerId);
  const unavailable = state.unavailable?.some(player => player.playerId === playerId);
  let actions = "";
  if (onField && !state.completed) actions += `<button type="button" class="primary" data-player-action="goal">⚽ Goal by ${escapeHtml(nameOf(playerId))}</button><button type="button" class="secondary" data-player-action="attempt">↗ Attempt by ${escapeHtml(nameOf(playerId))}</button><button type="button" class="secondary" data-player-action="assist">Assist by ${escapeHtml(nameOf(playerId))}</button><button type="button" class="secondary" data-player-action="off">Move off field</button>`;
  else if (unavailable) actions += `<button type="button" class="secondary" data-player-action="restore">Move to off field</button>`;
  else actions += `<button type="button" class="secondary" data-player-action="absent">Move to not here</button>`;
  actions += `<button type="button" class="secondary" data-player-action="number">Jersey number${playerNumberOf(playerId) ? `: #${escapeHtml(playerNumberOf(playerId))}` : ""}</button>`;
  actions += `<button type="button" class="secondary danger-action" data-player-action="delete">Delete player</button>`;
  openDialog(nameOf(playerId), `<div class="dialog-fields action-list">${actions}</div>`, null, false);
  document.querySelectorAll("[data-player-action]").forEach(button => button.addEventListener("click", async () => {
    $("#action-dialog").close();
    if (button.dataset.playerAction === "goal") await recordSimple("goal_for", { playerId });
    if (button.dataset.playerAction === "attempt") await recordSimple("goal_attempt", { team: "for", playerId });
    if (button.dataset.playerAction === "assist") await recordSimple("assist_for", { playerId });
    if (button.dataset.playerAction === "off") await leaveForBench(playerId);
    if (button.dataset.playerAction === "restore") await moveToBench(playerId);
    if (button.dataset.playerAction === "absent") await markUnavailable(playerId);
    if (button.dataset.playerAction === "number") openEditPlayerNumber(playerId);
    if (button.dataset.playerAction === "delete") openDeletePlayer(playerId);
  }));
}

function openEditPlayerNumber(playerId) {
  const player = team?.players.find(item => item.playerId === playerId);
  if (!player) return openMessage("Player not found", "This player is not in the current team roster.");
  openDialog("Jersey number", `<div class="dialog-fields"><label>${escapeHtml(player.name)}<input class="player-number-input" name="playerNumber" inputmode="numeric" pattern="[0-9]{1,2}" maxlength="2" placeholder="No number" value="${escapeHtml(player.number || "")}" autofocus></label><p class="hint">Saved with the team only. Changing this does not add or alter a match event.</p></div>`, async data => {
    const number = normalizePlayerNumber(data.get("playerNumber"));
    if (number) player.number = number;
    else delete player.number;
    await persistTeams();
    renderAt(clock?.elapsedMs || state.elapsedMs);
    setSaveStatus("Jersey number saved");
  });
  $("#dialog-confirm").textContent = "Save";
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
    $("#analysis-method-panel").classList.add("hidden");
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
  $("#analysis-method-panel").classList.add("hidden");
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

const MANUAL_TIMELINE_TYPES = ["goal_for", "goal_against", "goal_attempt", "player_moved", "clock_adjusted", "note_added"];

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
  if (type === "goal_attempt") return `<label>Team<select name="attemptTeam"><option value="for" ${p.team !== "against" ? "selected" : ""}>${escapeHtml(state.config.team)}</option><option value="against" ${p.team === "against" ? "selected" : ""}>${escapeHtml(state.config.opponent)}</option></select></label>`;
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
  if (type === "goal_attempt") return { team: data.get("attemptTeam") === "against" ? "against" : "for" };
  if (type === "clock_adjusted") { const displayTimeMs = parseClock(data.get("displayTime")); if (displayTimeMs === null) throw new Error("Enter displayed time as minutes:seconds."); return { displayTimeMs }; }
  if (type === "player_moved") return { moves: [{ playerId: requirePlayer("playerId"), from: data.get("from") || "off_field", to: data.get("to") }] };
  if (type === "note_added") { const note = String(data.get("note") || "").trim(); if (!note) throw new Error("Enter note details."); return { category: data.get("category"), note }; }
  return structuredClone(existing);
}

function renderReportDetails() {
  const timeline = activeTimeline(events);
  const goals = timeline.filter(event => ["goal_for", "goal_against"].includes(event.type));
  const attempts = timeline.filter(event => event.type === "goal_attempt");
  const attemptsFor = attempts.filter(event => event.payload?.team !== "against").length;
  const attemptsAgainst = attempts.length - attemptsFor;
  const attemptMax = Math.max(1, attemptsFor, attemptsAgainst);
  const lineupChanges = timeline.filter(event => event.type === "player_moved").length;
  const result = state.scoreFor > state.scoreAgainst ? "Win" : state.scoreFor < state.scoreAgainst ? "Loss" : "Draw";
  $("#match-report-summary").innerHTML = `<article><span>${state.completed ? "Result" : "Current result"}</span><strong>${state.scoreFor}–${state.scoreAgainst}</strong><small>${result}</small></article><article><span>Played</span><strong>${formatMinutes(state.elapsedMs)}</strong><small>${state.config.periodCount} × ${state.config.periodMinutes} min format</small></article><article><span>Lineup changes</span><strong>${lineupChanges}</strong><small>Substitutions and moves</small></article><article><span>Attempt diff.</span><strong class="${attemptsFor >= attemptsAgainst ? "positive-text" : "negative-text"}">${attempts.length ? formatSigned(attemptsFor - attemptsAgainst) : "—"}</strong><small>${attempts.length ? `${attemptsFor} for · ${attemptsAgainst} against` : "No attempts recorded"}</small></article>`;
  const matchEvents = timeline.filter(event => ["goal_for", "goal_against", "goal_attempt"].includes(event.type));
  $("#match-event-flow").innerHTML = matchEventGraphHtml(matchEvents);
  $("#goal-player-groups").innerHTML = goalPlayerGroupsHtml(timeline, goals);
  $("#attempts-report").innerHTML = attempts.length ? `<div class="match-attempt-bars"><article><div><span>${escapeHtml(state.config.team)}</span><strong>${attemptsFor}</strong></div><i><b style="width:${attemptsFor / attemptMax * 100}%"></b></i></article><article class="against"><div><span>${escapeHtml(state.config.opponent)}</span><strong>${attemptsAgainst}</strong></div><i><b style="width:${attemptsAgainst / attemptMax * 100}%"></b></i></article></div><p class="hint">Attempts are associated with the lineup on the field when each event was recorded.</p>` : "<p class='hint'>Use the Attempt buttons during the match to compare attacking pressure. Attempt tracking is optional.</p>";
  $("#minutes-report").innerHTML = Object.values(state.players).sort((a, b) => b.totalMs - a.totalMs).map(p => `<article class="minute-row"><strong>${escapeHtml(p.name)}</strong><span>${p.totalMs ? "On field" : "Did not play"}</span><b>${formatMinutes(p.totalMs)}</b></article>`).join("");
  const groupedStints = groupLineupStints(state.stints);
  const groupingNote = groupedStints.length < state.stints.length ? "<p class='hint'>Lineup changes within one minute are grouped as one substitution.</p>" : "";
  $("#stints-report").innerHTML = groupingNote + (groupedStints.map(stint => `<div class="stint-row"><strong>${formatClock(stint.startMs)}–${formatClock(stint.endMs)}</strong><span>${stint.goalsFor}–${stint.goalsAgainst}</span><span>${Object.entries(stint.field).map(([pos, id]) => `${nameOf(id)} (${shortPosition(pos)})`).join(", ")}</span></div>`).join("") || "<p class='hint'>Stints appear after the clock advances.</p>");
}

function matchEventGraphHtml(matchEvents) {
  if (!matchEvents.length) return "<p class='hint'>Goals and optional attempts will appear here in game order.</p>";
  const plotted = matchEvents.map(event => ({ event, timeMs: displayedGameTime(events, event.gameTimeMs, event.sequence) }));
  const maxMs = Math.max(60_000, displayedGameTime(events, state.elapsedMs), ...plotted.map(item => item.timeMs));
  const left = 58, right = 366, forY = 47, againstY = 104, axisY = 143;
  const x = timeMs => left + Math.min(1, Math.max(0, timeMs / maxMs)) * (right - left);
  let scoreFor = 0, scoreAgainst = 0;
  const marks = plotted.map(({ event, timeMs }) => {
    const against = event.type === "goal_against" || (event.type === "goal_attempt" && event.payload?.team === "against");
    const goal = event.type !== "goal_attempt";
    if (event.type === "goal_for") scoreFor += 1;
    if (event.type === "goal_against") scoreAgainst += 1;
    const scorer = event.payload?.playerId ? state.players[event.payload.playerId]?.name : null;
    const detail = `${formatClock(timeMs)} · ${against ? state.config.opponent : state.config.team} · ${goal ? `Goal${scorer ? ` by ${scorer}` : ""} · ${scoreFor}–${scoreAgainst}` : `Attempt${scorer ? ` by ${scorer}` : ""}`}`;
    const eventX = x(timeMs), eventY = against ? againstY : forY;
    return goal
      ? `<g class="event-mark goal ${against ? "against" : "for"}" transform="translate(${eventX} ${eventY})"><title>${escapeHtml(detail)}</title><circle r="10"></circle><text y="3" text-anchor="middle">G</text></g>`
      : `<g class="event-mark attempt ${against ? "against" : "for"}" transform="translate(${eventX} ${eventY})"><title>${escapeHtml(detail)}</title><circle r="5"></circle></g>`;
  }).join("");
  const ticks = [0, maxMs / 2, maxMs];
  return `<div class="event-graph-legend"><span><i class="goal-key"></i>Goal</span><span><i class="attempt-key"></i>Attempt</span></div><div class="event-graph"><svg viewBox="0 0 380 165" role="img" aria-label="Goals and attempts over match time"><rect class="event-lane for" x="${left}" y="29" width="${right - left}" height="36" rx="8"></rect><rect class="event-lane against" x="${left}" y="86" width="${right - left}" height="36" rx="8"></rect><text class="event-lane-label" x="49" y="51" text-anchor="end">For</text><text class="event-lane-label" x="49" y="108" text-anchor="end">Against</text><line class="event-axis" x1="${left}" y1="${axisY}" x2="${right}" y2="${axisY}"></line>${ticks.map(tick => `<line class="event-tick" x1="${x(tick)}" y1="${axisY - 3}" x2="${x(tick)}" y2="${axisY + 3}"></line><text class="event-time-label" x="${x(tick)}" y="158" text-anchor="middle">${formatClock(tick)}</text>`).join("")}${marks}</svg></div>`;
}

function goalPlayerGroupsHtml(timeline, goals) {
  const trackedPlayers = Object.values(state.players).filter(player => player.totalMs > 0).sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map(trackedPlayers.map(player => [player.playerId, { for: 0, against: 0 }]));
  goals.forEach(goal => {
    const throughGoal = timeline.filter(event => event.gameTimeMs < goal.gameTimeMs || (event.gameTimeMs === goal.gameTimeMs && event.sequence <= goal.sequence));
    const atGoal = projector.project(throughGoal, goal.gameTimeMs);
    Object.values(atGoal.field).filter(Boolean).forEach(playerId => {
      if (!counts.has(playerId)) return;
      counts.get(playerId)[goal.type === "goal_for" ? "for" : "against"] += 1;
    });
  });
  const sideHtml = (side, title, descending = false) => {
    const max = Math.max(0, ...[...counts.values()].map(value => value[side]));
    const pointValues = Array.from({ length: max + 1 }, (_, points) => points);
    if (descending) pointValues.reverse();
    const rows = pointValues.map(points => {
      const names = trackedPlayers.filter(player => counts.get(player.playerId)[side] === points).map(player => player.name);
      return `<article><strong>${points}</strong><div><span>${points === 1 ? "goal" : "goals"}</span><p>${names.length ? names.map(escapeHtml).join(" · ") : "No players"}</p></div></article>`;
    });
    return `<section><h3>${title}</h3>${rows.join("")}</section>`;
  };
  if (!trackedPlayers.length) return "<p class='hint'>Player groups appear after field time is tracked.</p>";
  return `${sideHtml("for", "Goals for", true)}${sideHtml("against", "Goals against")}`;
}

function renderReport() { renderReportDetails(); }

function switchTab(view) {
  document.querySelectorAll(".tab").forEach(tab => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active);
  });
  ["live", "timeline", "report"].forEach(name => $("#" + name + "-panel").classList.toggle("hidden", name !== view));
  $("#field-scoreboard").classList.toggle("hidden", view !== "live");
  if (view === "timeline") renderTimeline(); if (view === "report") renderReport();
}

function openDialog(title, body, handler, showConfirm = true, closeOnConfirm = true) {
  const dialog = $("#action-dialog"), form = $("#action-form"), confirm = $("#dialog-confirm");
  $("#dialog-title").textContent = title; $("#dialog-body").onclick = null; $("#dialog-body").innerHTML = body; $("#dialog-error").textContent = "";
  confirm.textContent = "Confirm";
  confirm.classList.remove("danger-confirm");
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
function setSaveStatus(text, error = false) {
  if (error) $("#header-team-name").textContent = text;
}
function nameOf(id) { return state.players[id]?.name || state.config?.roster.find(p => p.playerId === id)?.name || "Unknown"; }
function playerNumberOf(id) { return team?.players.find(player => player.playerId === id)?.number || ""; }
function shortPlayerName(name) {
  const firstName = String(name || "").trim().split(/\s+/)[0] || "?";
  return Array.from(firstName.toUpperCase()).slice(0, 4).join("");
}
function shirtHtml(id, name) {
  return `<span class="shirt-icon"><span class="shirt-name">${escapeHtml(shortPlayerName(name))}</span><span class="shirt-number">${escapeHtml(playerNumberOf(id))}</span></span>`;
}
function playerTimeHtml(ms, title) {
  const minutes = Math.floor(ms / 60_000);
  const label = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return `<span class="player-time" title="${escapeHtml(title)}" aria-label="${label}"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"></circle><path d="M10 5.5v5l3 2"></path></svg><span>${minutes}</span></span>`;
}
function normalizePlayerNumber(value) {
  const number = String(value ?? "").trim();
  if (number && !/^\d{1,2}$/.test(number)) throw new Error("Use a jersey number from 0 to 99.");
  return number;
}
function playerOptions(ids, selected) { const ordered = selected && ids.includes(selected) ? [selected, ...ids.filter(id => id !== selected)] : ids; return ordered.map(id => `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(nameOf(id))}</option>`).join(""); }
function optionList(values, selected) { return values.map(value => `<option ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`).join(""); }
function moveDestinationName(value) { return ({ off_field: "Off field", not_here: "Not here" })[value] || positionName(value); }
function moveDestinationOptions(selected) { const positions = [...activePositions(), ...(!["off_field", "not_here"].includes(selected) && !activePositions().includes(selected) ? [selected] : [])]; return ["off_field", "not_here", ...positions].map(value => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(moveDestinationName(value))}</option>`).join(""); }
function eventTypeName(type) { return ({ goal_for: "Goal for", assist_for: "Assist for", goal_against: "Goal against", goal_attempt: "Goal attempt", player_moved: "Player moved", note_added: "Note", clock_adjusted: "Game time changed", clock_paused: "Clock stopped", clock_resumed: "Clock started", period_started: "Half started", period_ended: "Half time", match_completed: "Game ended" })[type] || type.replaceAll("_", " "); }
function eventTypeOptions(types, selected) { return types.map(type => `<option value="${type}" ${type === selected ? "selected" : ""}>${escapeHtml(eventTypeName(type))}</option>`).join(""); }
function formatClock(ms) { const total = Math.floor(ms / 1000); return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function formatMinutes(ms) { return `${Math.floor(ms / 60_000)} min`; }
function parseClock(value) { const match = String(value).match(/^(\d+):([0-5]\d)$/); return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : null; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]); }
function normalizeTeamPlayers(players) {
  const seen = new Set();
  return (Array.isArray(players) ? players : []).filter(player => player?.name).map(player => {
    const name = String(player.name).trim();
    const normalized = { ...player, playerId: playerIdFromName(name), name };
    const number = String(player.number ?? "").trim();
    if (/^\d{1,2}$/.test(number)) normalized.number = number;
    else delete normalized.number;
    return normalized;
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
function positionName(position) { return ({ gk: "Goalkeeper", forward_striker: "Striker", forward_left: "Left forward", forward_right: "Right forward", forward_left_wing: "Left wing", forward_right_wing: "Right wing", mid_attacking_left: "Left attacking midfield", mid_attacking_center: "Central attacking midfield", mid_attacking_right: "Right attacking midfield", mid_defensive_left: "Left defensive midfield", mid_defensive_center: "Central defensive midfield", mid_defensive_right: "Right defensive midfield", mid_left: "Left midfield", mid_left_center: "Left center midfield", mid_center: "Center midfield", mid_right_center: "Right center midfield", mid_right: "Right midfield", back_left_fullback: "Left fullback", back_left_center: "Left center back", back_center: "Center back", back_right_center: "Right center back", back_right_fullback: "Right fullback" })[position] || position || "Unknown"; }
function shortPosition(position) { return ({ gk: "GK", forward_striker: "ST", forward_left: "LF", forward_right: "RF", forward_left_wing: "LW", forward_right_wing: "RW", mid_attacking_left: "LAM", mid_attacking_center: "CAM", mid_attacking_right: "RAM", mid_defensive_left: "LDM", mid_defensive_center: "CDM", mid_defensive_right: "RDM", mid_left: "LM", mid_left_center: "LCM", mid_center: "CM", mid_right_center: "RCM", mid_right: "RM", back_left_fullback: "LB", back_left_center: "LCB", back_center: "CB", back_right_center: "RCB", back_right_fullback: "RB" })[position] || position; }
function formationLine(role, count) {
  const lines = {
    defense: { 0: [], 1: ["back_center"], 2: ["back_left_fullback", "back_right_fullback"], 3: ["back_left_fullback", "back_center", "back_right_fullback"], 4: ["back_left_fullback", "back_left_center", "back_right_center", "back_right_fullback"] },
    midfield: { 0: [], 1: ["mid_center"], 2: ["mid_left", "mid_right"], 3: ["mid_left", "mid_center", "mid_right"], 4: ["mid_left", "mid_left_center", "mid_right_center", "mid_right"], 5: ["mid_left", "mid_left_center", "mid_center", "mid_right_center", "mid_right"] },
    attack: { 0: [], 1: ["forward_striker"], 2: ["forward_left", "forward_right"], 3: ["forward_left_wing", "forward_striker", "forward_right_wing"] },
    "attacking-mid": { 0: [], 1: ["mid_attacking_center"], 2: ["mid_attacking_left", "mid_attacking_right"], 3: ["mid_attacking_left", "mid_attacking_center", "mid_attacking_right"] },
    "defensive-mid": { 0: [], 1: ["mid_defensive_center"], 2: ["mid_defensive_left", "mid_defensive_right"], 3: ["mid_defensive_left", "mid_defensive_center", "mid_defensive_right"] }
  };
  return lines[role][count] || [];
}
function formationPositions([defenders, midfielders, attackers]) { return [...formationLine("attack", attackers), ...formationLine("midfield", midfielders), ...formationLine("defense", defenders), "gk"]; }
function layoutPositions(layout) { return layout.lines ? [...layout.lines.flatMap(([role, count]) => formationLine(role, count)), "gk"] : formationPositions(layout.shape); }
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
  return ({ match_created: "Match created", starting_lineup_confirmed: "Field started empty", layout_changed: `Layout changed to ${payload.name}`, period_started: `Period ${payload.period} started`, clock_paused: "Clock paused", clock_resumed: "Clock resumed", clock_adjusted: `Game time set to ${formatClock(payload.displayTimeMs)}`, period_ended: `Period ${payload.period} ended`, player_added: payload.player?.playerId ? `${nameOf(payload.player.playerId)} added` : "Player added", player_removed: `${nameOf(payload.playerId)} deleted`, goal_for: payload.playerId ? `Goal by ${nameOf(payload.playerId)}` : "Goal for", assist_for: `Assist by ${nameOf(payload.playerId)}`, goal_against: "Goal against", goal_attempt: payload.playerId ? `Attempt by ${nameOf(payload.playerId)}` : payload.team === "against" ? "Opponent goal attempt" : "Our goal attempt", note_added: payload.category || "Note", match_completed: "Match completed", event_retracted: "Event undone", event_replaced: "Event corrected" })[event.type] || event.type;
}
function eventDetail(event) {
  const p = event.payload || {};
  if (event.type === "player_moved") return (p.moves || []).map(move => `${nameOf(move.playerId)}: ${moveDestinationName(move.from)} → ${moveDestinationName(move.to)}`).join(" · ");
  if (event.type === "note_added") return p.note;
  return new Date(event.realTimestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
