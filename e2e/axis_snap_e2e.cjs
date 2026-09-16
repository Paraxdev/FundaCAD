// Dragging a sketch point across an axis snaps onto it and names it, in a real browser.
//
//   1. A circle's centre dragged to just off the X axis lands on it, with "X Axis"
//      beside the marker.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/axis_snap_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "axis_snap_shots");
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
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.sketch && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c1", x: 20, y: 25, radius: 5 }] });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.waitForTimeout(300);
  const at = (x, y) => page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const from = await at(20, 25);
  const near = await at(20, 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(near.x + 3, near.y - 4, { steps: 12 });
  await page.waitForTimeout(400);
  const tag = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=snap-tag]");
    return el && !el.hidden ? el.textContent : "";
  });
  check("the axis is named while the point is on it", tag === "X Axis", JSON.stringify(tag));
  await page.screenshot({ path: path.join(OUT, "01_on_axis.png") });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const c = await page.evaluate(() => {
    const e = window.sketch.entities.find((x) => x.id === "c1");
    return e ? { x: e.x, y: e.y } : null;
  });
  check("the centre lands exactly on the axis", !!c && Math.abs(c.y) < 1e-9, JSON.stringify(c));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
