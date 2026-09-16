// Constraint glyphs ride along while sketch geometry is dragged, in a real browser.
//
//   1. Dragging a constrained line moves its glyph during the drag, before the
//      button is released, not only once it lands.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/glyphs_follow_drag_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "glyphs_follow_drag_shots");
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
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY",
      entities: [{ type: "line", id: "l1", x1: -20, y1: 0, x2: 20, y2: 0 }],
      constraints: [{ type: "horizontal", line: "l1" }],
    });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.waitForTimeout(300);

  const glyph = () => page.evaluate(() => {
    const el = document.querySelector(".sketch-glyphs > *");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  const at = (x, y) => page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);

  const before = await glyph();
  check("the line shows a glyph", !!before, JSON.stringify(before));
  const from = await at(10, 0);
  const to = await at(10, 15);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.waitForTimeout(300);
  const during = await glyph();
  await page.screenshot({ path: path.join(OUT, "01_dragging.png") });
  const moved = before && during ? Math.hypot(during.x - before.x, during.y - before.y) : 0;
  check("the glyph moves with the line before release", moved > 20, `${moved.toFixed(1)} px`);
  await page.mouse.up();

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
