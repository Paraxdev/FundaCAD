// Touchpad and touchscreen input in the running app, against the engine.
//
// Touchpad (sent the way Chromium sends a precision touchpad, through CDP
// mouseWheel with small fractional deltas): two-finger scroll orbits and keeps
// the model's centre on screen, Shift with it pans without turning, a pinch
// (ctrl+wheel) zooms about the pointer, and a mouse notch still zooms. The
// settings switch scroll to pan, and forcing "mouse" makes a scroll zoom.
//
// Touchscreen (CDP touch events): one finger orbits, a tap selects the body
// under it and turns nothing, two fingers pinch, three orbit, a long press
// opens the viewport menu, a double tap reaches the viewport as a dblclick, a
// pinch over the panels does not zoom the page, a long press on a tree row
// opens its menu, and in a sketch two taps draw a line with the camera still.
// Screenshots after every step.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> [SC_CHROME=<chromium>] [SC_URL=http://localhost:5173/]
//   node e2e/touch_navigation_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "touch_navigation_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.goto(`${URL}?token=${TOKEN}&nav=v2`);
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }
  await page.evaluate(() => localStorage.removeItem("fundacad.navigation"));

  const cdp = await context.newCDPSession(page);
  const idle = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(400);
  };
  const settle = () => page.waitForTimeout(900);
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

  await page.evaluate(async () => {
    window.store.loadDocument({ parameters: {}, features: [
      { id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: 40, height: 30, x: 0, y: 0 }] },
      { id: "e1", type: "extrude", sketch: "s1", distance: 20, operation: "new" },
    ] });
    await window.store.rebuildNow();
  });
  await idle();
  const reset = async () => {
    await page.evaluate(() => window.viewport.resetCamera());
    await page.waitForTimeout(1200);
  };
  await reset();

  const centre = await page.evaluate(() => {
    const b = window.viewport.model.box;
    return b.getCenter(new b.min.constructor()).toArray();
  });
  const pose = () => page.evaluate(() => {
    const rig = window.viewport.rig;
    return { t: rig.getTarget().toArray(), d: rig.viewDirection().toArray(), scale: rig.viewScale() };
  });
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const screenOf = (p) => page.evaluate((q) => {
    const V = window.viewport.rig.getTarget().constructor;
    return window.viewport.projectToScreen(new V(...q));
  }, p);
  const mid = await screenOf(centre);
  const cx = Math.round(mid.x), cy = Math.round(mid.y);

  // What the page sees of each wheel, for the record.
  await page.evaluate(() => {
    window.__wheels = [];
    window.addEventListener("wheel", (e) => window.__wheels.push({ dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, wd: e.wheelDeltaY, ctrl: e.ctrlKey, shift: e.shiftKey }), { capture: true, passive: true });
  });
  const pad = async (x, y, dx, dy, modifiers = 0) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, modifiers });
    await page.waitForTimeout(16);
  };

  // --- touchpad ----------------------------------------------------------------
  await shot("01_start.png");
  let p0 = await pose();
  for (let i = 0; i < 30; i++) await pad(cx, cy, 6.5, 1.25);
  await settle();
  let p1 = await pose();
  check("touchpad: two-finger scroll orbits", angle(p0.d, p1.d) > 0.3, { turned: angle(p0.d, p1.d) });
  const back = await screenOf(centre);
  check("touchpad: the model stays on screen while it turns", back.x > 0 && back.x < 1400 && back.y > 0 && back.y < 900, back);
  console.log("    wheel as seen:", JSON.stringify((await page.evaluate(() => window.__wheels.slice(0, 2)))));
  await shot("02_touchpad_orbit.png");

  await reset();
  p0 = await pose();
  for (let i = 0; i < 20; i++) await pad(cx, cy, 0.5, 6.25, 8);
  await settle();
  p1 = await pose();
  check("touchpad: Shift with the scroll pans and does not turn", angle(p0.d, p1.d) < 1e-6 && dist(p0.t, p1.t) > 1, { turned: angle(p0.d, p1.d), moved: dist(p0.t, p1.t) });
  await shot("03_touchpad_pan.png");

  await reset();
  const corner = await screenOf([20, -15, 20]);
  const kx = Math.round(corner.x), ky = Math.round(corner.y);
  const anchor = await page.evaluate(([x, y]) => window.viewport.orbitPivotAt(x, y)?.toArray(), [kx, ky]);
  p0 = await pose();
  for (let i = 0; i < 25; i++) await pad(kx, ky, 0, -3.5, 2);
  await settle();
  p1 = await pose();
  const after = anchor ? await screenOf(anchor) : { x: NaN, y: NaN };
  check("touchpad: a pinch zooms in", p1.scale < p0.scale * 0.8, { from: p0.scale, to: p1.scale });
  check("touchpad: the pinch keeps the point under the pointer", Math.hypot(after.x - kx, after.y - ky) < 2, { at: [after.x, after.y], want: [kx, ky] });
  check("touchpad: a pinch turns nothing", angle(p0.d, p1.d) < 1e-6);
  await shot("04_touchpad_pinch.png");

  await reset();
  p0 = await pose();
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 3; i++) { await page.waitForTimeout(300); await page.mouse.wheel(0, -100); }
  await settle();
  p1 = await pose();
  console.log("    notch as seen:", JSON.stringify((await page.evaluate(() => window.__wheels.slice(-1)))));
  check("mouse: a wheel notch still zooms and turns nothing", p1.scale < p0.scale && angle(p0.d, p1.d) < 1e-6, { from: p0.scale, to: p1.scale, turned: angle(p0.d, p1.d) });

  await reset();
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(500);
  await page.locator(".prefs-nav-btn[data-category='navigation']").click();
  await page.waitForTimeout(300);
  await shot("05_settings.png");
  await page.locator("#prefs-touchpad-scroll button", { hasText: "Pans" }).click();
  await page.locator("#prefs-wheel-device button", { hasText: "Automatic" }).click();
  await page.locator(".modal-foot button", { hasText: "Done" }).click();
  await page.waitForTimeout(400);
  p0 = await pose();
  for (let i = 0; i < 20; i++) await pad(cx, cy, 0.5, 6.25);
  await settle();
  p1 = await pose();
  check("settings: scroll set to pan pans", angle(p0.d, p1.d) < 1e-6 && dist(p0.t, p1.t) > 1, { turned: angle(p0.d, p1.d), moved: dist(p0.t, p1.t) });
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(400);
  await page.locator(".prefs-nav-btn[data-category='navigation']").click();
  await page.locator("#prefs-touchpad-scroll button", { hasText: "Orbits" }).click();
  await page.locator("#prefs-wheel-device button", { hasText: "Mouse" }).click();
  await page.locator(".modal-foot button", { hasText: "Done" }).click();
  await page.waitForTimeout(400);
  await reset();
  p0 = await pose();
  for (let i = 0; i < 20; i++) await pad(cx, cy, 0.5, -6.25);
  await settle();
  p1 = await pose();
  check("settings: forcing mouse makes a touchpad scroll zoom", angle(p0.d, p1.d) < 1e-6 && p1.scale < p0.scale, { turned: angle(p0.d, p1.d), from: p0.scale, to: p1.scale });
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(400);
  await page.locator(".prefs-nav-btn[data-category='navigation']").click();
  await page.locator("#prefs-wheel-device button", { hasText: "Automatic" }).click();
  await page.locator(".modal-foot button", { hasText: "Done" }).click();
  await page.waitForTimeout(400);

  // --- touchscreen -----------------------------------------------------------------
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id: id ?? 0 })) });
  /** A drag; `during` runs before the fingers lift. */
  const drag = async (pts, dx, dy, steps = 12, during = null) => {
    await touch("touchStart", pts);
    await page.waitForTimeout(40);
    for (let i = 1; i <= steps; i++) {
      await touch("touchMove", pts.map(([x, y, id]) => [x + (dx * i) / steps, y + (dy * i) / steps, id]));
      await page.waitForTimeout(16);
    }
    if (during) await during();
    await touch("touchEnd", []);
  };
  const tap = async (x, y) => {
    await touch("touchStart", [[x, y]]);
    await page.waitForTimeout(60);
    await touch("touchEnd", []);
  };
  // A software renderer can hold the page for half a second between CDP's
  // touch start and end, which turns a tap into a long press. Where the timing
  // between taps is the point, the pointer events are sent from the page.
  // With `hold` the page waits out the gap without drawing, as the renderer
  // can take longer to draw one frame than a double tap allows.
  const quickTaps = (pts, gapMs, hold = false) => page.evaluate(async ([pts, gapMs, hold]) => {
    let id = 900;
    for (const [x, y] of pts) {
      const el = window.viewport.canvas;
      const init = { bubbles: true, cancelable: true, composed: true, pointerId: ++id, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, button: 0 };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1 }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
      if (hold) for (const end = performance.now() + gapMs; performance.now() < end;);
      else await new Promise((r) => setTimeout(r, gapMs));
    }
  }, [pts, gapMs, hold]);

  await reset();
  p0 = await pose();
  let box = null;
  await drag([[cx, cy]], 160, 40, 12, async () => { box = await page.evaluate(() => !!document.querySelector(".areabox")); });
  await settle();
  p1 = await pose();
  check("touch: one finger orbits", angle(p0.d, p1.d) > 0.3, { turned: angle(p0.d, p1.d) });
  check("touch: the drag draws no selection box", box === false, { box });
  await shot("06_touch_orbit.png");

  await reset();
  await page.evaluate(() => window.viewport.clearSelection?.());
  p0 = await pose();
  await tap(cx, cy);
  await page.waitForTimeout(600);
  p1 = await pose();
  const picked = await page.evaluate(() => ({ bodies: window.viewport.getSelectedBodies?.() ?? [], faces: window.viewport.highlighter?.getSelectedFaces() ?? [] }));
  check("touch: a tap selects what is under it", picked.bodies.length + picked.faces.length > 0, picked);
  check("touch: a tap turns nothing", angle(p0.d, p1.d) < 1e-9 && dist(p0.t, p1.t) < 1e-9);
  await shot("07_touch_tap.png");

  await reset();
  p0 = await pose();
  await touch("touchStart", [[cx - 60, cy, 1], [cx + 60, cy, 2]]);
  await page.waitForTimeout(60);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [[cx - 60 - i * 10, cy, 1], [cx + 60 + i * 10, cy, 2]]);
    await page.waitForTimeout(16);
  }
  await touch("touchEnd", []);
  await settle();
  p1 = await pose();
  check("touch: two fingers pinch to zoom", p1.scale < p0.scale * 0.8, { from: p0.scale, to: p1.scale });
  check("touch: the pinch turns nothing", angle(p0.d, p1.d) < 1e-6);
  await shot("08_touch_pinch.png");

  await reset();
  p0 = await pose();
  await drag([[cx - 50, cy, 1], [cx, cy, 2], [cx + 50, cy, 3]], 120, 0);
  await settle();
  p1 = await pose();
  check("touch: three fingers orbit", angle(p0.d, p1.d) > 0.2, { turned: angle(p0.d, p1.d) });

  await reset();
  await touch("touchStart", [[cx, cy]]);
  await page.waitForTimeout(800);
  const menu = await page.evaluate(() => document.querySelectorAll(".context-menu .ctx-item").length);
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
  const stillOpen = await page.evaluate(() => document.querySelectorAll(".context-menu .ctx-item").length);
  check("touch: a long press opens the viewport menu", menu > 0, { items: menu });
  check("touch: lifting the finger leaves the menu open", stillOpen > 0, { items: stillOpen });
  await shot("09_touch_long_press.png");
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 450);
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    window.__dbl = 0;
    window.viewport.canvas.addEventListener("dblclick", () => window.__dbl++);
  });
  await page.waitForTimeout(500);
  await quickTaps([[cx + 200, cy + 150], [cx + 201, cy + 151]], 120, true);
  await page.waitForTimeout(400);
  const dbl = await page.evaluate(() => window.__dbl);
  check("touch: a double tap is one dblclick on the viewport", dbl === 1, { dblclicks: dbl });
  await page.keyboard.press("Escape");

  const row = await page.evaluate(() => {
    const el = [...document.querySelectorAll(".feature-row")].find((r) => r.textContent.includes("Body"));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  if (row) {
    await touch("touchStart", [[row.x - 40, row.y, 1], [row.x + 40, row.y, 2]]);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [[row.x - 40 - i * 10, row.y, 1], [row.x + 40 + i * 10, row.y, 2]]);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd", []);
    await page.waitForTimeout(300);
    const zoom = await page.evaluate(() => window.visualViewport?.scale ?? 1);
    check("touch: a pinch over the panels does not zoom the page", Math.abs(zoom - 1) < 1e-6, { scale: zoom });
    await touch("touchStart", [[row.x, row.y]]);
    await page.waitForTimeout(800);
    const rowMenu = await page.evaluate(() => document.querySelectorAll(".context-menu .ctx-item").length);
    await touch("touchEnd", []);
    await page.waitForTimeout(300);
    const rowOpen = await page.evaluate(() => document.querySelectorAll(".context-menu .ctx-item").length);
    check("touch: a long press on a tree row opens its menu", rowMenu > 0, { items: rowMenu });
    check("touch: and the release does not close it", rowOpen > 0, { items: rowOpen });
    await shot("10_tree_long_press.png");
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 450);
  } else check("touch: a tree row is on screen", false);

  // --- a sketch: one finger draws, the camera stays ------------------------------
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s9", type: "sketch", plane: "XY", entities: [] });
    await window.store.rebuildNow();
  });
  await idle();
  await page.evaluate(() => window.__fundacad.editFeature("s9"));
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.sketch.setTool("line"));
  const scr = (x, y) => page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const a = await scr(-10, -5), b = await scr(5, -12);
  console.log("    sketch taps at", JSON.stringify([a, b]));
  const n0 = await page.evaluate(() => window.sketch.entities.length);
  p0 = await pose();
  await quickTaps([[Math.round(a.x), Math.round(a.y)], [Math.round(b.x), Math.round(b.y)]], 600);
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const n1 = await page.evaluate(() => window.sketch.entities.length);
  p1 = await pose();
  check("sketch: two taps draw a line", n1 === n0 + 1, { before: n0, after: n1 });
  check("sketch: tapping moves no camera", angle(p0.d, p1.d) < 1e-9 && dist(p0.t, p1.t) < 1e-6);
  await shot("11_sketch_taps.png");
  p0 = await pose();
  await drag([[cx - 40, cy, 1], [cx + 40, cy, 2]], 80, 30);
  await settle();
  p1 = await pose();
  const n2 = await page.evaluate(() => window.sketch.entities.length);
  check("sketch: two fingers pan the view and draw nothing", dist(p0.t, p1.t) > 1 && n2 === n1, { moved: dist(p0.t, p1.t), entities: n2 });

  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
