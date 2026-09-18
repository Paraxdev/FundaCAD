// The selection readout beside the frame counter, in a real browser.
//
//   1. A round edge reads its count, length and diameter.
//   2. A round face reads its count and diameter, a flat one only its count.
//   3. Nothing selected shows no readout.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/selection_readout_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "selection_readout_shots");
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

  const readout = async () => {
    await page.mouse.move(700, 880); // the readout wakes on pointer and key release
    await page.keyboard.up("Shift");
    await page.waitForTimeout(300);
    return page.evaluate(() => document.querySelector("[data-testid=selection-readout]")?.textContent?.trim() ?? "");
  };
  const wake = () => page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup")));

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c1", x: 0, y: 0, radius: 25 }] });
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 30, operation: "new" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(1000);

  check("nothing selected shows no readout", (await readout()) === "");

  await page.evaluate(() => {
    const e = window.viewport.edgeLineByMid([25, 0, 30]) ?? window.viewport.edgeLineByMid([-25, 0, 30]);
    window.viewport.selectEdgeLines(e ? [e] : []);
  });
  await wake();
  const edge = await readout();
  check("a round edge reads count, length and diameter", /^1 edge · 15\d\.\d+ mm · ⌀50 mm$/.test(edge), JSON.stringify(edge));
  await page.screenshot({ path: path.join(OUT, "01_edge.png") });

  await page.evaluate(() => {
    window.viewport.clearSelection();
    window.viewport.selectFaces([window.viewport.faceIdNear([25, 0, 15])]);
  });
  await wake();
  const side = await readout();
  check("a round face reads its diameter", /^1 face · ⌀50 mm$/.test(side), JSON.stringify(side));

  await page.evaluate(() => {
    window.viewport.clearSelection();
    window.viewport.selectFaces([window.viewport.faceIdNear([0, 0, 30])]);
  });
  await wake();
  const top = await readout();
  check("a flat face reads only its count", top === "1 face", JSON.stringify(top));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
