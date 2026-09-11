// A datum axis is DRAWN where its resolved follow mark says, in a real browser.
//
// The sidecar side is proven headless (tests/test_datum_axis.py): an axis
// anchored to an edge resolves to that edge's line and follows it, reported in
// the rebuild's `datumMarks` header. This is the render-side other half: when a
// datumMark is present for a datum axis, the viewport draws the axis at the
// RESOLVED line, not at the baked coordinate in the document. Proven by writing
// a mark onto the build result and asking the viewport to reflect it, so it does
// not depend on which sidecar build is running, only on the frontend code path
// that reads datumMarks (app/datumPlanes.ts).
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/datum_follow_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "datum_follow_shots");
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

  // pickDatumAt at the screen projection of a world point: does the axis pass
  // through that world point on screen?
  const idAtWorld = (w) => page.evaluate((world) => {
    const s = window.viewport.projectToScreen({ x: world[0], y: world[1], z: world[2] });
    return window.viewport.pickDatumAt(s.x, s.y);
  }, w);

  // A baked datum axis along Z through the origin.
  await page.evaluate(async () => {
    window.store.addFeature({ id: "da", type: "datumAxis", origin: [0, 0, 0], dir: [0, 0, 1], name: "Axis" });
    await window.store.rebuildNow();
  });
  await page.waitForTimeout(500);

  const FAR = [60, 0, 0]; // far off the baked line (which is the Z axis at x=0)
  // BASELINE: the baked axis does NOT pass through a point 60mm off it.
  check("CONTROL: the baked axis is not drawn through a point 60mm off it",
    (await idAtWorld(FAR)) !== "da", JSON.stringify(await idAtWorld(FAR)));

  // Now write a resolved follow mark that moves the axis to x=60, the way a
  // rebuild carrying datumMarks would, and reflect it.
  await page.evaluate(() => {
    const r = window.store.buildState.result;
    r.datumMarks = { da: { kind: "axis", origin: [60, 0, 0], dir: [0, 0, 1] } };
    window.__fundacad.syncDatumPlanes();
  });
  await page.waitForTimeout(300);

  // The axis now passes through x=60 (the resolved line) ...
  check("with a follow mark, the axis is drawn at the resolved line", (await idAtWorld(FAR)) === "da",
    JSON.stringify(await idAtWorld(FAR)));
  // ... and no longer through the baked line at the origin.
  check("and no longer at the baked line it left behind", (await idAtWorld([0, 0, 0])) !== "da",
    JSON.stringify(await idAtWorld([0, 0, 0])));
  await page.screenshot({ path: `${OUT}/datum-follow.png` });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
