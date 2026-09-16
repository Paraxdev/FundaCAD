// The edge handle stands where the edge was clicked, in a real browser.
//
//   1. Clicking near one end of an edge puts the handle there, not mid-edge.
//   2. Grabbing it arms Fillet at that same point, so nothing jumps.
//   3. CONTROL: an edge selected without a click still gets the midpoint.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/edge_handle_at_click_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "edge_handle_at_click_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "b1", type: "box", length: 60, width: 40, height: 20 });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(1200);

  const anchor = () => page.evaluate(() => {
    const w = window.__fundacad.nudge.want;
    return w ? [w.anchor.x, w.anchor.y, w.anchor.z] : null;
  });

  // The top front edge runs along X at y = -20, z = 10. Aim three quarters along it.
  const target = [18, -20, 10];
  const scr = await page.evaluate((t) => window.viewport.projectToScreen(new window.viewport.camera.position.constructor(...t)), target);
  await page.mouse.move(scr.x, scr.y);
  await page.waitForTimeout(200);
  await page.mouse.click(scr.x, scr.y);
  await page.waitForTimeout(600);
  const picked = await page.evaluate(() => window.viewport.selectedEdgeLines().length);
  check("the click picked one edge", picked === 1, `${picked}`);
  const a = await anchor();
  check("the handle stands where the edge was clicked", !!a && dist(a, target) < 2.5, JSON.stringify(a));
  await page.screenshot({ path: path.join(OUT, "01_at_click.png") });

  if (a) {
    // A little way up the handle from its foot, where the glyph is thick enough to hit.
    const h = await page.evaluate(() => {
      const w = window.__fundacad.nudge.want;
      const k = window.viewport.pixelWorldSize(w.anchor);
      return window.viewport.projectToScreen(w.anchor.clone().addScaledVector(w.axis(window.viewport), k * 20));
    });
    await page.mouse.move(h.x, h.y);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.waitForTimeout(400);
    const tool = await page.evaluate(() => {
      const t = window.edgeFeature;
      return t.active ? [t.anchor.x, t.anchor.y, t.anchor.z] : null;
    });
    check("grabbing it arms Fillet at the same point", !!tool && dist(tool, a) < 1e-6, JSON.stringify(tool));
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }

  await page.evaluate(() => {
    window.viewport.clearSelection();
    const e = window.viewport.edgeLineByMid([0, 20, 10]);
    window.viewport.selectEdgeLines(e ? [e] : []);
    window.viewport.onSelectionChange?.();
  });
  await page.waitForTimeout(400);
  const mid = await anchor();
  check("CONTROL: an edge selected without a click gets the midpoint", !!mid && dist(mid, [0, 20, 10]) < 0.5, JSON.stringify(mid));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
