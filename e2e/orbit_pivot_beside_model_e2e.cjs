// A right-drag orbit that starts beside the model turns about the model nearby.
//
// Two boxes 400mm apart, the view close on one of them. Pressing on empty space
// next to it used to pivot on the centre of BOTH bodies, 200mm away, so a 60px
// drag flung the near box off the screen. It must stay in view and move about
// as far as the drag did.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/orbit_pivot_beside_model_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "orbit_pivot_shots");
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
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }
  const rect = (id, w, h, x = 0, y = 0) => ({ id, type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: w, height: h, x, y }] });
  await page.evaluate(async (fs) => {
    window.store.loadDocument({ parameters: {}, features: fs });
    await window.store.rebuildNow();
  }, [
    rect("a", 10, 10), { id: "ea", type: "extrude", sketch: "a", distance: 10, operation: "new" },
    rect("b", 10, 10, 400), { id: "eb", type: "extrude", sketch: "b", distance: 10, operation: "new" },
  ]);
  await page.waitForTimeout(400);
  await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const c = window.viewport.rig.controls;
    c.setLookAt(-40, -60, 45, 0, 0, 5, false);
    window.viewport.requestRender();
  });
  await page.waitForTimeout(800);
  const screen = () => page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    return v.projectToScreen(new V(0, 0, 5));
  });
  const before = await screen();
  await page.screenshot({ path: path.join(OUT, "01_before.png") });
  const box = await page.evaluate(() => {
    const r = window.viewport.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const startX = Math.min(box.left + box.width - 40, before.x + 420);
  const startY = before.y;
  const pivot = await page.evaluate(([x, y]) => window.viewport.orbitPivotAt(x, y)?.toArray(), [startX, startY]);
  check("the press is beside the model, not on it", pivot !== undefined);
  check("its pivot is on the near box, not between the two", !!pivot && Math.hypot(pivot[0], pivot[1]) < 12, pivot);
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(startX + i * 5, startY, { steps: 1 });
    await page.waitForTimeout(16);
  }
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(1200);
  const after = await screen();
  await page.screenshot({ path: path.join(OUT, "02_after.png") });
  const moved = Math.hypot(after.x - before.x, after.y - before.y);
  check("the near box stays on screen", after.x > box.left && after.x < box.left + box.width && after.y > box.top && after.y < box.top + box.height, after);
  check("and moves no further than the orbit itself would carry a point beside it", moved < 500, { before, after, moved });
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
