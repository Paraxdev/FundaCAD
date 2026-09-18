// A sketch snap names what it caught, in a real browser.
//
//   1. On a sketch started from a face, hovering the face's centre with the
//      Circle tool shows "Face Center" beside the marker.
//   2. Moving off every anchor takes the name away.
//   3. Pulling a circle out from that centre puts the diameter field halfway
//      along the radius, on the drawn diameter line.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/snap_labels_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "snap_labels_shots");
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

  const tag = () => page.evaluate(() => {
    const el = document.querySelector("[data-testid=snap-tag]");
    return el && !el.hidden ? el.textContent : "";
  });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c1", x: 30, y: 20, radius: 25 }] });
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 20, operation: "new" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.viewport.selectFaces([window.viewport.faceIdNear([30, 20, 20])]);
    window.__fundacad.handleAction("sketch");
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.sketch.setTool("circle"));
  await page.waitForTimeout(300);

  const centre = await page.evaluate(() => window.viewport.projectToScreen(new window.viewport.camera.position.constructor(30, 20, 20)));
  await page.mouse.move(centre.x + 40, centre.y + 40);
  await page.mouse.move(centre.x + 2, centre.y + 1, { steps: 6 });
  await page.waitForTimeout(300);
  const t1 = await tag();
  check("hovering the face centre names it", t1 === "Face Center", JSON.stringify(t1));
  await page.screenshot({ path: path.join(OUT, "01_face_center.png") });

  await page.mouse.move(centre.x + 57, centre.y + 43, { steps: 6 });
  await page.waitForTimeout(300);
  const t2 = await tag();
  check("off every anchor there is no name", t2 === "" || t2 == null, JSON.stringify(t2));

  // Placing the centre and pulling out: the diameter field rides the radius line.
  await page.mouse.move(centre.x + 2, centre.y + 1, { steps: 4 });
  await page.mouse.click(centre.x + 2, centre.y + 1);
  await page.waitForTimeout(300);
  const rim = { x: centre.x + 160, y: centre.y - 60 };
  await page.mouse.move(rim.x, rim.y, { steps: 10 });
  await page.waitForTimeout(300);
  const box = await page.evaluate(() => {
    const el = document.querySelector(".dim-input");
    if (!el || el.style.display === "none") return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const mid = { x: (centre.x + rim.x) / 2, y: (centre.y + rim.y) / 2 };
  check("the diameter field sits halfway along the radius", !!box && Math.hypot(box.x - mid.x, box.y - mid.y) < 25, JSON.stringify({ box, mid }));
  await page.screenshot({ path: path.join(OUT, "02_diameter_field.png") });
  await page.keyboard.press("Escape");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
