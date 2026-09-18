// A circle drawn from another circle's centre stays concentric, in a real browser.
//
//   1. Starting a circle on an existing circle's centre records a concentric
//      constraint, so moving the first circle takes the second with it.
//   2. CONTROL: a circle started elsewhere records nothing.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/concentric_infer_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "concentric_infer_shots");
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

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c1", x: 15, y: 10, radius: 12 }] });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(2500);
  const at = (x, y) => page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const concentric = () => page.evaluate(() => window.sketch.constraints.filter((c) => c.type === "concentric").length);
  const circle = async (cx, cy, rx, ry) => {
    await page.evaluate(() => window.sketch.setTool("circle"));
    await page.waitForTimeout(200);
    const c = await at(cx, cy);
    const r = await at(rx, ry);
    await page.mouse.move(c.x + 2, c.y + 2);
    await page.mouse.move(c.x, c.y, { steps: 3 });
    await page.mouse.click(c.x, c.y);
    await page.mouse.move(r.x, r.y, { steps: 6 });
    await page.mouse.click(r.x, r.y);
    await page.waitForTimeout(500);
  };

  await circle(60, -30, 75, -30);
  check("CONTROL: a circle started elsewhere records nothing", (await concentric()) === 0);

  await circle(15, 10, 21, 30);
  check("a circle started on another's centre is concentric with it", (await concentric()) === 1);
  const radii = await page.evaluate(() => window.sketch.entities.filter((e) => e.type === "circle").map((e) => e.radius));
  check("SETUP: both new circles have a real radius", radii.length === 3 && radii.every((r) => r > 5), JSON.stringify(radii));

  await page.evaluate(() => window.sketch.setTool("select"));
  await page.waitForTimeout(200);
  const from = await at(15, 22); // on the first circle's rim, which drags it whole
  const to = await at(25, 22);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(3000);
  const centres = await page.evaluate(() => window.sketch.entities.filter((e) => e.type === "circle").map((e) => [e.id, +e.x.toFixed(3), +e.y.toFixed(3)]));
  const c1 = centres.find((c) => c[0] === "c1");
  const inner = centres.find((c) => c[0] !== "c1" && Math.abs(c[1] - 60) > 1);
  check("moving the first circle takes the concentric one with it", !!c1 && !!inner && c1[1] !== 15 && c1[1] === inner[1] && c1[2] === inner[2], JSON.stringify(centres));
  await page.screenshot({ path: path.join(OUT, "01_concentric.png") });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
