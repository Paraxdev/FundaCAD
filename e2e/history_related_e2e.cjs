// History narrowed to what relates to the selection, in a real browser.
//
//   1. With nothing selected every feature shows and there is no filter chip.
//   2. Selecting a face of one body shows that body's extrude and its sketch,
//      and hides the other body's.
//   3. The chip turns the filter off, and the choice sticks.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/history_related_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "history_related_shots");
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
  await page.evaluate(() => { try { localStorage.removeItem("fundacad.historyRelated"); } catch {} });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "sa", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "ra", x: 0, y: 0, width: 20, height: 20 }] });
    window.store.addFeature({ id: "ea", type: "extrude", sketch: "sa", distance: 10, operation: "new" });
    window.store.addFeature({ id: "sb", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "rb", x: 60, y: 0, width: 20, height: 20 }] });
    window.store.addFeature({ id: "eb", type: "extrude", sketch: "sb", distance: 10, operation: "new" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length === 2, null, { timeout: 60000 });
  const wake = () => page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup")));
  const shown = () => page.evaluate(() =>
    [...document.querySelectorAll("#timeline .timeline-item")].filter((el) => el.style.display !== "none").map((el) => el.dataset.feature));
  const chip = () => page.$("[data-testid=history-related]");

  await wake();
  await page.waitForTimeout(400);
  check("nothing selected: every feature and no chip", (await shown()).length === 4 && !(await chip()), JSON.stringify(await shown()));

  await page.evaluate(() => {
    window.viewport.selectFaces([window.viewport.faceIdNear([0, 0, 10])]);
    window.viewport.onSelectionChange?.();
  });
  await wake();
  await page.waitForTimeout(500);
  const narrowed = await shown();
  check("a face of the first body shows its extrude and sketch only", narrowed.join() === "sa,ea", JSON.stringify(narrowed));
  await page.screenshot({ path: path.join(OUT, "01_related.png") });

  const c = await chip();
  check("the chip is there", !!c);
  if (c) {
    await c.click();
    await page.waitForTimeout(300);
    check("the chip turns the filter off", (await shown()).length === 4, JSON.stringify(await shown()));
    const kept = await page.evaluate(() => localStorage.getItem("fundacad.historyRelated"));
    check("and the choice sticks", kept === "0", String(kept));
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
