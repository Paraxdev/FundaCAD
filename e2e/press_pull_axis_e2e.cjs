// Press/pull along a hole's axis, in a real browser.
//
// Scene: a 40x40x20 block with a 16 mm blind hole from the top, 2 mm of
// straight wall and then a 45 degree cone floor down to z 0.
//
//   1. Picking the cone floor offers "Along axis" beside the value and starts
//      on it, since the face is the end of a hole; the arrow stands on the
//      hole's axis and points up it.
//   2. The switch goes to "Along normal" and back, and the arrow follows.
//   3. Dragging the arrow into the part and committing stores a press/pull
//      with direction "axis" and a negative distance that builds cleanly.
//
// Shots: 01_picked, 02_along_normal, 03_dragging, 04_committed.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5953/ SC_ENGINE_PORT=8953 \
//     node e2e/press_pull_axis_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "press_pull_axis_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const line = (id, a, b) => ({ type: "line", id, x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
const polygon = (pts) => pts.map((p, i) => line(`l${i}`, p, pts[(i + 1) % pts.length]));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript((port) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) { super(String(u).replace(":8765", `:${port}`), p); }
    }
    window.WebSocket = P;
  }, ENGINE_PORT);
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const settle = async () => {
    await page.waitForTimeout(400);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(400);
  };
  const screen = (p) => page.evaluate((p) => {
    const v = window.viewport; const V = v.camera.position.constructor;
    return v.projectToScreen(new V(p[0], p[1], p[2]));
  }, p);
  const tool = () => page.evaluate(() => {
    const t = window.pressPull;
    const r = (v) => [v.x, v.y, v.z].map((c) => Math.round(c * 1000) / 1000);
    return { active: t.active, direction: t.direction, anchor: r(t.anchor), axis: r(t.axis), value: t.value };
  });
  const button = () => page.evaluate(() => {
    const b = document.querySelector(".dim-input .dim-direction");
    return b ? { text: b.textContent, on: b.classList.contains("on"), shown: b.style.display !== "none" } : null;
  });

  await page.evaluate(async (hole) => {
    window.store.loadDocument({ parameters: {}, features: [
      { id: "block", type: "box", length: 40, width: 40, height: 20 },
      { id: "hole_sk", type: "sketch", plane: "XZ", entities: hole },
      { id: "hole", type: "revolve", sketch: "hole_sk", axis: "Z", angle: 360, operation: "cut", targets: ["body1"] },
    ] });
    await window.store.rebuildNow();
  }, polygon([[0, 11], [8, 11], [8, 8], [0, 0]]));
  await settle();
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1000);

  // A point on the floor cone on the far side of the hole from the camera, the side the opening shows.
  const far = await page.evaluate(() => {
    const c = window.viewport.camera.position;
    const n = Math.hypot(c.x, c.y) || 1;
    return [(-c.x / n) * 6, (-c.y / n) * 6, 6];
  });
  const at = await screen(far);
  await page.evaluate(() => window.__fundacad.handleAction("presspull"));
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => window.pressPull.direction === "axis", null, { timeout: 15000 }).catch(() => {});
  await settle();
  let t = await tool();
  let b = await button();
  check("picking the floor cone starts the tool", t.active, t);
  check("the box offers Along axis and starts on it", !!b && b.shown && b.on && b.text === "Along axis", b);
  check("the arrow stands on the hole's axis and points up it",
    t.direction === "axis" && Math.abs(t.anchor[0]) < 1e-3 && Math.abs(t.anchor[1]) < 1e-3 &&
    Math.abs(t.axis[2] - 1) < 1e-3, t);
  const modeToggle = await page.$(".dim-input .dim-toggle");
  check("the operation button is still the box's toggle", !!modeToggle && (await modeToggle.textContent()) === "Auto");
  await shot("01_picked");

  const flip = async () => {
    await page.evaluate(() => document.querySelector(".dim-input .dim-direction")
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
    await page.waitForTimeout(300);
  };
  await flip();
  t = await tool();
  b = await button();
  check("the switch goes to Along normal", b && !b.on && b.text === "Along normal" && t.direction === "normal", { b, t });
  await settle();
  await shot("02_along_normal");
  await flip();
  t = await tool();
  b = await button();
  check("and back to Along axis", b && b.on && b.text === "Along axis" && t.direction === "axis", { b, t });
  await settle();

  // The handle runs 5 to 45 px up the arrow from its anchor, constant on screen.
  const grip = await page.evaluate(() => {
    const t = window.pressPull; const v = window.viewport;
    const k = v.pixelWorldSize(t.anchor);
    const p = t.anchor.clone().addScaledVector(t.axis, k * 25);
    const s = v.projectToScreen(p);
    const s0 = v.projectToScreen(t.anchor);
    return { x: s.x, y: s.y, dx: s.x - s0.x, dy: s.y - s0.y, hit: t.hitGizmo(s.x, s.y) };
  });
  check("the arrow is under the pointer where it is drawn", grip.hit, grip);
  const len = Math.hypot(grip.dx, grip.dy) || 1;
  const [ux, uy] = [grip.dx / len, grip.dy / len];
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(grip.x - ux * 5 * i, grip.y - uy * 5 * i);
    await page.waitForTimeout(40);
  }
  await settle();
  t = await tool();
  check("dragging the arrow down pushes into the part", t.value < -1, t);
  await shot("03_dragging");
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await settle();
  await page.waitForTimeout(800);
  await settle();

  const pp = await page.evaluate(() => window.store.document.features.filter((f) => f.type === "press-pull"));
  check("one press/pull is stored", pp.length === 1, pp);
  const f = pp[0] || {};
  check("it carries direction axis and a negative distance", f.direction === "axis" && typeof f.distance === "number" && f.distance < 0, f);
  check("with no taper and no mode", f.taper === undefined && f.mode === undefined, f);
  const state = await page.evaluate(() => ({
    err: window.store.buildState.errorFeatureId ?? null,
    bodies: (window.store.buildState.result?.bodies ?? []).length,
    notes: (window.store.buildState.result?.diagnostics ?? []).filter((d) => d.feature_id === window.store.document.features.at(-1).id),
  }));
  check("it builds, one body, with nothing to say", state.err === null && state.bodies === 1 && state.notes.length === 0, state);
  await shot("04_committed");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
