// The move gizmo on sketches, in a real browser, with real pointer drags.
//
//   1. A whole sketch, picked from the model, slides up along Z: its plane is
//      rewritten and the extrude cut from it follows.
//   2. The same sketch turned a quarter turn about X stands up, and the extrude
//      still finds its profile.
//   3. Inside the sketch, M on a selected rectangle opens the in-plane gizmo
//      (2 arrows, 1 ring), a drag moves the rectangle, one sketch undo reverts it.
//   4. The Copy toggle leaves the original and adds a copy.
//   5. Escape closes the gizmo and leaves the sketch open.
//   6. A body slide steps by a tenth of the grid cell.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/sketch_move_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "sketch_move_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript((t) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, TOKEN);

  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  const built = () => page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  const settle = async () => {
    await page.waitForTimeout(300);
    await built();
    await page.waitForTimeout(300);
  };

  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({
      id: "s1", type: "sketch", plane: "XY",
      entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 20, height: 10 }],
    });
    s.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 5, operation: "new", regions: [[0, 0, 0]] });
    await s.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length >= 1, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(800);

  const bodyBox = () => page.evaluate(() => {
    const id = window.store.buildState.result.bodies[0].id;
    const b = window.viewport.bodiesBox([id]);
    return b && { min: b.min.toArray(), max: b.max.toArray() };
  });

  /** Screen point of a handle: an arrow `px` gizmo pixels out along frame axis
   *  `i`, or a ring point at angle `a` (radians) about axis `i`. */
  const handle = (spec) => page.evaluate((spec) => {
    const m = window.__fundacad.move;
    const vp = window.viewport;
    const pos = m.gizmo.position.clone();
    const k = vp.pixelWorldSize(pos);
    const f = m.frame;
    let p;
    if (spec.kind === "arrow") p = pos.clone().addScaledVector(f[spec.i], spec.px * k);
    else {
      const u = f[(spec.i + 1) % 3], v = f[(spec.i + 2) % 3];
      p = pos.clone().addScaledVector(u, Math.cos(spec.a) * 46 * k).addScaledVector(v, Math.sin(spec.a) * 46 * k);
    }
    const s = vp.projectToScreen(p);
    return { x: s.x, y: s.y };
  }, spec);

  const drag = async (from, to, steps = 12) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let n = 1; n <= steps; n++) {
      await page.mouse.move(from.x + ((to.x - from.x) * n) / steps, from.y + ((to.y - from.y) * n) / steps);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  };

  // --- 1. whole sketch slides along Z ---------------------------------------
  console.log("\n  1. whole sketch, Z arrow");
  const before = await bodyBox();
  await page.evaluate(() => { window.__fundacad.selectFeature("s1"); window.__fundacad.handleAction("move"); });
  await page.waitForTimeout(300);
  const t1 = await page.evaluate(() => {
    const m = window.__fundacad.move;
    return { active: m.active, arrows: m.arrows.length, cubes: m.cubes.length };
  });
  check("gizmo opens on a picked sketch", t1.active, JSON.stringify(t1));
  check("a sketch gizmo has no resize cubes", t1.cubes === 0);
  await page.screenshot({ path: path.join(OUT, "1_open.png") });
  {
    const a = await handle({ kind: "arrow", i: 2, px: 40 });
    const b = await handle({ kind: "arrow", i: 2, px: 140 });
    await drag(a, b);
  }
  await settle();
  const s1 = await page.evaluate(() => window.store.document.features.find((f) => f.id === "s1").plane);
  const after = await bodyBox();
  const dz = typeof s1 === "object" ? s1.origin[2] : 0;
  check("sketch plane rewritten upward", typeof s1 === "object" && dz > 0, JSON.stringify(s1));
  check("extrude followed the sketch", after && near(after.min[2] - before.min[2], dz, 0.01), JSON.stringify({ before, after }));
  await page.screenshot({ path: path.join(OUT, "1_moved.png") });

  // --- 2. quarter turn about X ----------------------------------------------
  console.log("\n  2. whole sketch, X ring");
  const reopened = await page.evaluate(() => window.__fundacad.move.active);
  check("gizmo reopened after the rebuild", reopened);
  // Looking down X, so the X ring faces the camera and the other two are lines
  // through its centre. The grab starts in the -Y,+Z quadrant, clear of both
  // those lines and of the planar square, which sits in the +Y,+Z one.
  await page.evaluate(() => window.__fundacad.handleAction("right"));
  await page.waitForTimeout(1200);
  let grabbed = null;
  {
    const pts = [];
    for (let n = 0; n <= 18; n++) pts.push(await handle({ kind: "ring", i: 0, a: (3 * Math.PI) / 4 + (n / 18) * (Math.PI / 2) }));
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down();
    grabbed = await page.evaluate(() => window.__fundacad.move.grab);
    for (const p of pts.slice(1)) { await page.mouse.move(p.x, p.y); await page.waitForTimeout(16); }
    await page.mouse.up();
  }
  check("the press took the X ring", grabbed?.kind === "ring" && grabbed.index === 0, JSON.stringify(grabbed));
  await settle();
  const s2 = await page.evaluate(() => window.store.document.features.find((f) => f.id === "s1").plane);
  const turnedBox = await bodyBox();
  check("sketch normal turned a quarter about X", typeof s2 === "object" && Math.abs(Math.abs(s2.normal[1]) - 1) < 1e-6 && near(s2.xdir[0], 1), JSON.stringify(s2));
  const errs = await page.evaluate(() => (window.store.buildState.result?.featureErrors ?? []).map((e) => e.message));
  check("rebuild still finds the profile", errs.length === 0 && !!turnedBox, JSON.stringify({ errs, turnedBox }));
  const zSpan = turnedBox ? turnedBox.max[2] - turnedBox.min[2] : 0;
  check("the extrude stood up with it", zSpan > 9, `z span ${zSpan}`);
  await page.screenshot({ path: path.join(OUT, "2_turned.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // --- 3. inside the sketch ---------------------------------------------------
  console.log("\n  3. in-sketch gizmo");
  await page.evaluate(() => { window.store.undo(); window.store.undo(); });
  await settle();
  const undone = await page.evaluate(() => window.store.document.features.find((f) => f.id === "s1").plane);
  check("two document undos take both sketch moves back", undone === "XY" && near((await bodyBox()).min[2], 0, 1e-3), JSON.stringify(undone));
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const sk = window.sketch;
    sk.selected.add("r1");
    sk.refreshActive();
    window.__fundacad.handleAction("move-sketch");
  });
  await page.waitForTimeout(300);
  const t3 = await page.evaluate(() => {
    const m = window.__fundacad.move;
    return { active: m.active, arrows: m.arrows.length, rings: m.rings.length, planes: m.planes.length, sketch: window.sketch.active };
  });
  check("in-plane gizmo: 2 arrows, 1 ring, 1 square", t3.active && t3.arrows === 2 && t3.rings === 1 && t3.planes === 1, JSON.stringify(t3));
  const ent = () => page.evaluate(() => window.sketch.entities.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y })));
  const e0 = await ent();
  {
    const a = await handle({ kind: "arrow", i: 0, px: 40 });
    const b = await handle({ kind: "arrow", i: 0, px: 160 });
    await drag(a, b);
  }
  await page.waitForTimeout(400);
  const e1 = await ent();
  check("rectangle slid along the sketch X", e1.length === 1 && e1[0].type === "rectangle" && e1[0].x > e0[0].x && near(e1[0].y, e0[0].y), JSON.stringify(e1));
  await page.screenshot({ path: path.join(OUT, "3_in_sketch.png") });
  const reopenedIn = await page.evaluate(() => window.__fundacad.move.active);
  check("gizmo stays up for the next drag", reopenedIn);
  await page.evaluate(() => { window.__fundacad.move.cancel(); window.sketch.undoEdit(); });
  await page.waitForTimeout(300);
  const e2 = await ent();
  check("one sketch undo reverts the drag", near(e2[0].x, e0[0].x), JSON.stringify(e2));

  // --- 4. copy ----------------------------------------------------------------
  console.log("\n  4. copy");
  await page.evaluate(() => {
    const sk = window.sketch;
    sk.selected.clear();
    sk.selected.add("r1");
    sk.refreshActive();
    window.__fundacad.handleAction("move-sketch");
  });
  await page.waitForTimeout(300);
  const toggle = await page.$(".dim-input .dim-toggle");
  check("the Copy toggle is shown", !!toggle);
  if (toggle) {
    const bb = await toggle.boundingBox();
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  }
  {
    const a = await handle({ kind: "arrow", i: 1, px: 40 });
    const b = await handle({ kind: "arrow", i: 1, px: 160 });
    await drag(a, b);
  }
  await page.waitForTimeout(400);
  const e3 = await ent();
  check("copy added beside the original", e3.length === 2 && e3.some((e) => e.id === "r1" && near(e.y, e0[0].y)), JSON.stringify(e3));
  check("the copy has its own id", new Set(e3.map((e) => e.id)).size === e3.length);
  await page.screenshot({ path: path.join(OUT, "4_copy.png") });

  // --- 5. escape --------------------------------------------------------------
  console.log("\n  5. escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const t5 = await page.evaluate(() => ({ gizmo: window.__fundacad.move.active, sketch: window.sketch.active }));
  check("Escape closes the gizmo and keeps the sketch", !t5.gizmo && t5.sketch, JSON.stringify(t5));
  await page.evaluate(() => window.sketch.cancel());
  await page.waitForTimeout(300);

  // --- 6. body slide follows the grid -----------------------------------------
  console.log("\n  6. body slide step");
  await page.evaluate(() => {
    const id = window.store.buildState.result.bodies[0].id;
    window.__fundacad.move.start([id], () => {});
  });
  await page.waitForTimeout(300);
  const stepInfo = await page.evaluate(() => {
    const m = window.__fundacad.move;
    return { step: m.moveStep(false), grid: window.viewport.scene.grid.step };
  });
  {
    const a = await handle({ kind: "arrow", i: 0, px: 40 });
    const b = await handle({ kind: "arrow", i: 0, px: 133 });
    await drag(a, b);
  }
  await settle();
  const mv = await page.evaluate(() => [...window.store.document.features].reverse().find((f) => f.type === "move"));
  const ratio = mv ? mv.dx / stepInfo.step : NaN;
  check("slide is a whole number of steps", mv && near(ratio, Math.round(ratio), 1e-6), JSON.stringify({ dx: mv?.dx, ...stepInfo }));
  check("step is a tenth of a grid cell", near(stepInfo.step * 10, stepInfo.grid, 1e-9) || stepInfo.step >= 0.001, JSON.stringify(stepInfo));

  console.log(`\n  ${failures ? `${failures} FAILED` : "all passed"}\n`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
