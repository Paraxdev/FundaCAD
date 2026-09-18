// The Normal to Sketch button, in a real browser.
//
//   1. Square to the plane on entry, no button.
//   2. Orbit away and the button appears; clicking it squares the view and the
//      button goes.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/normal_to_sketch_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "normal_to_sketch_shots");
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

  const button = () => page.$("[data-testid=normal-to-sketch]");
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c1", x: 0, y: 0, radius: 10 }] });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(2500);
  check("square on entry, no button", !(await button()));

  // Orbit is a right drag.
  await page.mouse.move(700, 450);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(820, 380, { steps: 12 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(600);
  const shown = await button();
  check("orbiting away shows the button", !!shown);
  await page.screenshot({ path: path.join(OUT, "01_off_normal.png") });
  if (shown) {
    await shown.click();
    await page.waitForTimeout(1500);
    check("clicking it squares the view and the button goes", !(await button()));
  }
  check("the sketch is still open", await page.evaluate(() => window.sketch.active));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
