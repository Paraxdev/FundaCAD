// A datum point and a datum axis render as pickable reference geometry, in a
// real browser.
//
// tests/ui/featureMeta.test.ts proves the document format knows the two new
// types, and a sidecar check proves they build without error. Neither can prove
// the VIEWPORT draws them: a datum point is a sphere and a datum axis a thin
// cylinder, placed from the document client-side (app/datumPlanes.ts) and
// hit-tested through a live raycast (viewport.pickDatumAt), none of which a pure
// test has. So the question here is the one those cannot ask, does a datum point
// and a datum axis show up as marks you can click to select, and does an empty
// document deliberately draw neither.
//
// No body on purpose: with nothing solid in the scene every click that lands on
// a mark lands on the mark and nothing behind it, so "clicking it selects it" is
// a clean signal rather than a race with the body in front.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/datum_reference_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "datum_reference_shots");
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

  // Scan the canvas for a pixel where pickDatumAt returns `id` (a mark the ray
  // reaches), the way the double-click test scans for a face: where a mark lands
  // on screen depends on the camera, so it is found, not guessed.
  const findMark = (id) => page.evaluate((wantId) => {
    const r = window.viewport.domElement.getBoundingClientRect();
    for (let yy = r.top + 20; yy < r.bottom - 20; yy += 6) {
      for (let xx = r.left + 20; xx < r.right - 20; xx += 6) {
        if (window.viewport.pickDatumAt(xx, yy) === wantId) return { x: xx, y: yy };
      }
    }
    return null;
  }, id);
  const anyMark = () => page.evaluate(() => {
    const r = window.viewport.domElement.getBoundingClientRect();
    for (let yy = r.top + 20; yy < r.bottom - 20; yy += 6) {
      for (let xx = r.left + 20; xx < r.right - 20; xx += 6) {
        if (window.viewport.pickDatumAt(xx, yy) != null) return { x: xx, y: yy };
      }
    }
    return null;
  });
  const selected = () => page.evaluate(() => window.__fundacad.selectedFeature());

  // --- CONTROL: an empty document draws no reference marks ---------------------
  const before = await anyMark();
  check("CONTROL: an empty document has no datum marks to pick", before === null, JSON.stringify(before));

  // --- create a datum point (offset from the axis) and a datum axis -----------
  await page.evaluate(async () => {
    window.store.addFeature({ id: "dp", type: "datumPoint", point: [8, 0, 0], name: "Point" });
    window.store.addFeature({ id: "da", type: "datumAxis", origin: [0, 0, 0], dir: [0, 0, 1], name: "Axis" });
    await window.store.rebuildNow();
  });
  await page.waitForTimeout(600);

  const pSpot = await findMark("dp");
  const aSpot = await findMark("da");
  check("the datum point renders as a pickable mark", !!pSpot, JSON.stringify(pSpot));
  check("the datum axis renders as a pickable mark", !!aSpot, JSON.stringify(aSpot));
  if (!pSpot || !aSpot) { await page.screenshot({ path: `${OUT}/datums.png` }); await browser.close(); process.exit(1); }

  // The two marks are distinct geometry at distinct screen places.
  check("point and axis pick as different spots", pSpot.x !== aSpot.x || pSpot.y !== aSpot.y);

  // Clicking the point selects the point feature.
  await page.mouse.click(pSpot.x, pSpot.y);
  await page.waitForTimeout(300);
  check("clicking the datum point selects it", (await selected()) === "dp", JSON.stringify(await selected()));

  // Clicking the axis selects the axis feature.
  await page.mouse.click(aSpot.x, aSpot.y);
  await page.waitForTimeout(300);
  check("clicking the datum axis selects it", (await selected()) === "da", JSON.stringify(await selected()));
  await page.screenshot({ path: `${OUT}/datums.png` });

  // --- CONTROL: hiding a datum takes its mark away ----------------------------
  // A visibility toggle re-syncs the marks; drive it through a rebuild so the
  // test leans on no private path.
  await page.evaluate(async () => {
    window.store.setPlaneVisibility("dp", false);
    await window.store.rebuildNow();
  });
  await page.waitForTimeout(400);
  const hidden = await findMark("dp");
  check("CONTROL: a hidden datum point is not drawn or picked", hidden === null, JSON.stringify(hidden));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
