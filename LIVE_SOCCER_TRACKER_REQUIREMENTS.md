# Live soccer tracker and substitution assistant — future requirements

## 1. Purpose

Build a sideline-friendly application that always knows:

- Who is on the field and on the bench
- Each on-field player's current position
- Who is playing goalkeeper
- How long every player has played, rested, and played continuously
- When every substitution, position change, and goal occurred
- Which lineup was on the field for every goal for and against

The application should be useful immediately as a playing-time and substitution assistant. After enough games, the same event data should support lineup, position, player, and pair analysis.

The app must not claim that a player caused a result. Analysis should use terms such as *modeled association*, *on-field rate*, and *estimated contribution*.

## 2. Primary use cases

### During a match

1. Start a match with a roster, starting lineup, positions, and goalkeeper.
2. Run a game clock with period/half controls.
3. Record a substitution with as few taps as possible.
4. Move a player between positions without treating it as a substitution.
5. Record a goal for or against at the current game time.
6. Correct or undo an accidental event.
7. See current and total minutes for every player.
8. Receive understandable suggestions about who may need rest and who has waited longest.

### After a match

1. Review and correct the event timeline.
2. Confirm the match as complete.
3. See player minutes, position minutes, and continuous stint lengths.
4. See goals for, goals against, and margin while each player or pair was on the field.
5. Export durable data for analysis and backup.

### After multiple matches

1. Compare formations and positions.
2. Estimate on/off and adjusted player associations.
3. Analyze pairs only when together and separate minutes are sufficient.
4. Use saved historical analysis as one input to substitution suggestions.

## 3. Important design principle: record events, derive everything else

The permanent source of truth should be an append-only match event timeline. Do not store only a changing current lineup.

Example events:

```text
00:00  period_started
00:00  starting_lineup_confirmed
08:14  goal_for
11:30  player_out: Alex, player_in: Jordan, position: left_mid
17:05  position_change: Jordan left_mid -> striker
22:41  goal_against
25:00  period_ended
```

The application derives lineup stints between events:

| Start | End | Duration | Goals for | Goals against | Lineup and positions |
|---:|---:|---:|---:|---:|---|
| 0:00 | 8:14 | 8:14 | 1 | 0 | Starting lineup |
| 8:14 | 11:30 | 3:16 | 0 | 0 | Starting lineup |
| 11:30 | 17:05 | 5:35 | 0 | 0 | Jordan at left midfield |

This design allows all minutes, score rates, on/off comparisons, and later models to be recalculated after a correction.

## 4. Match setup requirements

Before starting the clock, capture:

- Team
- Season and competition
- Match date
- Opponent
- Opponent-strength category or rating
- Home/away only if fields or conditions actually differ
- Scheduled period count and duration
- Roster available for the match
- Starting on-field players
- Starting position for each player
- Starting goalkeeper
- Players who are unavailable or injured
- Whether the match record is expected to be complete

Player and position names must use stable identifiers rather than free-text spelling on every match.

## 5. Live match interface requirements

### Field and bench

- Show a simple field containing every occupied position.
- Show the bench beside the field.
- Display player name, position, current stint time, and total minutes.
- Clearly identify the goalkeeper.
- Prevent the number of players on the field from exceeding the configured format.
- Allow a position to be temporarily empty when playing short.

### Required actions

- Substitute: select an on-field player and a bench player, then confirm.
- Swap positions between two on-field players.
- Move one player to a different position.
- Change goalkeeper.
- Record goal for.
- Record goal against.
- Start, pause, resume, and end a period.
- Add a note, injury, card, or unusual event.
- Undo the most recent event.
- Edit the time or details of an earlier event from the timeline.

### Sideline usability

- Optimize for a phone or tablet in bright light.
- Use large touch targets and high contrast.
- Keep the interface intentionally simple; fewer choices are better.
- Show only the controls required for the current match state.
- Put uncommon settings and corrections behind progressive disclosure.
- Provide sensible defaults so normal match operation requires almost no configuration.
- Give each screen one obvious primary action where practical.
- Prefer direct actions such as `Goal for`, `Goal against`, and `Substitute` over menus.
- Do not expose analytical or technical model settings to coaches during match operation.
- Keep common events within one or two taps plus confirmation.
- Show an obvious undo action after every write.
- Autosave immediately after every confirmed event.
- Continue working without internet access.
- Never lose the match because the browser refreshes or the device sleeps.
- Clearly show when data has not yet been persisted.

A visual drag-and-drop field may eventually use a dedicated JavaScript UI component. The first version should use simple position selectors and substitution controls if they are faster and more reliable on the sideline.

### Client implementation constraints

- Implement the web client in modern, pure JavaScript, not TypeScript.
- Prefer standard HTML, CSS, JavaScript, browser APIs, and ES modules.
- Organize domain behavior into small JavaScript classes with clear responsibilities.
- Avoid large frontend frameworks unless a later requirement cannot reasonably be met without one.
- Minimize runtime dependencies and build-tool complexity.
- Keep match rules and event processing separate from DOM rendering so they can be tested without a browser UI.
- Favor explicit, readable code over metaprogramming, elaborate state libraries, or deep abstraction layers.
- Use a native wrapper such as Capacitor only as a thin platform layer around the same web client.

Suggested class boundaries include:

```text
MatchClock       — period and game-time behavior
MatchState       — current field, bench, positions, and score
MatchEvent       — validated event representation
EventStore       — local persistence and ordered event history
LineupProjector  — rebuild current state and stints from events
SyncClient       — offline queue and server synchronization
ReportClient     — download and cache published server reports
```

The centralized analytics service may use Python or another appropriate server language behind an API. The pure-JavaScript requirement applies to the CoachJD web/native client and does not require duplicating server-side training algorithms in the browser.

## 6. Clock requirements

- Use a monotonic running clock so device wall-clock changes do not alter match time.
- Store both game time and real timestamp for each event.
- Support count-up and count-down display without changing stored event time.
- Support multiple periods and halftime.
- Allow manual clock correction.
- Record whether time was entered automatically or manually.
- Establish deterministic ordering when two events have the same displayed time.

## 7. Immediate substitution assistant

The app can be useful before any machine-learning history exists. Initial suggestions should be based on transparent playing-time rules.

### Live values

- Total minutes played
- Current continuous stint
- Minutes on bench since last appearance
- Minutes at each position
- Goalkeeper minutes
- Target minutes based on roster size and match duration
- Difference between actual and target minutes

### Configurable alerts

- Player has exceeded a maximum continuous stint.
- Player has rested longer than a configured threshold.
- Player is substantially below target minutes.
- Player is substantially above target minutes.
- Position has not rotated for a configured period.
- Goalkeeper rotation is due.
- Injured or unavailable player must not be suggested.

### Suggestions

A suggestion must state its reason, for example:

```text
Consider Jordan for Alex:
- Alex has played 14 continuous minutes.
- Jordan has rested 9 minutes.
- This keeps both players close to their target playing time.
```

The coach always confirms or ignores a suggestion. The app must never change the lineup automatically.

Suggested modes:

- Equal playing time
- Competitive balance
- Development/position rotation
- Custom targets by player

## 8. Later analysis-informed suggestions

Model-based suggestions should be introduced only after support requirements are met. They should combine, not replace, current fatigue and playing-time information.

Potential inputs:

- Historical position-specific on-field rates
- Current lineup and pair associations
- Current score and time remaining
- Opponent strength
- Player workload and bench time
- Injury/availability constraints
- Formation requirements

Every recommendation should show:

- Proposed player in and player out
- Proposed position
- Expected directional change, if supported
- Playing-time impact
- Historical support: matches, minutes together, and minutes separate
- Uncertainty or low-support warning

The app should load saved analysis results during a match. It must not train or retrain analytical models on the device, on every substitution, or during live play.

### Authoritative server-side analytics

All teams and devices must use one server-side analytics pipeline as the single source of truth for trained models and published results.

The device is responsible for:

- Capturing match events while online or offline
- Maintaining the current clock, lineup, positions, and playing-time totals
- Showing the most recently downloaded published analysis
- Queuing completed matches and corrections for synchronization

The server is responsible for:

- Validating synchronized event timelines
- Reconstructing lineup stints
- Producing player, position, formation, and pair statistics
- Training all adjusted statistical or machine-learning models
- Running whole-game validation and bootstrap uncertainty
- Versioning datasets, model configurations, and published results
- Publishing one consistent report set back to every authorized device

After a match is confirmed and synchronized, the server should enqueue an analysis job. The device should show analysis status such as `waiting to sync`, `processing`, `published`, or `failed`. Correcting a historical event should create a new dataset version and trigger a complete recalculation of affected reports.

CoachJD may calculate temporary live minute totals and simple arithmetic on the device, but those calculations are operational displays rather than a second training pipeline. The server's published result is authoritative.

## 9. Data model

### Player

- `player_id`
- Display name
- Active/inactive status
- Default positions
- Goalkeeper eligibility
- Optional team membership

### Match

- `match_id`
- Team, season, date, opponent, and strength
- Scheduled duration and format
- Start/end timestamps
- Completion and data-quality status

### Match roster

- `match_id`, `player_id`
- Available, unavailable, injured
- Planned minute target
- Starting status and starting position

### Event

- Stable `event_id`
- `match_id`
- Event type
- Game time and real timestamp
- Player(s) and position(s), when applicable
- Goal direction, when applicable
- Lineup snapshot hash or version
- Note
- Created/edited metadata
- Correction relationship; do not silently overwrite history

### Derived stint

- `match_id`, start, end, duration
- Score state at start
- Goals/shots for and against during stint
- On-field player and position assignments
- Goalkeeper
- Formation

Use SQLite for the local durable event queue in the first native implementation, with CSV and JSON export. The synchronized server database is the durable system of record across devices. UI session state may hold temporary interaction state but must not be the permanent match database.

## 10. Optional high-value events

Goals alone may remain sparse at approximately five per game. If practical, also record:

- Shots for and against
- Shots on target
- High-quality chances
- Penalties
- Red/yellow cards

These events can provide earlier tactical signals than goals. They should be optional so live tracking does not become too burdensome.

## 11. Analysis requirements

### Descriptive reports

- Minutes and continuous stint distribution
- Position minutes
- Goals/shots for and against per match-equivalent
- On-field margin rate
- On/off differences
- Formation and lineup rates
- Substitution before/after summaries
- Score-state and opponent-strength breakdowns

### Adjusted models

Prefer conservative, regularized models appropriate for small and correlated data:

- Separate goals-for and goals-against rate models with stint duration as exposure
- Regularized adjusted plus-minus for score margin
- Position and season controls
- Game-clustered bootstrap uncertainty
- Shrinkage toward zero for low-support players and pairs

Do not treat stints from the same match as fully independent games.

### Reliability fields

Every player and pair result should include:

- Matches
- Minutes on field
- Minutes off field
- Minutes together
- Minutes where each played separately
- Number of goals/events supporting the estimate
- Confidence or uncertainty interval
- Positive/negative sign stability across resamples
- Low-support warning

## 12. Expected usefulness during an 8–10 match season

- Matches 1–2: reliable minute tracking and substitution reminders; analysis is descriptive only.
- Matches 3–4: early formation, position, and on/off tendencies.
- Matches 5–6: preliminary adjusted player and lineup associations when there is sufficient variation.
- Matches 8–10: useful directional coaching signals for supported players and combinations, still not definitive rankings.

Two teams may be pooled for general tactical or position analysis only when rules, competition level, and data definitions are compatible. Player effects should not be pooled across unrelated rosters without a team control.

## 13. Suggested implementation phases

### Phase 1 — reliable live tracker

- Match setup
- Clock and periods
- Field, positions, goalkeeper, and bench
- Substitutions and position changes
- Goals for/against
- Undo/edit timeline
- Autosaved SQLite data
- Match review and export

### Phase 2 — workload and substitution help

- Current/total/bench minutes
- Playing-time targets
- Continuous-stint and rest alerts
- Explainable rule-based substitution suggestions
- Post-match minutes and on-field rate reports

### Phase 3 — analysis

- Server-side analysis job and versioned published results
- Derived stints
- On/off, formation, and position reports
- Regularized adjusted plus-minus
- Uncertainty and support reporting
- Pair analysis with minimum-minute filters

### Phase 4 — analysis-informed live guidance

- Load the latest saved historical model
- Combine modeled associations with current workload and constraints
- Explain and rank possible substitutions
- Preserve coach control and log accepted/ignored suggestions

## 14. Acceptance criteria for the first version

1. A coach can set a lineup and begin a match in under two minutes.
2. A normal substitution can be recorded in under five seconds after familiarity.
3. Every player-minute is reconstructable from the event log.
4. Every goal is associated with the correct lineup and positions.
5. Undo and timeline corrections recalculate all derived minutes and stints.
6. Closing and reopening the browser does not lose confirmed events.
7. The application works without internet during a match.
8. The final on-field player count is validated after every lineup event.
9. Exported data is sufficient to reproduce all reports independently.
10. No live recommendation is presented without an understandable reason.

## 15. Decisions required before implementation

- Match format and number of players on the field for each team
- Period count, duration, and clock rules
- Allowed position vocabulary and formations
- Whether substitutions are unlimited and whether players may re-enter
- Whether both teams share players
- Device type and whether multiple coaches need simultaneous access
- Whether the app must synchronize across devices during a match
- Equal-time, competitive, or custom substitution policy
- Which optional events can realistically be recorded without distracting the coach
- Player privacy and access rules, especially if the players are minors

## 16. Integration with the existing project

The current whole-game attendance pipeline should remain available for historical data. The future tracker should produce a new event dataset, synchronize it to the server, and derive stints there rather than forcing detailed events into the existing one-row-per-game CSV.

After a match is confirmed, it may also generate a compatible whole-game summary row for the existing pipeline. Detailed models should consume the event-derived stint table, while the existing models continue to consume game summaries.
