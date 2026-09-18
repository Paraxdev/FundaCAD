// The Print Toolbox's phase 2 tools, in a real browser: thread-forming ribs,
// zip-tie channel, elephant-foot chamfer, vertical edge fillet, and a bed fit
// check toast.
//
// Chamfer and fillet each get their OWN body: both are whole-body corner
// treatments, and stacking them on the very same 4 corners of one box would
// have each compete with the other's new geometry there, which is a real
// interaction between the two tools and not what this checks.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5195/] [SC_ENGINE_PORT=8795] node e2e/print_toolbox_phase2_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5195/";
const WS_PORT = process.env.SC_ENGINE_PORT || "8795";
const OUT = path.resolve(process.argv[2] || "print_toolbox_phase2_shots");
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

  const settled = () => page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  const errorMessage = () => page.evaluate(() => window.store.buildState.errorMessage);
  const volumeOf = (bodyId) => page.evaluate((id) => window.viewport.bodyProperties([id])?.volume ?? null, bodyId);
  const bodyIds = () => page.evaluate(() => (window.store.buildState.result?.bodies ?? []).map((b) => b.id));
  const lastFeature = (type) => page.evaluate((t) => {
    const fs = window.store.document.features.filter((f) => f.type === t);
    return fs[fs.length - 1] ?? null;
  }, type);
  const selectFaceNear = async (point) => {
    const id = await page.evaluate((p) => window.viewport.faceIdNear(p), point);
    if (id == null) return false;
    await page.evaluate((id) => window.viewport.selectFaces([id]), id);
    return true;
  };

  // A block with a sideways through hole, for the ribs and (on its top face)
  // the zip-tie channel. This is body1.
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 40 }] });
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 20, operation: "new" });
    window.store.addFeature({ id: "s2", type: "sketch", plane: "XZ", entities: [{ type: "circle", id: "c1", x: 0, y: 10, radius: 3 }] });
    window.store.addFeature({ id: "e2", type: "extrude", sketch: "s2", distance: 100, symmetric: true, operation: "cut" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(800);
  const [body1] = await bodyIds();

  // 1. Thread-forming ribs, on the hole's cylindrical face (a point ON the
  // wall: axis at (0, y, 10), radius 3, so (0, 0, 13) sits on it).
  let v0 = await volumeOf(body1);
  await page.evaluate(() => window.__fundacad.handleAction("print-thread-ribs"));
  await page.waitForTimeout(200);
  check("the hole wall resolves to a face", await selectFaceNear([0, 0, 13]));
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  await settled();
  let v1 = await volumeOf(body1);
  let f = await lastFeature("threadRibs");
  check("no build error after ribs", (await errorMessage()) === null);
  check("thread-forming ribs added a feature and material", !!f && v1 != null && v0 != null && v1 > v0,
    `${v0} -> ${v1}`);
  await page.screenshot({ path: path.join(OUT, "01_ribs.png") });

  // 2. Zip-tie channel, on the top face.
  v0 = v1;
  await page.evaluate(() => window.__fundacad.handleAction("print-zip-tie-channel"));
  await page.waitForTimeout(200);
  check("the top face resolves to a face", await selectFaceNear([0, 0, 20]));
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  await settled();
  v1 = await volumeOf(body1);
  f = await lastFeature("zipTieChannel");
  check("no build error after the channel", (await errorMessage()) === null);
  check("a zip-tie channel added a feature and removed material", !!f && v1 != null && v0 != null && v1 < v0,
    `${v0} -> ${v1}`);
  await page.screenshot({ path: path.join(OUT, "02_zip_tie.png") });

  // 3. Elephant-foot chamfer, on its own body: no pick, acts at once on the
  // body selected here.
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s3", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r3", x: 60, y: 0, width: 30, height: 30 }] });
    window.store.addFeature({ id: "e3", type: "extrude", sketch: "s3", distance: 15, operation: "new" });
    await window.store.rebuildNow();
  });
  await settled();
  const ids2 = await bodyIds();
  const body2 = ids2.find((id) => id !== body1);
  v0 = await volumeOf(body2);
  // No explicit selection: BodyTool falls back to the active (most recently
  // created) body, which is body2 here, and selecting one would raise its
  // move gizmo, which counts as the window being busy.
  await page.evaluate(() => window.__fundacad.handleAction("print-elephant-foot-chamfer"));
  await page.waitForTimeout(1000);
  await settled();
  v1 = await volumeOf(body2);
  f = await lastFeature("elephantFootChamfer");
  check("no build error after the chamfer", (await errorMessage()) === null);
  check("the elephant-foot chamfer added a feature and removed material",
    !!f && v1 != null && v0 != null && v1 < v0, `${v0} -> ${v1}`);
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "03_elephant_foot.png") });

  // 4. Vertical edge fillet, on a third body: same no-pick pattern.
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s4", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r4", x: -60, y: 0, width: 25, height: 25 }] });
    window.store.addFeature({ id: "e4", type: "extrude", sketch: "s4", distance: 12, operation: "new" });
    await window.store.rebuildNow();
  });
  await settled();
  const ids3 = await bodyIds();
  const body3 = ids3.find((id) => id !== body1 && id !== body2);
  v0 = await volumeOf(body3);
  await page.evaluate(() => window.__fundacad.handleAction("print-vertical-fillet"));
  await page.waitForTimeout(1000);
  await settled();
  v1 = await volumeOf(body3);
  f = await lastFeature("verticalFillet");
  check("no build error after the fillet", (await errorMessage()) === null);
  check("the vertical fillet added a feature and removed material",
    !!f && v1 != null && v0 != null && v1 < v0, `${v0} -> ${v1}`);
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "04_vertical_fillet.png") });

  // 5. Bed fit check: a toast, no feature, no build.
  const featuresBefore = await page.evaluate(() => window.store.document.features.length);
  await page.evaluate(() => window.__fundacad.handleAction("print-bed-fit-check"));
  await page.waitForTimeout(500);
  const option = await page.$(".choice-btn");
  check("bed fit check offers a preset to choose", !!option);
  if (option) await option.click();
  await page.waitForTimeout(600);
  const toastText = await page.evaluate(() => document.body.innerText);
  check("bed fit check shows a toast mentioning the bed", toastText.includes("mm bed"),
    JSON.stringify(toastText.slice(0, 300)));
  const featuresAfter = await page.evaluate(() => window.store.document.features.length);
  check("bed fit check is not a feature", featuresAfter === featuresBefore, `${featuresBefore} -> ${featuresAfter}`);
  await page.screenshot({ path: path.join(OUT, "05_bed_fit_toast.png") });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
