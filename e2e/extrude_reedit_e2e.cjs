// Re-editing a whole-sketch extrude reopens onto the whole sketch, in a real
// browser.
//
// A whole-sketch extrude (one that never named specific profile areas, e.g. one
// built programmatically or from an older document) saved no region anchors.
// Reopening it therefore had nothing to reselect, so it dropped to "its areas
// are gone, click a profile" with the body gone to an empty preview, even
// though the sketch and its one obvious area were right there. This checks that
// such an extrude now reopens with its area reselected, previewing and
// draggable, and that an extrude which named areas that genuinely no longer
// resolve still says so.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/extrude_reedit_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "extrude_reedit_shots");
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
  await page.addInitScript((t) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, TOKEN);

  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  const prompt = () => page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "");
  const gone = (t) => /areas are gone/i.test(t);

  // --- 1. whole-sketch extrude: no explicit regions saved --------------------
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s", type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: 30, height: 30, x: 0, y: 0 }] });
    window.store.addFeature({ id: "e", type: "extrude", sketch: "s", distance: 20, operation: "new" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(500);

  const saved = await page.evaluate(() => {
    const f = window.store.document.features.find((x) => x.id === "e");
    return { regions: f.regions ?? null, region: f.region ?? null };
  });
  check("the extrude saved no explicit regions (a whole-sketch extrude)",
    !saved.regions && !saved.region, JSON.stringify(saved));

  await page.evaluate(() => window.__fundacad.editFeature("e"));
  await page.waitForTimeout(500);
  const reopened = await page.evaluate(() => ({
    selected: window.__fundacad.overlay.selectedRegions().length,
    busy: window.__fundacad.toolBusy(),
  }));
  const p1 = await prompt();
  console.log("  reopened whole-sketch extrude:", JSON.stringify(reopened), "prompt:", JSON.stringify(p1));
  check("reopening reselects the sketch's area", reopened.selected > 0, `${reopened.selected} selected`);
  check("so the edit is live, not 'areas are gone'", reopened.busy === true && !gone(p1), JSON.stringify(p1));
  await page.screenshot({ path: `${OUT}/wholesketch-reedit.png` });

  // Escape ends the edit cleanly and the body is back.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const restored = await page.evaluate(() => (window.store.buildState.result?.bodies ?? []).length);
  check("Escape ends the edit and the body is restored", restored > 0, `${restored} bodies`);

  // --- 2. CONTROL: named areas that no longer resolve DO say so --------------
  // An extrude that named a specific area by a point which is nowhere on the
  // sketch has genuinely lost it, and must keep the honest message rather than
  // silently grabbing the whole sketch.
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s2", type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: 20, height: 20, x: 80, y: 0 }] });
    // a region point far outside the 20x20 rectangle: it resolves to nothing
    window.store.addFeature({ id: "e2", type: "extrude", sketch: "s2", distance: 10, operation: "new", regions: [[999, 999, 0]] });
    await window.store.rebuildNow();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__fundacad.editFeature("e2"));
  await page.waitForTimeout(500);
  const ctrl = await page.evaluate(() => window.__fundacad.overlay.selectedRegions().length);
  const p2 = await prompt();
  console.log("  reopened extrude with an unresolved named area:", ctrl, "selected, prompt:", JSON.stringify(p2));
  check("CONTROL: a named area that is really gone still says so", ctrl === 0 && gone(p2), JSON.stringify(p2));
  await page.keyboard.press("Escape");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
