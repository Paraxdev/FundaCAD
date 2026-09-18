// Sketching on a face far from the origin frames that face, not the origin.
//
//   1. Select the top face of a box sitting well off the origin, start a sketch:
//      the face centre lands in the middle of the canvas.
//   2. Leave and reopen the same sketch: still centred on its face.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/sketch_face_focus_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "sketch_face_focus_shots");
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
  const idle = () => page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [
      { type: "rectangle", id: "r1", x: 200, y: 120, width: 40, height: 40 },
    ] });
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" });
    await window.store.rebuildNow();
  });
  await idle();
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1500);

  const offCentre = async () => page.evaluate(() => {
    const c = window.viewport.canvas.getBoundingClientRect();
    const s = window.viewport.projectToScreen(new window.sketch.plane.origin.constructor(200, 120, 10));
    return Math.hypot(s.x - (c.left + c.width / 2), s.y - (c.top + c.height / 2));
  });

  const top = await page.evaluate(() => window.viewport.projectToScreen(new window.sketch.plane.origin.constructor(205, 125, 10)));
  await page.mouse.click(top.x, top.y);
  await page.waitForTimeout(500);
  await page.mouse.click(top.x, top.y);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__fundacad.handleAction("sketch"));
  await page.waitForTimeout(2500);
  check("a sketch opened", await page.evaluate(() => window.sketch.active));
  check("the sketch is on the face", await page.evaluate(() => Math.abs(window.sketch.plane.origin.z - 10) < 1e-6 || Math.abs(window.sketch.plane.n.z) > 0.99));
  const d1 = await offCentre();
  check("the face centre is in the middle of the canvas", d1 < 40, `${d1.toFixed(1)} px off`);
  await page.screenshot({ path: path.join(OUT, "01_face_sketch.png") });

  await page.evaluate(() => window.sketch.entities.push({ type: "circle", id: "c9", x: 0, y: 0, radius: 3 }));
  await page.evaluate(() => window.sketch.active && window.sketch.finish(true));
  await page.waitForTimeout(800);
  await idle();
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(1200);
  const sk = await page.evaluate(() => window.store.document.features.filter((f) => f.type === "sketch").map((f) => f.id).pop());
  if (sk && sk !== "s1") {
    await page.evaluate((id) => window.__fundacad.editFeature(id), sk);
    await page.waitForTimeout(2500);
    const d2 = await offCentre();
    check("reopening that sketch frames its face again", d2 < 40, `${d2.toFixed(1)} px off`);
    await page.screenshot({ path: path.join(OUT, "02_reopened.png") });
  } else {
    check("the face sketch was kept", false, JSON.stringify(sk));
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
