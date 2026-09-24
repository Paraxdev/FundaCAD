// A control point spline, in a real browser.
//
//   1. The tool places poles and closes the curve on its first pole; the control
//      polygon shows while the curve is selected.
//   2. Dragging an interior pole reshapes the curve.
//   3. Double-clicking a polygon leg inserts a pole and the curve does not move.
//   4. Delete removes the picked pole.
//   5. The closed profile extrudes into one body.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/bspline_e2e.cjs [outDir]
// SC_URL and SC_ENGINE_PORT point it at another vite and engine.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "bspline_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(([t, port]) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        let s = String(u).replace(":8765", `:${port}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        if (!s.includes("token=") && s.includes(`:${port}`)) s += (s.includes("?") ? "&" : "?") + "token=" + t;
        super(s, p);
      }
    }
    window.WebSocket = P;
  }, [TOKEN, PORT]);
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [] });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(2500);
  const scr = (x, y) => page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const bs = () => page.evaluate(() => JSON.parse(JSON.stringify(window.sketch.entities.find((e) => e.type === "bspline") ?? null)));
  // points on the curve, sampled by the page's own evaluation
  const curve = () => page.evaluate(async () => {
    const m = await import("/src/sketch/bspline.ts");
    const e = window.sketch.entities.find((x) => x.type === "bspline");
    return e ? m.bsplinePolyline(e, 24) : [];
  });
  const gap = (a, b) => {
    // worst distance from a's samples to b's polyline
    let worst = 0;
    for (const p of a) {
      let best = Infinity;
      for (let i = 0; i + 1 < b.length; i++) {
        const A = b[i], B = b[i + 1];
        const dx = B.x - A.x, dy = B.y - A.y;
        const t = Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(A.x + t * dx - p.x, A.y + t * dy - p.y));
      }
      worst = Math.max(worst, best);
    }
    return worst;
  };

  // 1. draw: six poles, then click the first again to close
  const poles = [[-30, -10], [-10, -25], [20, -22], [32, 5], [10, 28], [-25, 18]];
  await page.evaluate(() => window.sketch.setTool("bspline"));
  await page.waitForTimeout(300);
  for (const [x, y] of poles) {
    const s = await scr(x, y);
    await page.mouse.move(s.x, s.y);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(150);
  }
  const first = await scr(poles[0][0], poles[0][1]);
  await page.mouse.move(first.x + 1, first.y);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "bs-1-closing-preview.png") });
  await page.mouse.click(first.x, first.y);
  await page.waitForTimeout(800);
  let e = await bs();
  check("the tool makes a closed control point spline", !!e && e.closed === true && e.poles.length === 6, JSON.stringify(e));
  check("the new curve is selected, so its polygon shows", await page.evaluate(() => window.sketch.selected.size === 1));
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.waitForTimeout(300);
  await page.evaluate(() => { const e = window.sketch.entities.find((x) => x.type === "bspline"); window.sketch.selected = new Set([e.id]); window.sketch.refreshActive(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "bs-2-selected-polygon.png") });

  // 2. drag pole 3 outward
  const before = await curve();
  const pre = e;
  const p3 = e.poles[3];
  const a = await scr(p3.x, p3.y), b = await scr(p3.x + 15, p3.y + 10);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10); await page.waitForTimeout(40); }
  await page.mouse.up();
  await page.waitForTimeout(800);
  e = await bs();
  const moved = Math.hypot(e.poles[3].x - (p3.x + 15), e.poles[3].y - (p3.y + 10));
  check("dragging a pole moves it with the cursor", moved < 1.5, `off by ${moved.toFixed(3)} mm`);
  check("the other poles stay put", e.poles.every((q, k) => k === 3 || Math.hypot(q.x - pre.poles[k].x, q.y - pre.poles[k].y) < 1e-6));
  const dragged = await curve();
  check("the curve follows the pole", gap(before, dragged) > 1, `${gap(before, dragged).toFixed(2)} mm`);
  await page.screenshot({ path: path.join(OUT, "bs-3-dragged.png") });

  // 3. double-click the middle of the leg between poles 1 and 2
  const leg = await scr((e.poles[1].x + e.poles[2].x) / 2, (e.poles[1].y + e.poles[2].y) / 2);
  await page.mouse.dblclick(leg.x, leg.y);
  await page.waitForTimeout(800);
  const after = await bs();
  check("double-clicking a polygon leg inserts a pole", after.poles.length === 7, `${after.poles.length} poles`);
  // the samples from before, measured against the new curve itself rather than its polyline
  const drift = await page.evaluate(async (pts) => {
    const m = await import("/src/sketch/bspline.ts");
    const e = window.sketch.entities.find((x) => x.type === "bspline");
    let worst = 0;
    for (const p of pts) {
      const c = m.bsplinePoint(e, m.bsplineNearestParam(e, p));
      worst = Math.max(worst, Math.hypot(c.x - p.x, c.y - p.y));
    }
    return worst;
  }, dragged);
  check("the curve does not move when a pole is inserted", drift < 1e-6, `${drift.toExponential(2)} mm`);
  check("the knots are stored", Array.isArray(after.knots) && after.knots.length === 8, JSON.stringify(after.knots));
  await page.screenshot({ path: path.join(OUT, "bs-4-inserted.png") });

  // 4. click a pole, Delete
  const q = after.poles[5];
  const qs = await scr(q.x, q.y);
  await page.mouse.click(qs.x, qs.y);
  await page.waitForTimeout(400);
  const picked = await page.evaluate(() => window.sketch.selectedPole);
  check("clicking a pole picks it", !!picked && picked.k === 5, JSON.stringify(picked));
  await page.screenshot({ path: path.join(OUT, "bs-5-pole-picked.png") });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(800);
  const del = await bs();
  check("Delete removes the picked pole, not the curve", !!del && del.poles.length === 6, del ? `${del.poles.length} poles` : "curve gone");

  // 4b. right-click straight on a pole: its menu deletes that pole, and the
  // Escape that closes a menu leaves the selection alone
  const r2 = del.poles[2];
  const r2s = await scr(r2.x, r2.y);
  await page.mouse.click(r2s.x, r2s.y, { button: "right" });
  await page.waitForTimeout(400);
  const poleItems = await page.evaluate(() => [...document.querySelectorAll(".ctx-item")].map((x) => x.textContent.trim()));
  check("right-clicking a pole offers Delete Control Point", poleItems.includes("Delete Control Point"), JSON.stringify(poleItems));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape closes the menu and keeps the curve selected", await page.evaluate(() => window.sketch.active && window.sketch.selected.size === 1));
  await page.mouse.click(r2s.x, r2s.y, { button: "right" });
  await page.waitForTimeout(400);
  await page.locator(".ctx-item", { hasText: "Delete Control Point" }).click();
  await page.waitForTimeout(800);
  const del2 = await bs();
  check("Delete Control Point removes the right-clicked pole", !!del2 && del2.poles.length === 5
    && del2.poles.every((q) => Math.hypot(q.x - r2.x, q.y - r2.y) > 1e-6), del2 ? `${del2.poles.length} poles` : "curve gone");

  // 5. finish and extrude
  await page.evaluate(() => window.sketch.finish(true));
  await page.waitForTimeout(1500);
  const saved = await page.evaluate(() => JSON.parse(JSON.stringify(window.store.document.features.find((f) => f.id === "s1").entities)));
  check("the sketch commits the bspline", saved.length === 1 && saved[0].type === "bspline", JSON.stringify(saved).slice(0, 200));
  const built = await page.evaluate(async () => {
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 12, operation: "new" });
    await window.store.rebuildNow();
    const r = window.store.buildState.result;
    return { bodies: r?.bodies?.length ?? 0, error: window.store.buildState.errorMessage };
  });
  check("the closed profile extrudes into one body", built.bodies === 1 && !built.error, JSON.stringify(built));
  await page.evaluate(() => { window.__fundacad.handleAction("iso"); });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "bs-6-extruded.png") });

  // 6. a fit-point spline becomes a control point one from its right-click menu
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s2", type: "sketch", plane: "XY", entities: [
      { type: "spline", id: "f1", points: [{ x: -40, y: 40 }, { x: -20, y: 55 }, { x: 0, y: 42 }, { x: 20, y: 58 }, { x: 40, y: 45 }] },
    ] });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s2"));
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.sketch.setTool("select"));
  const onFit = await scr(0, 42);
  await page.mouse.click(onFit.x, onFit.y, { button: "right" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "bs-7-spline-menu.png") });
  await page.locator(".ctx-item", { hasText: "Edit as Control Points" }).click();
  await page.waitForTimeout(800);
  const conv = await page.evaluate(() => JSON.parse(JSON.stringify(window.sketch.entities.find((x) => x.id === "f1"))));
  check("Edit as Control Points turns the spline into a bspline with the same id", conv.type === "bspline" && conv.poles.length >= 5, `${conv.type}, ${conv.poles?.length} poles`);
  check("its ends stay where they were", Math.hypot(conv.poles[0].x + 40, conv.poles[0].y - 40) < 1e-9 && Math.hypot(conv.poles.at(-1).x - 40, conv.poles.at(-1).y - 45) < 1e-9);
  await page.screenshot({ path: path.join(OUT, "bs-8-converted.png") });

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
