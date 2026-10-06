// Hiding a body rebuilds a cut that acts on whatever is shown, in a real
// browser against a real engine, and a cut that names its bodies stays put.
//
//   1. A hole drilled through two shown blocks is in both (CONTROL).
//   2. Hide one: the model rebuilds and that block is whole again.
//   3. Show it: the hole is back, and undo hides it and fills it again.
//   4. With the cut's bodies named, hiding one changes nothing.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/eye_rebuilds_cut_e2e.cjs
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  const settle = async () => {
    await page.waitForTimeout(700);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(300);
  };
  // From the view's mesh, which keeps a hidden body. A drilled block is told
  // from a whole one by a wide margin, the hole's facets do not matter.
  const volumes = () => page.evaluate(() =>
    Object.fromEntries((window.store.buildState.result?.bodies ?? []).map((b) => {
      const v = window.viewport.bodyProperties([b.id])?.volume ?? NaN;
      return [b.id, v > 7900 ? "whole" : v > 7300 && v < 7600 ? "drilled" : String(v)];
    })));
  const WHOLE = "whole";
  const DRILLED = "drilled";

  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: "a", type: "box", length: 20, width: 20, height: 20 });
    s.addFeature({ id: "b", type: "box", length: 20, width: 20, height: 20 });
    s.addFeature({ id: "b_at", type: "move", dz: 30, bodies: ["body2"] });
    s.addFeature({ id: "drill", type: "cylinder", radius: 3, height: 100, operation: "cut" });
    await s.rebuildNow();
  });
  await settle();
  const both = await volumes();
  check("CONTROL: the hole is in both blocks", both.body1 === DRILLED && both.body2 === DRILLED, JSON.stringify(both));

  await page.evaluate(() => window.store.setBodyVisibility("body2", false));
  await settle();
  const hidden = await volumes();
  check("hiding a block rebuilds, and it is whole again", hidden.body1 === DRILLED && hidden.body2 === WHOLE, JSON.stringify(hidden));

  await page.evaluate(() => window.store.setBodyVisibility("body2", true));
  await settle();
  const shown = await volumes();
  check("showing it drills it again", shown.body2 === DRILLED, JSON.stringify(shown));

  await page.evaluate(() => window.store.undo());
  await settle();
  check("undo hides it and fills the hole", (await volumes()).body2 === WHOLE, JSON.stringify(await volumes()));
  await page.evaluate(() => window.store.redo());
  await settle();
  check("redo drills it again", (await volumes()).body2 === DRILLED, JSON.stringify(await volumes()));

  await page.evaluate(() => window.store.updateFeature("drill", { targets: ["body1", "body2"] }));
  await settle();
  await page.evaluate(() => window.store.setBodyVisibility("body2", false));
  await settle();
  const named = await volumes();
  check("a cut that names its bodies keeps the hole in a hidden one", named.body2 === DRILLED, JSON.stringify(named));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
