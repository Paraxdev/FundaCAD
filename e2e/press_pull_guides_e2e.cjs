// Press/pull resize guides and value box placement, in a real browser.
//
// Scene: the c1 reproduction with its three slot end press/pulls suppressed, as
// press_pull_resize_e2e.cjs. The upper slot's +Y end is a half cylinder of r 2
// on the axis y 7.125, z 20 along X.
//
//   1. On the slot end a thin axis line runs along the engine's axis, 15 percent
//      longer than the face, and a dashed line runs from the axis to the handle
//      (a radius, 2 long). The value box stands past the arrow tip.
//   2. Dragging the end out lengthens the dashed line with the handle.
//   3. A round hole draws its dashed line across the whole diameter, through the axis.
//   4. Esc takes both lines down.
//
// Shots: 01_slot, 01_slot_zoom, 01_slot_end_zoom, 02_grown_zoom, 03_hole, 03_hole_zoom.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5974/ SC_ENGINE_PORT=8974 \
//     node e2e/press_pull_guides_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "press_pull_guides_shots");
const C1 = path.join(__dirname, "../crates/fundacad-geom/tests/press_pull/c1_slot_end.json");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const SLOT_END = [0, 9.125, 20];
const HOLE_WALL = [0, 7.125 + 3.3690784184224394, 13.015];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c1 = JSON.parse(fs.readFileSync(C1, "utf8"));
  const base = { ...c1, suppressed: ["f6", "f7", "f8"] };

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
    await page.waitForTimeout(500);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 180000 });
    await page.waitForTimeout(400);
  };
  await page.evaluate(async (json) => {
    window.store.load(json);
    await window.store.rebuildNow();
  }, JSON.stringify(base));
  await settle();
  await page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(60, -40, 40), new V(0, 6, 20));
    v.requestRender();
  });
  await page.waitForTimeout(500);

  // Everything about the guides and the box, in world and screen terms.
  const guides = () => page.evaluate(() => {
    const t = window.pressPull; const v = window.viewport;
    const g = t.guides;
    const ends = (line) => {
      if (!line) return null;
      const a = line.geometry.getAttribute("position").array;
      return { a: [a[0], a[1], a[2]], b: [a[3], a[4], a[5]], material: line.material.type, inScene: !!line.parent, name: line.name };
    };
    const at = t.anchor.clone().addScaledVector(t.axis, t.value);
    const k = v.pixelWorldSize(at);
    const dir = t.axis.clone().multiplyScalar(t.value < 0 ? -1 : 1);
    const s = v.projectToScreen(at);
    const tip = v.projectToScreen(at.clone().addScaledVector(dir, k * 45));
    const box = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none");
    const r = box?.getBoundingClientRect();
    const canvas = v.domElement.getBoundingClientRect();
    return {
      axis: ends(g.axisLine),
      size: ends(g.sizeLine),
      dash: g.sizeLine ? g.sizeLine.material.dashSize / k : null,
      handle: [at.x, at.y, at.z],
      engineAxis: t.guideAxis,
      span: t.guideSpan,
      base: s,
      tip,
      box: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null,
      canvas: { left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom },
      sceneHas: !!v.scene.scene.getObjectByName("resize-axis") || !!v.scene.scene.getObjectByName("resize-size"),
      value: t.value,
      label: box?.querySelector(".dim-name")?.title || box?.querySelector(".dim-name")?.textContent || null,
      field: box?.querySelector("input")?.value ?? null,
    };
  });
  const len = (e) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]);
  /** The box is clear of the arrow and stands beyond the tip along it. */
  const boxPastTip = (g) => {
    if (!g.box) return { ok: false };
    const dx = g.tip.x - g.base.x, dy = g.tip.y - g.base.y;
    const n = Math.hypot(dx, dy) || 1;
    let onArrow = false;
    for (let i = 0; i <= 20; i++) {
      const x = g.base.x + (dx * i) / 20, y = g.base.y + (dy * i) / 20;
      if (x >= g.box.left && x <= g.box.right && y >= g.box.top && y <= g.box.bottom) onArrow = true;
    }
    const cx = (g.box.left + g.box.right) / 2, cy = (g.box.top + g.box.bottom) / 2;
    const ahead = ((cx - g.tip.x) * dx + (cy - g.tip.y) * dy) / n;
    const inside = g.box.left >= g.canvas.left && g.box.top >= g.canvas.top && g.box.right <= g.canvas.right && g.box.bottom <= g.canvas.bottom;
    return { ok: !onArrow && ahead > 0 && inside, onArrow, ahead, inside };
  };
  const zoom = async (name, g) => {
    const cx = (g.base.x + g.tip.x) / 2, cy = (g.base.y + g.tip.y) / 2;
    await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: Math.max(0, cx - 300), y: Math.max(0, cy - 200), width: 600, height: 400 } });
  };
  const select = async (point) => {
    await page.evaluate((p) => {
      const v = window.viewport;
      v.clearSelection?.();
      v.selectFaces([v.faceIdNear(p)]);
    }, point);
    await page.evaluate(() => window.__fundacad.handleAction("presspull"));
    await page.waitForFunction(() => window.pressPull.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(400);
  };

  // --- 1. slot end: axis line, radius line, box past the tip -------------------
  await select(SLOT_END);
  let g = await guides();
  check("the slot end reads R", g.label === "R", g.label);
  check("the axis line is drawn, solid", g.axis && g.axis.inScene && g.axis.material === "LineBasicMaterial", g.axis);
  check("on the engine's exact axis, y 7.125 z 20 along X", g.axis
    && [g.axis.a, g.axis.b].every((p) => near(p[1], 7.125, 1e-4) && near(p[2], 20, 1e-4)), g.axis);
  const faceLen = g.span ? g.span[1] - g.span[0] : 0;
  check("15 percent longer than the face", g.axis && faceLen > 1 && near(len(g.axis), faceLen * 1.15, 1e-3), { line: g.axis && len(g.axis), faceLen });
  check("the size line is dashed", g.size && g.size.inScene && g.size.material === "LineDashedMaterial", g.size);
  check("from the axis to the handle, a radius of 2", g.size && near(g.size.a[1], 7.125, 1e-3) && near(g.size.a[2], 20, 1e-3)
    && near(len(g.size), 2, 0.02) && g.size.b.every((c, i) => near(c, g.handle[i], 1e-4)), { size: g.size, handle: g.handle });
  check("its dashes are 5 px on screen", g.dash !== null && near(g.dash, 5, 1e-3), g.dash);
  const past = boxPastTip(g);
  check("the value box stands past the arrow tip, clear of the arrow, on the canvas", past.ok, { past, box: g.box, tip: g.tip, base: g.base });
  await shot("01_slot");
  await zoom("01_slot_zoom", g);
  // Down the slot from above its +X mouth, so the end, its axis and the handle read together.
  await page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(12, -14, 46), new V(-8, 7, 20));
    v.requestRender();
  });
  await page.waitForTimeout(500);
  await zoom("01_slot_end_zoom", await guides());
  await page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(60, -40, 40), new V(0, 6, 20));
    v.requestRender();
  });
  await page.waitForTimeout(500);

  // --- 2. dragging lengthens the size line --------------------------------------
  const grip = await page.evaluate(() => {
    const t = window.pressPull; const v = window.viewport;
    const at = t.anchor.clone().addScaledVector(t.axis, t.value);
    const k = v.pixelWorldSize(at);
    const s = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 25));
    const ahead = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 60));
    const s0 = v.projectToScreen(at);
    return { x: s.x, y: s.y, dx: ahead.x - s0.x, dy: ahead.y - s0.y };
  });
  const gl = Math.hypot(grip.dx, grip.dy) || 1;
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  let x = grip.x, y = grip.y;
  for (let i = 0; i < 200; i++) {
    x += (grip.dx / gl) * 2; y += (grip.dy / gl) * 2;
    await page.mouse.move(x, y);
    if ((await page.evaluate(() => window.pressPull.value)) >= 0.6) break;
  }
  await page.waitForTimeout(300);
  g = await guides();
  check("dragged out, the dashed line follows the handle", g.size && near(len(g.size), 2 + g.value, 0.02) && g.value >= 0.6, { len: g.size && len(g.size), value: g.value });
  check("the box still stands past the tip", boxPastTip(g).ok, boxPastTip(g));
  await page.mouse.up();
  await settle();
  await zoom("02_grown_zoom", await guides());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  g = await guides();
  check("Esc takes both lines down", !g.axis && !g.size && !g.sceneHas, g);

  // --- 3. a hole: the dashed line spans the diameter ---------------------------
  await select(HOLE_WALL);
  g = await guides();
  check("a round hole reads as a diameter", g.label === "Diameter", g.label);
  const mid = g.size && g.size.a.map((c, i) => (c + g.size.b[i]) / 2);
  const ax = g.engineAxis;
  const offAxis = mid && ax && (() => {
    const d = mid.map((c, i) => c - ax.origin[i]);
    const t = d[0] * ax.dir[0] + d[1] * ax.dir[1] + d[2] * ax.dir[2];
    return Math.hypot(...d.map((c, i) => c - ax.dir[i] * t));
  })();
  check("the dashed line runs wall to wall through the axis", g.size && near(len(g.size), Number(g.field), 0.02) && offAxis !== null && offAxis < 1e-3,
    { len: g.size && len(g.size), field: g.field, offAxis });
  check("the axis line is drawn on the hole", g.axis && g.axis.inScene, g.axis);
  check("the box stands past the tip", boxPastTip(g).ok, boxPastTip(g));
  await shot("03_hole");
  await zoom("03_hole_zoom", g);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  g = await guides();
  check("Esc takes them down again", !g.axis && !g.size && !g.sceneHas);

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
