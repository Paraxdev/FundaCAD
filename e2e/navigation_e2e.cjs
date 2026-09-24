// Camera navigation in the running app: the gestures users reported as
// distorting, overshooting or flying the camera into a void.
//
// 40 wheel notches at a model edge keep the point under the cursor within a
// pixel; an orbit keeps its pivot on its pixel; zooming out keeps the target by
// the model; Top then an orbit off it is smooth and level; projection cycling,
// sketch entry and exit, fit and reset all leave a finite pose with the target
// near the model. Screenshots after every step.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/]
//   [SC_WS=ws://127.0.0.1:8765] [SC_NAV=v2|legacy] node e2e/navigation_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const WS = process.env.SC_WS || "";
const NAV = process.env.SC_NAV || "v2";
const OUT = path.resolve(process.argv[2] || "navigation_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  if (WS) {
    // The frontend always dials the default engine port; a second engine on
    // another port needs the URL rewritten before the app loads.
    await page.addInitScript((ws) => {
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url, protocols) {
          super(String(url).replace("ws://127.0.0.1:8765", ws), protocols);
        }
      };
    }, WS);
  }
  await page.goto(`${URL}?token=${TOKEN}&nav=${NAV}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }

  const idle = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(400);
  };
  await page.evaluate(async () => {
    window.store.loadDocument({ parameters: {}, features: [
      { id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: 40, height: 30, x: 0, y: 0 }] },
      { id: "e1", type: "extrude", sketch: "s1", distance: 20, operation: "new" },
      { id: "s2", type: "sketch", plane: "XY", entities: [{ type: "circle", x: 45, y: 0, radius: 6 }] },
      { id: "e2", type: "extrude", sketch: "s2", distance: 35, operation: "new" },
    ] });
    await window.store.rebuildNow();
  });
  await idle();
  await page.evaluate(() => window.viewport.resetCamera());
  await page.waitForTimeout(1200);

  const canvas = await page.evaluate(() => {
    const r = window.viewport.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const model = await page.evaluate(() => {
    const b = window.viewport.model.box;
    const c = b.getCenter(new b.min.constructor());
    return { c: c.toArray(), r: b.min.distanceTo(b.max) / 2 };
  });

  const pose = () => page.evaluate(([c]) => {
    const rig = window.viewport.rig;
    const V = rig.getTarget().constructor;
    const t = rig.getTarget();
    const e = rig.getPosition();
    const d = rig.viewDirection();
    const cam = rig.active;
    cam.updateMatrixWorld();
    const right = new V().setFromMatrixColumn(cam.matrixWorld, 0);
    const centre = new V(...c);
    // how far the model's centre is from the view axis: containment moves the
    // target only along the axis, so it cannot be nearer than this
    const off = centre.clone().sub(e).cross(d).length();
    return {
      t: t.toArray(), e: e.toArray(), d: d.toArray(), rightZ: right.z, scale: rig.viewScale(),
      ortho: rig.isOrtho(), mode: rig.projectionMode(), toCentre: t.distanceTo(centre), off,
    };
  }, [model.c]);
  const sane = async (label) => {
    const p = await pose();
    const nums = [...p.t, ...p.e, ...p.d, p.scale, p.rightZ];
    check(`${label}: the pose is finite`, nums.every(Number.isFinite), p);
    const bound = Math.max(3 * model.r, p.off * 1.001 + 1e-6);
    check(`${label}: the target is by the model`, p.toCentre <= bound, { toCentre: p.toCentre, bound });
    return p;
  };
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });
  const screenOf = (p) => page.evaluate((q) => {
    const V = window.viewport.rig.getTarget().constructor;
    return window.viewport.projectToScreen(new V(...q));
  }, p);
  // Mouse and wheel events carry whole pixels, so the cursor goes on one.
  const pixelOf = async (p) => {
    const s = await screenOf(p);
    return { x: Math.round(s.x), y: Math.round(s.y) };
  };
  const settle = () => page.waitForTimeout(900);

  await shot("01_start.png");
  await sane("start");

  // --- 1. forty notches at an edge ---------------------------------------------
  // Just inside the top face's front edge of the box.
  const edge = await pixelOf([0, -14.5, 20]);
  const anchor = await page.evaluate(([x, y]) => window.viewport.orbitPivotAt(x, y)?.toArray(), [edge.x, edge.y]);
  check("the cursor is on the model", !!anchor && Math.abs(anchor[2] - 20) < 1e-3, anchor);
  await page.mouse.move(edge.x, edge.y);
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(30);
    if (i % 8 === 7) {
      const s = await screenOf(anchor);
      worst = Math.max(worst, Math.hypot(s.x - edge.x, s.y - edge.y));
    }
  }
  await settle();
  const s1 = await screenOf(anchor);
  worst = Math.max(worst, Math.hypot(s1.x - edge.x, s1.y - edge.y));
  check("40 notches at the edge keep the point under the cursor within 1 px", worst < 1, { worst });
  await shot("02_zoomed_at_edge.png");
  const p1 = await sane("after 40 notches");
  check("and the camera is still outside the box", !(Math.abs(p1.e[0]) < 20 && Math.abs(p1.e[1]) < 15 && p1.e[2] > 0 && p1.e[2] < 20), p1.e);

  // --- 2. back out and orbit about the model --------------------------------------
  for (let i = 0; i < 36; i++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(20); }
  await settle();
  await shot("03_back_out.png");
  await sane("back out");
  const onBox = await pixelOf([-10, -15, 10]);
  const pivot = await page.evaluate(([x, y]) => window.viewport.orbitPivotAt(x, y)?.toArray(), [onBox.x, onBox.y]);
  await page.mouse.move(onBox.x, onBox.y);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(onBox.x + i * 6, onBox.y + i * 2);
    await page.waitForTimeout(16);
  }
  await page.mouse.up({ button: "right" });
  await settle();
  const s2 = await screenOf(pivot);
  const pinned = Math.hypot(s2.x - onBox.x, s2.y - onBox.y);
  check("the orbit pivot stays on its pixel", pinned < 1, { pinned, pivot });
  const p2 = await sane("after orbit");
  check("the horizon is level after a mouse orbit", Math.abs(p2.rightZ) < 1e-9, p2.rightZ);
  await shot("04_orbited.png");

  // --- 3. zoom out a long way, off the model -----------------------------------
  // bottom right: the top right corner is under the History card
  await page.mouse.move(canvas.left + canvas.width - 200, canvas.top + canvas.height - 80);
  for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, 150); await page.waitForTimeout(20); }
  await settle();
  await shot("05_zoomed_out.png");
  await sane("zoomed out");
  const seen = await screenOf(model.c);
  check("the model is still on screen", seen.x > canvas.left && seen.x < canvas.left + canvas.width && seen.y > canvas.top && seen.y < canvas.top + canvas.height, seen);
  await page.evaluate(() => window.viewport.fitView());
  await settle();
  await shot("06_fit.png");
  await sane("fit");

  // --- 4. Top, then orbit off it ----------------------------------------------------
  await page.evaluate(() => window.viewport.setStandardView("top"));
  await settle();
  const top = await pose();
  check("Top looks straight down", Math.abs(top.d[2] + 1) < 1e-9 && Math.hypot(top.d[0], top.d[1]) < 1e-6, top.d);
  await shot("07_top.png");
  const mid = { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 };
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down({ button: "right" });
  let prevD = top.d;
  let maxStep = 0;
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(mid.x, mid.y - i * 3);
    await page.waitForTimeout(16);
    const p = await pose();
    const dot = p.d[0] * prevD[0] + p.d[1] * prevD[1] + p.d[2] * prevD[2];
    maxStep = Math.max(maxStep, Math.acos(Math.min(1, dot)));
    prevD = p.d;
  }
  await page.mouse.up({ button: "right" });
  await settle();
  const off = await sane("off the pole");
  check("orbiting off Top turns smoothly (no flip)", maxStep < 0.2, { maxStep });
  check("and stays level", Math.abs(off.rightZ) < 1e-9, off.rightZ);
  check("and has left the pole", off.d[2] > -0.999, off.d);
  await shot("08_off_top.png");

  // --- 5. projection cycling --------------------------------------------------------------
  const corners = [[-20, -15, 0], [20, 15, 20], [45, 0, 35], [-20, 15, 20]];
  const printOf = async () => Promise.all(corners.map((c) => screenOf(c)));
  const before = await printOf();
  const modes = [];
  for (let i = 0; i < 3; i++) {
    modes.push(await page.evaluate(() => window.viewport.cycleProjection()));
    await settle();
    await sane(`projection ${modes[i]}`);
    await shot(`09_projection_${i}_${modes[i]}.png`);
  }
  const after = await printOf();
  const moved = Math.max(...after.map((a, i) => Math.hypot(a.x - before[i].x, a.y - before[i].y)));
  check("cycling projections back to perspective shows the same picture", moved < 1e-3, { moved, modes });

  // --- 6. sketch enter and exit ------------------------------------------------------------
  await page.evaluate(() => window.viewport.setStandardView("iso"));
  await settle();
  await page.evaluate(() => window.viewport.fitView());
  await settle();
  const face = await pixelOf([5, 5, 20]);
  await page.mouse.click(face.x, face.y);
  await page.waitForTimeout(400);
  await page.mouse.click(face.x, face.y);
  await page.waitForTimeout(400);
  const scaleBefore = (await pose()).scale;
  await page.evaluate(() => window.__fundacad.handleAction("sketch"));
  await page.waitForTimeout(2000);
  check("a sketch opened", await page.evaluate(() => !!window.sketch.active));
  const sk = await sane("in sketch");
  check("the sketch view looks straight down on the top face", Math.abs(sk.d[2] + 1) < 1e-6, sk.d);
  check("entering the sketch keeps the scale", Math.abs(sk.scale - scaleBefore) / scaleBefore < 0.05, { before: scaleBefore, after: sk.scale });
  await shot("10_sketch.png");
  await page.evaluate(() => window.sketch.cancel());
  await settle();
  const ex = await sane("after sketch exit");
  check("leaving the sketch is level again", Math.abs(ex.rightZ) < 1e-9, ex.rightZ);
  await shot("11_sketch_exit.png");

  // --- 7. fit and reset --------------------------------------------------------------------
  await page.evaluate(() => window.viewport.fitView());
  await settle();
  await sane("fit again");
  await page.evaluate(() => window.viewport.resetCamera());
  await settle();
  const home = await sane("reset");
  const want = [-80, 120, -90].map((v) => v / Math.hypot(80, 120, 90));
  check("reset looks in from the home corner", home.d.every((v, i) => Math.abs(v - want[i]) < 1e-3), { d: home.d, want });
  await shot("12_reset.png");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
