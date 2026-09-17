// The Hole tool, in a real browser.
//
//   1. Hole on a block's top face places a hole where the face was clicked.
//   2. Clicking more spots adds holes, clicking a hole takes it away.
//   3. Typing a size (M4) and a depth (8) commits a blind M4 clearance hole
//      feature, and the block loses that much material.
//   4. Re-editing it and stepping the type switch makes it a counterbore sized
//      for the M4 socket head.
//   5. Picking M3 in the Size row under the feature re-derives the diameter and
//      the counterbore.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] [SC_SIDECAR_PORT=8765] node e2e/hole_tool_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const WS_PORT = process.env.SC_SIDECAR_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "hole_tool_shots");
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
  await page.addInitScript(({ t, ws }) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(":8765", `:${ws}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, { t: TOKEN, ws: WS_PORT });
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 40 }] });
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 20, operation: "new" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(800);
  const settled = () => page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  const screen = (p) => page.evaluate(([x, y, z]) => {
    const s = window.viewport.projectToScreen(new window.viewport.anchorVector(x, y, z));
    return { x: s.x, y: s.y };
  }, p);
  const volume = () => page.evaluate(() => window.viewport.bodyProperties(null)?.volume ?? null);
  const v0 = await volume();

  // three.js is not on window, so borrow a Vector3 from the viewport's own camera
  await page.evaluate(() => {
    const V = window.viewport.rayFrom(0, 0).ray.origin.constructor;
    window.viewport.anchorVector = V;
  });

  await page.evaluate(() => window.__fundacad.handleAction("hole"));
  await page.waitForTimeout(300);
  const click = async (p) => {
    const s = await screen(p);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(250);
  };
  await click([-10, -10, 20]);
  const tool = () => page.evaluate(() => ({ active: window.__fundacad.hole.active, n: window.__fundacad.hole.points.length }));
  let t = await tool();
  check("clicking the top face starts a hole there", t.active && t.n === 1, JSON.stringify(t));
  await click([10, -10, 20]);
  await click([10, 10, 20]);
  t = await tool();
  check("more clicks add holes", t.n === 3, JSON.stringify(t));
  await click([10, 10, 20]);
  t = await tool();
  check("clicking a hole takes it away", t.n === 2, JSON.stringify(t));

  const inputs = await page.$$(".dim-input input");
  await inputs[0].click({ clickCount: 3 });
  await page.keyboard.type("M4");
  await inputs[1].click({ clickCount: 3 });
  await page.keyboard.type("8");
  await page.waitForTimeout(1500);
  await settled();
  await page.screenshot({ path: path.join(OUT, "01_preview.png") });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  await settled();
  await page.waitForTimeout(500);
  const f = await page.evaluate(() => window.store.document.features.find((x) => x.type === "hole") ?? null);
  check("Enter commits a blind M4 hole feature with two positions",
    !!f && f.size === "M4" && f.diameter === 4.5 && f.extent === "blind" && f.depth === 8 && f.points.length === 2,
    JSON.stringify(f));
  const v1 = await volume();
  const expected = 2 * Math.PI * 2.25 * 2.25 * 8;
  check("the block loses two 4.5 x 8 bores", v0 != null && v1 != null && Math.abs(v0 - v1 - expected) < expected * 0.03,
    `${v0} -> ${v1}, expected ${expected.toFixed(2)} removed`);
  const errs = await page.evaluate(() => window.store.buildState.result?.errors ?? []);
  check("the build has no errors", errs.length === 0, JSON.stringify(errs));
  await page.screenshot({ path: path.join(OUT, "02_committed.png") });

  await page.evaluate((id) => window.__fundacad.editFeature(id), f.id);
  await page.waitForTimeout(500);
  t = await tool();
  check("re-editing opens the tool on its two holes", t.active && t.n === 2, JSON.stringify(t));
  const toggle = await page.$(".dim-input .dim-toggle");
  if (toggle) await toggle.dispatchEvent("pointerdown");
  await page.waitForTimeout(1200);
  await settled();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  await settled();
  const g = await page.evaluate(() => window.store.document.features.find((x) => x.type === "hole") ?? null);
  check("the type switch makes it a counterbore for the M4 head",
    !!g && g.id === f.id && g.holeType === "counterbore" && g.cbDiameter === 8 && g.cbDepth === 4.4 && g.points.length === 2,
    JSON.stringify(g));
  await page.screenshot({ path: path.join(OUT, "03_counterbore.png") });

  await page.evaluate((id) => window.__fundacad.selectFeature(id), f.id);
  await page.waitForTimeout(800);
  const picked = await page.evaluate(() => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "M2.5"));
    if (!sel) return false;
    sel.value = "M3";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  await page.waitForTimeout(800);
  await settled();
  const h = await page.evaluate(() => window.store.document.features.find((x) => x.type === "hole") ?? null);
  check("the Size row re-derives the diameter and counterbore",
    picked && !!h && h.size === "M3" && h.diameter === 3.4 && h.cbDiameter === 6.5 && h.cbDepth === 3.4,
    JSON.stringify(h));
  await page.screenshot({ path: path.join(OUT, "04_rows.png") });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
