// Offset Face in Total mode, in a real browser.
//
//   1. Offset Face on a box's top face offers a Total switch.
//   2. With it on, the field reads the whole thickness to the opposite face (20).
//   3. Typing a thickness (12) commits the offset that gives it (-8), and the
//      box is then 12 tall.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/offset_face_total_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "offset_face_total_shots");
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
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 30, height: 30 }] });
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 20, operation: "new" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.viewport.selectFaces([window.viewport.faceIdNear([0, 0, 20])]);
    window.__fundacad.handleAction("offset-face");
  });
  await page.waitForTimeout(500);

  const toggle = await page.$(".dim-input .dim-toggle");
  check("Offset Face offers a Total switch", !!toggle && (await toggle.textContent()) === "Total");
  if (toggle) {
    await toggle.dispatchEvent("pointerdown");
    await page.waitForTimeout(200);
  }
  const shown = await page.$eval(".dim-input input", (el) => el.value);
  check("with it on the field reads the whole thickness", Number.parseFloat(shown) === 20, shown);
  await page.screenshot({ path: path.join(OUT, "01_total.png") });

  const input = await page.$(".dim-input input");
  await input.click({ clickCount: 3 });
  await page.keyboard.type("12");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  const f = await page.evaluate(() => window.store.document.features.find((x) => x.type === "offsetFace") ?? null);
  check("typing a thickness commits the offset that gives it", !!f && Math.abs(f.distance + 8) < 1e-6, JSON.stringify(f && f.distance));
  const height = await page.evaluate(() => {
    const bb = window.store.buildState.result?.bbox;
    return bb ? bb.max[2] - bb.min[2] : null;
  });
  check("and the box is that thick", height != null && Math.abs(height - 12) < 1e-3, String(height));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
