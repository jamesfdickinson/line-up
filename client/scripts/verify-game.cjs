// Run against a local Vite server: NODE_PATH=<Playwright package root> node scripts/verify-game.cjs
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const url = process.env.TEST_URL || "http://127.0.0.1:4175";
const artifacts = path.join(__dirname, "../.verification");

async function seed(page, minutes = 10, size = 3) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#no-team-panel:not(.hidden), [data-open-match]'));
  await page.evaluate(async ({ minutes, size }) => {
    const { EventStore } = await import("/src/storage/event-store.js");
    const store = await new EventStore().open();
    const roster = Array.from({ length: size + 5 }, (_, index) => ({ playerId: `p${index + 1}`, name: `Player ${index + 1}`, status: "available" }));
    const positions = size === 3 ? ["forward_striker", "back_center", "gk"] : ["forward_left", "forward_striker", "forward_right", "mid_left", "mid_center", "mid_right", "back_left_fullback", "back_left_center", "back_right_center", "back_right_fullback", "gk"];
    const config = { teamId: "test-team", team: "Test team", opponent: "Visitors", periodCount: 2, periodMinutes: 45, playersOnField: size, roster, positions, layoutName: size === 3 ? "1-1" : "4-3-3", date: "2026-09-18", competition: "Test" };
    const make = (sequence, type, gameTimeMs, payload = {}) => ({ eventId: `event-${sequence}`, matchId: "test-game", sequence, type, gameTimeMs, payload, timeSource: "automatic", realTimestamp: new Date().toISOString() });
    await store.replaceAll({ meta: [{ key: "teams", value: [{ teamId: "test-team", name: "Test team", players: roster, format: size }] }, { key: "activeTeamId", value: "test-team" }], events: [
      make(1, "match_created", 0, config),
      make(2, "starting_lineup_confirmed", 0, { assignments: positions.map((position, index) => ({ position, playerId: `p${index + 1}` })), goalkeeperId: `p${size}` }),
      make(3, "period_started", 0, { period: 1 }),
      make(4, "clock_paused", minutes * 60_000)
    ] });
    store.db.close();
  }, { minutes, size });
  await page.reload();
  await page.locator('[data-open-match="test-game"]').click();
  await page.locator('#field [data-player-id="p1"]').waitFor();
}

async function stored(page) {
  return page.evaluate(async () => {
    const { EventStore } = await import("/src/storage/event-store.js");
    const { LineupProjector } = await import("/src/domain/lineup-projector.js");
    const store = await new EventStore().open();
    const events = await store.eventsFor("test-game");
    const teams = (await store.getMeta("teams")).value;
    store.db.close();
    return { events, teams, state: new LineupProjector().project(events) };
  });
}

async function run(touch) {
  const browser = await chromium.launch({ headless: true, channel: process.env.TEST_BROWSER || "msedge" });
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const press = async selector => { const locator = page.locator(selector); if (touch) await locator.tap(); else await locator.click(); };
  const player = id => `#live-panel [data-player-id="${id}"]`;
  const stage = async (incoming, outgoing) => { await press(player(incoming)); await press(player(outgoing)); };
  const menu = async id => { await press(player(id)); await press(player(id)); await page.locator('#action-dialog[open]').waitFor(); };
  const close = async () => page.locator('#action-dialog [value="cancel"]').first().click();
  const save = async () => { await page.locator('#dialog-confirm').click(); await page.locator('#action-dialog').waitFor({ state: 'hidden' }); };
  const drag = async (id, x, y) => {
    await page.locator(player(id)).scrollIntoViewIfNeeded();
    const rect = await page.locator(`${player(id)} .shirt-icon`).boundingBox();
    const from = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    if (touch) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
      for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (x - from.x) * step / 8, y: from.y + (y - from.y) * step / 8, id: 1 }] });
      assert.equal(await page.locator('.drag-ghost.player-drag-circle').count(), 1, 'Touch drag preview must be only the round player magnet');
      assert.equal(await page.locator('.drag-ghost .player-time, .drag-ghost .shirt-name').count(), 0, 'Touch drag preview must not include card details');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 8 });
      assert.equal(await page.locator('.native-drag-image.player-drag-circle').count(), 1, 'Mouse drag preview must be only the round player magnet');
      assert.equal(await page.locator('.native-drag-image .player-time, .native-drag-image .shirt-name').count(), 0, 'Mouse drag preview must not include card details');
      await page.mouse.up();
    }
  };
  try {
    await seed(page);
    assert.equal(await page.locator('#game-settings').count(), 0);
    await page.locator('#more-actions').click();
    await page.locator('[data-action="settings"]').click();
    assert.equal(await page.locator('#dialog-title').textContent(), 'Game settings');
    await close();
    // Second tap must work rapidly, including the captured touch click.
    await menu("p4");
    assert.equal(await page.locator("#dialog-title").textContent(), "Player 4");
    await close();
    await page.locator("#stage-substitutions").check();
    await stage("p4", "p1");
    assert.equal(await page.locator("[data-substitution-line]").count(), 1);
    assert.equal((await stored(page)).state.field.forward_striker, "p1");
    await stage("p5", "p1");
    assert.equal(await page.locator('[data-substitution-line][data-player-in="p5"][data-player-out="p1"]').count(), 1);
    assert.equal(await page.locator("#pending-substitutions button").count(), 2);
    await stage("p6", "p2");
    assert.equal(await page.locator("[data-substitution-line]").count(), 2);
    const queuedDragTarget = await page.locator('#field [data-player-id="p3"] .shirt-icon').boundingBox();
    await drag('p7', queuedDragTarget.x + queuedDragTarget.width / 2, queuedDragTarget.y + queuedDragTarget.height / 2);
    assert.equal(await page.locator("[data-substitution-line]").count(), 3);
    await page.screenshot({ path: path.join(artifacts, `${touch ? "phone" : "desktop"}-pending.png`), fullPage: true });
    await stage("p7", "p3");
    assert.equal(await page.locator("[data-substitution-line]").count(), 2);
    await stage("p5", "p1");
    assert.equal(await page.locator("[data-substitution-line]").count(), 1);
    await stage("p5", "p1");
    const before = await stored(page);
    await page.locator('[data-confirm-substitutions]').click();
    await page.waitForFunction(() => document.querySelector('#field [data-player-id="p5"]') && document.querySelector('#field [data-player-id="p6"]'));
    const confirmed = await stored(page);
    assert.equal(confirmed.events.length, before.events.length + 1);
    assert.equal(confirmed.events.at(-1).payload.moves.length, 4);
    assert.equal(confirmed.state.players.p5.lastEnteredAt, confirmed.state.players.p6.lastEnteredAt);
    assert.equal(confirmed.state.players.p1.totalMs, 600_000);
    assert.equal(confirmed.state.players.p5.totalMs, 0);
    await page.locator('[data-view="timeline"]').click();
    await page.locator(`[data-edit="${confirmed.events.at(-1).eventId}"]`).click();
    await save();
    assert.equal((await stored(page)).state.timeline.find(item => item.eventId === confirmed.events.at(-1).eventId).payload.moves.length, 4, 'Editing a batch must preserve all moves');
    await page.locator('[data-view="live"]').click();
    await stage("p4", "p5");
    await page.locator("#stage-substitutions").uncheck();
    await page.waitForFunction(() => !document.querySelector('[data-substitution-line]'));
    assert.equal(await page.locator("[data-substitution-line]").count(), 0);
    assert.equal((await stored(page)).state.field.forward_striker, "p5");
    await stage("p4", "p5");
    await page.waitForFunction(() => document.querySelector('#field [data-player-id="p4"]'));
    assert.equal(await page.locator("[data-substitution-line]").count(), 0);
    if (process.env.VERIFY_STAGE_ONLY) {
      assert.deepEqual(errors, [], "No unhandled browser errors");
      console.log(`${touch ? "Touch/phone" : "Mouse/desktop"}: staged substitution lines, queue, cancel and confirm checks passed.`);
      return;
    }

    // Add two extra players from their popup, without changing the formation.
    for (const [id, position] of [["p1", "extra_1"], ["p2", "extra_2"]]) {
      await menu(id);
      await page.locator('[data-player-action="enter"]').click();
      await page.locator('[name="position"]').selectOption(position);
      await save();
      await page.locator(`#field [data-position="${position}"]`).waitFor();
    }
    let data = await stored(page);
    assert.equal(data.state.fieldCount, 5);
    assert.equal(data.state.config.playersOnField, 3);
    assert.deepEqual(data.state.errors, []);
    await menu("p1");
    await page.locator('[data-player-action="position"]').click();
    await page.locator('[name="x"]').fill("27");
    await page.locator('[name="y"]').fill("62");
    await save();
    assert.deepEqual((await stored(page)).state.config.extraLocations.extra_1, { x: 27, y: 62 });
    const fieldRect = await page.locator('#field').boundingBox();
    await drag('p1', fieldRect.x + fieldRect.width * .3, fieldRect.y + fieldRect.height * .3);
    await page.waitForFunction(async () => {
      const { EventStore } = await import('/src/storage/event-store.js');
      const store = await new EventStore().open();
      const events = await store.eventsFor('test-game'); store.db.close();
      return events.at(-1)?.type === 'extra_positioned' && events.at(-1).payload.y < 40;
    });
    assert.equal(await page.locator('#action-dialog[open]').count(), 0, 'Dragging must not open a menu');

    // Rename on-field player, rejecting whitespace and preserving the identity.
    await menu("p1");
    await page.locator('[data-player-action="name"]').click();
    await page.locator('[name="playerName"]').fill("   ");
    await page.locator('#dialog-confirm').click();
    assert.match(await page.locator('#dialog-error').textContent(), /Enter a player name/);
    await page.locator('[name="playerName"]').fill("Renamed Player");
    await save();
    data = await stored(page);
    assert.equal(data.state.players.p1.name, "Renamed Player");
    assert.equal(data.teams[0].players.find(item => item.playerId === "p1").name, "Renamed Player");
    assert.equal(data.state.field.extra_1, "p1");
    await menu("p1");
    await page.locator('[data-player-action="name"]').click();
    await page.locator('[name="playerName"]').fill("Canceled name");
    await close();
    assert.equal((await stored(page)).state.players.p1.name, "Renamed Player");

    await page.locator('#more-actions').click();
    await page.locator('[data-action="settings"]').click();
    await page.locator('[name="syncHalfClock"]').check();
    await page.locator('[name="periodMinutes"]').fill("45");
    await save();
    const preHalf = await stored(page);
    await page.locator('#half-toggle').click();
    await page.waitForFunction(() => document.querySelector('#clock-button').textContent === "45:00");
    data = await stored(page);
    assert.deepEqual(data.state.players, preHalf.state.players);
    assert.equal(data.state.periodRunning, false);
    assert.equal(data.events.at(-1).gameTimeMs, 600_000);
    await page.locator('[data-view="timeline"]').click();
    assert.equal(await page.locator('.timeline-event time').first().textContent(), "10:00");
    await page.locator('[data-view="live"]').click();
    await page.screenshot({ path: path.join(artifacts, `${touch ? "phone" : "desktop"}-extras.png`), fullPage: true });
    await page.reload();
    await page.locator('[data-open-match="test-game"]').click();
    await page.locator('#field [data-player-id="p1"]').waitFor();
    assert.match(await page.locator('#field [data-player-id="p1"]').getAttribute('aria-label'), /Renamed Player/);
    assert.equal(await page.locator('#clock-button').textContent(), "45:00");
    await menu("p2");
    await page.locator('[data-player-action="off"]').click();
    await page.locator('#bench [data-player-id="p2"]').waitFor();
    assert.equal((await stored(page)).state.fieldCount, 4);

    // Disabled sync leaves the display alone; enabled sync can move backward.
    await seed(page, 50);
    await page.locator('#half-toggle').click();
    assert.equal(await page.locator('#clock-button').textContent(), "50:00");
    await page.locator('#half-toggle').click();
    await page.locator('#more-actions').click();
    await page.locator('[data-action="settings"]').click();
    await page.locator('[name="syncHalfClock"]').check();
    await save();
    const beforeBackward = await stored(page);
    await page.locator('#half-toggle').click();
    await page.waitForFunction(() => document.querySelector('#clock-button').textContent === "45:00");
    assert.deepEqual((await stored(page)).state.players, beforeBackward.state.players);
    await page.locator('#half-toggle').click();
    await page.locator('#match-control').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#live-status').textContent === 'LIVE');
    await page.locator('#half-toggle').click();
    assert.equal((await stored(page)).state.periodRunning, true);
    await page.locator('#match-control').click({ force: true });
    await page.waitForFunction(() => document.querySelector('#live-status').textContent === 'PAUSED');
    const runningSync = await stored(page);
    assert.ok(runningSync.state.players.p1.totalMs >= 3_000_000 && runningSync.state.players.p1.totalMs < 3_010_000);

    await seed(page, 10, 11);
    await page.locator('#stage-substitutions').check();
    await stage("p12", "p3");
    await stage("p13", "p10");
    const dragTarget = await page.locator('#field [data-player-id="p2"] .shirt-icon').boundingBox();
    await drag('p14', dragTarget.x + dragTarget.width / 2, dragTarget.y + dragTarget.height / 2);
    await page.waitForFunction(() => document.querySelectorAll('[data-substitution-line]').length === 3);
    assert.equal((await stored(page)).state.field.forward_striker, 'p2');
    assert.equal(await page.locator('#action-dialog[open]').count(), 0);
    await stage('p14', 'p2');
    assert.equal(await page.locator('[data-substitution-line]').count(), 2);
    await page.screenshot({ path: path.join(artifacts, `${touch ? "phone" : "desktop"}-11-player-pending.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, "The game must not overflow horizontally");
    await page.locator('[data-cancel-substitutions]').click();
    assert.equal(await page.locator('[data-substitution-line]').count(), 0);
    assert.equal((await stored(page)).state.fieldCount, 11);
    await page.reload();
    await page.locator('[data-open-match="test-game"]').click();
    await page.locator('#field [data-player-id="p1"]').waitFor();
    assert.equal(await page.locator('#stage-substitutions').isChecked(), true, 'Staging preference persists');
    for (const [id, position, count] of [['p12', 'extra_1', 12], ['p13', 'extra_2', 13]]) {
      await menu(id);
      await page.locator('[data-player-action="enter"]').click();
      await page.locator('[name="position"]').selectOption(position);
      await save();
      assert.equal((await stored(page)).state.fieldCount, count - 1);
      await page.locator('[data-confirm-substitutions]').click();
      await page.locator(`#field [data-player-id="${id}"]`).waitFor();
      assert.equal((await stored(page)).state.fieldCount, count);
    }
    await menu('p12');
    await page.locator('[data-player-action="off"]').click();
    assert.equal((await stored(page)).state.fieldCount, 13);
    await page.locator('[data-confirm-substitutions]').click();
    await page.locator('#bench [data-player-id="p12"]').waitFor();
    assert.equal((await stored(page)).state.fieldCount, 12);
    assert.deepEqual(errors, [], "No unhandled browser errors");
    console.log(`${touch ? "Touch/phone" : "Mouse/desktop"}: substitution, extra player, popup, rename, persistence and halftime checks passed.`);
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, `${touch ? "phone" : "desktop"}-failure.png`), fullPage: true });
    console.error("Browser errors:", errors);
    throw error;
  } finally { await browser.close(); }
}

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const modes = process.env.VERIFY_MODE === "desktop" ? [false] : process.env.VERIFY_MODE === "touch" ? [true] : [false, true];
  for (const touch of modes) await run(touch);
})().catch(error => { console.error(error); process.exitCode = 1; });
