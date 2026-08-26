# LineUp JD

LineUp JD is an offline-first, event-sourced live soccer tracker built as a Vite-powered JavaScript progressive web app. The product requirements remain at `../LIVE_SOCCER_TRACKER_REQUIREMENTS.md`; this directory contains the complete client application.

The live tracker remains static and offline-first. Match setup, the clock, events, projections, corrections, quick reports, and exports run in the browser and persist in IndexedDB. Deep Bayesian analysis can optionally be requested from a separate server.

## Run locally

```powershell
npm install
npm run dev
```

Use the URL printed by Vite. The service worker is disabled during development so it cannot interfere with hot reload.

Create the production site with:

```powershell
npm run build
```

Deploy the generated `dist/` directory to any static host. `npm run preview` can be used to inspect that build locally. Serving from localhost or HTTPS enables offline installation.

Run the domain tests with:

```powershell
node --test
```

## Analysis status

The analysis page shows model status and the last-updated time but does not expose a manual analysis-request control. Demo model output remains available until server-produced results are connected.

## What is included

- Match, roster, lineup, position, goalkeeper, and rotation setup
- One-step match creation with pregame configuration embedded on the game page
- Drag-and-drop or tap-to-select field/bench substitutions and position swaps
- Minimal live view centered on `On field`, `Off field`, and one `Score` action
- Portrait-phone layout that keeps the live field, off-field row, score, and controls within the viewport
- Team → match hierarchy with a persistent team roster and match list
- Multi-team start menu for adding, switching, and deleting teams with their matches
- Matches can be permanently deleted from the match menu without deleting the team roster
- Players are added from the game page and automatically retained for every future team match
- A player's trimmed name is their player ID; to change it, delete the old player and add the new identity
- Every formation has one dedicated keeper position; its occupant is assigned goalkeeper automatically
- The dedicated keeper position is anchored at the bottom center of the field
- New matches start with blank positional slots and every available player off-field
- Dragging an on-field player into the off-field area always removes them without switching another player in
- One-tap, undoable `Clear field` action moves the full lineup to the bench
- Draggable `Not here` lane keeps absent players visible and lets them move back to `Off field`
- Players are represented by draggable shirt silhouettes with their initials, without surrounding cards
- Player taps open a context menu; on-field players can be recorded as the scorer
- Team goals allow a player or `Unknown`, while movement events do not show undo popups
- Pitch-mounted score controls sit beside the attacking and defending goals; More is in the top-right header
- Match analysis ties each goal for/against to the exact on-field player-position lineup
- Season analysis link from the team page
- Progressive reports with model status, last-updated time, and a linked methodology page
- Pooled time-on-field outcome trends that unlock early, plus higher-evidence player-specific time reports
- Formation outcome reporting based on exact formation stints, including changes made during a match
- Monotonic live clock with period controls and manual correction
- One monotonic Start/Stop tracking clock; halftime pauses it and the second half continues from the same elapsed value without resets or clock corrections
- One `player_moved` event covers entering, leaving, field positions, goalkeeper, not-here status, swaps, substitutions, and clearing the field
- Saved position IDs contain both group and exact role, such as `forward_striker`, `mid_center`, `back_left_fullback`, and `gk`; no separate group lookup is required
- Append-only IndexedDB event history with undo and correction events
- Reconstructed field, bench, player/position/GK minutes, and lineup stints
- Explainable playing-time suggestions; LineUp JD never changes the lineup itself
- Offline app shell and refresh recovery
- Complete JSON backup and reproducible event CSV export

## Architecture

Domain behavior is kept separate from rendering:

- `MatchClock` owns live monotonic timing.
- `MatchEvent` validates immutable event records and resolves corrections.
- `EventStore` persists the ordered history in IndexedDB.
- `LineupProjector` derives all current state and reports from events.
- `SuggestionEngine` provides transparent, rule-based rotation guidance.

IndexedDB is the durable browser adapter. A future Capacitor native wrapper can provide a SQLite `EventStore` implementation without changing the domain or UI behavior.

The analysis server remains an independent deployment. This repository contains the analysis status UI but no server runtime or API routes.
