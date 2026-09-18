// The dashed angle guide on a tapered extrude, in a real browser.
//
//   1. With a taper typed, a dashed arc stands on the wall that leans.
//   2. Back to zero, it goes.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/taper_guide_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "taper_guide_shots");
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
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 40 }] });
    await window.store.rebuildNow();
    window.__fundacad.handleAction("iso");
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { window.overlay.selectRegionsByPoints([[0, 0, 0]]); window.__fundacad.handleAction("extrude"); });
  await page.waitForTimeout(500);
  const typeInto = async (i, text) => {
    const f = (await page.$$(".dim-input input"))[i];
    await f.click({ clickCount: 3 });
    await page.keyboard.type(text);
    await page.mouse.move(1200, 700);
    await page.mouse.move(1210, 705);
    await page.waitForTimeout(1500);
  };
  await typeInto(0, "30");
  await typeInto(1, "20");
  const guide = () => page.evaluate(() => {
    const g = window.extrude.taperGuide;
    if (!g) return null;
    const p = g.geometry.getAttribute("position");
    let maxX = -Infinity;
    for (let i = 0; i < p.count; i++) maxX = Math.max(maxX, p.getX(i));
    return { maxX };
  });
  const on = await guide();
  check("a taper shows the dashed angle guide", !!on);
  check("standing on the wall that leans", !!on && Math.abs(on.maxX - 20) < 1e-6, JSON.stringify(on));
  await page.screenshot({ path: path.join(OUT, "01_taper_guide.png") });
  await typeInto(1, "0");
  check("no taper, no guide", !(await guide()));
  await page.keyboard.press("Escape");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
