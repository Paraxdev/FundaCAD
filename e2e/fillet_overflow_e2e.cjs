// Fillets the kernel refused, in a real browser.
//
//   1. A leg joined onto a round wall, the junction beside the leg's cylinder
//      seam: filleting it commits instead of "the blend has nowhere to end".
//   2. The G2 switch on the heads-up box stores continuity G2 and still builds.
//   3. A rim fillet far wider than the rim's top face carves through and commits.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/fillet_overflow_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "fillet_overflow_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.edgeFeature, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }
  const settle = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(300);
  };
  const blends = () => page.evaluate(() => window.store.document.features.filter((f) => f.type === "fillet").map((f) => ({ id: f.id, radius: f.radius, continuity: f.continuity })));
  const buildError = () => page.evaluate(() => window.store.buildState.errorFeatureId ?? null);

  // Find an edge on screen whose polyline passes near a model point, and click it.
  const pickNear = (pt, match) => page.evaluate(([pt, match]) => {
    const v = window.viewport;
    const V = v.camera.position.constructor;
    const sp = v.projectToScreen(new V(pt[0], pt[1], pt[2]));
    for (let dx = -6; dx <= 6; dx += 2) {
      for (let dy = -6; dy <= 6; dy += 2) {
        const hit = v.pickEdgeAt(sp.x + dx, sp.y + dy);
        if (!hit) continue;
        const ok = new Function("p", `return ${match}`);
        if (hit.edge.points.every((p) => ok(p))) return { x: sp.x + dx, y: sp.y + dy };
      }
    }
    return null;
  }, [pt, match]);

  const filletTyped = async (pt, match, value, g2) => {
    const at = await pickNear(pt, match);
    if (!at) return false;
    await page.evaluate(() => window.__fundacad.handleAction("fillet"));
    await page.waitForTimeout(300);
    await page.mouse.click(at.x, at.y);
    await settle();
    if (g2) {
      const t = await page.$(".dim-input:not([style*='display: none']) .dim-toggle input, .dim-input:not([style*='display: none']) .dim-toggle");
      if (t) await t.click();
      await settle();
    }
    const input = await page.$(".dim-input:not([style*='display: none']) input[type=text]");
    await input.fill(String(value));
    await input.press("Enter");
    await settle();
    await page.waitForTimeout(800);
    await settle();
    return true;
  };

  // --- 1. leg junction beside the seam --------------------------------------
  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "circle", id: "a", x: 0, y: 0, radius: 50 }] });
    s.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 20, operation: "new" });
    s.addFeature({ id: "s2", type: "sketch", plane: "XY", entities: [{ type: "circle", id: "b", x: 0, y: -50, radius: 4.245828802487684 }] });
    s.addFeature({ id: "e2", type: "extrude", sketch: "s2", distance: 30, operation: "join" });
    await s.rebuildNow();
  });
  await settle();
  await page.evaluate(() => { const v = window.viewport; const V = v.camera.position.constructor; v.rig.lookAtPlane(new V(4, -50, 10), new V(0.6, -0.8, 0.3).normalize(), new V(0, 0, 1)); });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1000);
  await page.evaluate(() => { const v = window.viewport; v.rig.controls.zoomTo?.(4, false); v.rig.controls.setTarget?.(4, -50, 10, false); v.requestRender(); });
  await page.waitForTimeout(800);
  const junction = "Math.abs(p[0] - 4.242) < 0.3 && Math.abs(p[1] + 49.82) < 0.3 && p[2] > -0.1 && p[2] < 20.1";
  const ok1 = await filletTyped([4.242, -49.82, 10], junction, 2, false);
  check("the junction beside the seam is on screen and pickable", ok1);
  let fs1 = await blends();
  check("a 2mm fillet on it commits", fs1.length === 1 && fs1[0].radius === 2, fs1);
  check("and builds without an error", (await buildError()) === null, await buildError());
  await page.screenshot({ path: path.join(OUT, "01_junction.png") });

  // --- 2. G2 from the heads-up box -------------------------------------------
  const other = "Math.abs(p[0] + 4.242) < 0.3 && Math.abs(p[1] + 49.82) < 0.3 && p[2] > -0.1 && p[2] < 20.1";
  const ok2 = await filletTyped([-4.242, -49.82, 10], other, 2, true);
  check("the other junction is pickable", ok2);
  fs1 = await blends();
  check("the G2 switch stores continuity G2", fs1.length === 2 && fs1[1].continuity === "G2", fs1);
  check("and it builds", (await buildError()) === null, await buildError());
  await page.screenshot({ path: path.join(OUT, "02_g2.png") });

  // --- 3. a rim fillet far wider than the rim ---------------------------------
  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: "s3", type: "sketch", plane: "XY", entities: [
      { type: "circle", id: "o", x: 300, y: 0, radius: 50 },
      { type: "circle", id: "i", x: 300, y: 0, radius: 47 },
    ] });
    s.addFeature({ id: "e3", type: "extrude", sketch: "s3", distance: 30, operation: "new", regions: [[348.5, 0, 0]] });
    await s.rebuildNow();
  });
  await settle();
  await page.evaluate(() => { const v = window.viewport; const V = v.camera.position.constructor; v.rig.lookAtPlane(new V(350, 0, 30), new V(0.7, -0.4, 0.6).normalize(), new V(0, 0, 1)); v.rig.controls.setTarget?.(350, 0, 30, false); v.requestRender(); });
  await page.waitForTimeout(800);
  const rim = "Math.abs(Math.hypot(p[0] - 300, p[1]) - 50) < 0.3 && Math.abs(p[2] - 30) < 0.3";
  const ok3 = await filletTyped([350, 0, 30], rim, 10, false);
  check("the outer rim of a 3mm wall is pickable", ok3);
  const fs3 = await blends();
  check("a 10mm fillet on that 3mm rim commits", fs3.length === 3 && fs3[2].radius === 10, fs3);
  check("and builds, carving past the rim", (await buildError()) === null, await buildError());
  await page.screenshot({ path: path.join(OUT, "03_rim.png") });
  await page.evaluate(() => window.__fundacad.handleAction("front"));
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, "04_rim_front.png") });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
