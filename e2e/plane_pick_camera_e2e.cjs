// End-to-end check that a plane a tool asks for draws over the model and takes
// the click through it, and that Reset camera and New put the view back home.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<token> SC_CHROME=<browser> node e2e/plane_pick_camera_e2e.cjs
const { chromium } = require("playwright-core");
const path = require("path");
const os = require("os");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const FIXTURE = path.resolve(__dirname, "../tests/fixtures/asm_nested.step");
const OUT = process.env.SC_OUT || path.join(os.tmpdir(), "plane_pick_camera_shots");
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  require("fs").mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.SC_CHROME || "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
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
  await page.waitForTimeout(3500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.geometry, null, { timeout: 60000 });

  await page.evaluate(async (file) => {
    const res = await window.geometry.importGeometry(file, "step");
    window.store.addFeature({
      id: window.store.nextId(), type: "import", format: "step",
      name: res.name, geom: res.geom, source: file, solid: res.solid,
      ...(res.nodes !== undefined ? { nodes: res.nodes } : {}),
      ...(res.parts !== undefined ? { parts: res.parts } : {}),
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!window.store.buildState.building && window.store.buildState.result) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, FIXTURE);
  await page.waitForTimeout(1500);

  // --- planes over the model ---------------------------------------------------
  await page.evaluate(() => window.__fundacad.handleAction("sketch"));
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => ({
    onTop: window.viewport.constructionOnTop,
    depthTest: window.viewport.scene.planes.XY.material.depthTest,
  }));
  check("the planes draw over the model while a tool asks for one", state.onTop && state.depthTest === false, JSON.stringify(state));

  const through = await page.evaluate(() => {
    const r = window.viewport.domElement.getBoundingClientRect();
    for (let x = r.left + 320; x < r.right - 120; x += 4) {
      for (let y = r.top + 80; y < r.bottom - 80; y += 4) {
        if (document.elementFromPoint(x, y) !== window.viewport.domElement) continue;
        const c = window.viewport.pickConstructionAt(x, y);
        if (c?.kind !== "base") continue;
        if (!window.viewport.pickFaceForPressPull(x, y)) continue;
        return { x, y, plane: c.plane };
      }
    }
    return null;
  });
  check("found a plane in front of a body face", !!through, JSON.stringify(through));
  await page.screenshot({ path: path.join(OUT, "1-planes-on-top.png") });
  if (through) {
    await page.mouse.move(through.x, through.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(800);
    const took = await page.evaluate(() => ({ active: window.sketch.active, plane: window.sketch.plane ?? null }));
    check("clicking there sketches on the plane, not the face", took.active && JSON.stringify(took.plane).includes(through.plane),
      JSON.stringify(took));
    await page.evaluate(() => window.sketch.cancel());
    await page.waitForTimeout(300);
  }
  const after = await page.evaluate(() => ({
    onTop: window.viewport.constructionOnTop,
    depthTest: window.viewport.scene.planes.XY.material.depthTest,
  }));
  check("the planes go back behind the model afterwards", !after.onTop && after.depthTest === true, JSON.stringify(after));

  // --- reset camera ---------------------------------------------------------------
  const dirOf = () => page.evaluate(() => {
    const c = window.viewport.rig.controls;
    const p = c.getPosition(new window.viewport.rig.active.position.constructor());
    const t = c.getTarget(new window.viewport.rig.active.position.constructor());
    const d = p.sub(t).normalize();
    return [d.x, d.y, d.z].map((v) => Math.round(v * 100) / 100);
  });
  const home = await dirOf();
  await page.evaluate(() => { window.viewport.rig.controls.rotate(1.3, -0.4, false); window.viewport.setStandardView("top"); });
  await page.waitForTimeout(1200);
  const moved = await dirOf();
  const btn = await page.$('button[title^="Reset camera"]');
  check("there is a Reset camera button", !!btn);
  if (btn) await btn.click();
  await page.waitForTimeout(1500);
  const reset = await dirOf();
  const expected = [80, -120, 90];
  const len = Math.hypot(...expected);
  const want = expected.map((v) => Math.round((v / len) * 100) / 100);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.03);
  check("the view had moved", !near(moved, want), JSON.stringify(moved));
  check("Reset camera looks in from the home corner", near(reset, want), `${JSON.stringify(reset)} want ${JSON.stringify(want)} (start ${JSON.stringify(home)})`);

  // --- new document ----------------------------------------------------------------
  await page.evaluate(() => { window.viewport.setStandardView("front"); window.viewport.rig.controls.dolly(200, false); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.store.markSaved("x.funda"); window.__fundacad.handleAction("new"); });
  await page.waitForTimeout(1500);
  const fresh = await page.evaluate(() => {
    const c = window.viewport.rig.controls;
    const t = c.getTarget(new window.viewport.rig.active.position.constructor());
    return { target: [t.x, t.y, t.z].map((v) => Math.round(v)), features: window.store.document.features.length };
  });
  const freshDir = await dirOf();
  check("New empties the document", fresh.features === 0, JSON.stringify(fresh));
  check("New puts the camera home on the origin", near(freshDir, want) && fresh.target.every((v) => v === 0),
    `${JSON.stringify(freshDir)} target ${JSON.stringify(fresh.target)}`);
  await page.screenshot({ path: path.join(OUT, "2-new.png") });

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})();
