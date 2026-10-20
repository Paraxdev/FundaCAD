// A reference image inserted on XY, calibrated to 100 mm, saved and reopened,
// in a real browser against the real geometry engine.
//
//   1. Insert: pick the XY plane, choose tests/fixtures/refimg/ref400x200.png.
//   2. Calibrate: click two image points 80 % of its width apart, type 100.
//      The quad is then 125 x 62.5 mm and the two points are 100 mm apart.
//   3. Save and reopen: the quad comes back at the same size, its texture
//      fetched back from the engine's blob store.
//   4. A picture leaves the image out unless asked; the document the engine
//      builds never holds it.
//
// Usage (from the repo root, with vite and the engine (`fundacad-engine --ws`) running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] [SC_ENGINE_PORT=8765] [SC_SHOT=out.png] node e2e/reference_image_e2e.cjs
const path = require("path");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

const PNG = path.join(__dirname, "../tests/fixtures/refimg/ref400x200.png");
const HASH = "429c5bc1257ce3bdfc611423f2302bd2";

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(({ t, port }) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(":8765", `:${port}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, { t: TOKEN, port: PORT });
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });
  await page.waitForFunction(() => window.geometry.connected, null, { timeout: 60000 });
  await page.evaluate(() => window.viewport.setStandardView("top"));
  await page.waitForTimeout(1500);

  // The quad's world matrix, read from the scene object the plugin tags.
  const quad = () => page.evaluate(() => {
    let found = null;
    window.viewport.scene.scene.traverse((o) => { if (o.userData.referenceImage) found = o; });
    if (!found) return null;
    found.updateMatrixWorld(true);
    const m = found.matrixWorld.elements;
    return {
      m: [...m],
      sx: Math.hypot(m[0], m[1], m[2]),
      sy: Math.hypot(m[4], m[5], m[6]),
      textured: !!found.material.map,
      visible: found.visible,
      layer: found.layers.mask,
    };
  });
  // Image (u, v) to world, through the quad's own matrix (local x = u - 0.5, y = 0.5 - v).
  const world = (q, u, v) => {
    const x = u - 0.5;
    const y = 0.5 - v;
    const m = q.m;
    return [m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13], m[2] * x + m[6] * y + m[14]];
  };
  const screen = (p) => page.evaluate((w) => window.viewport.projectToScreen({ x: w[0], y: w[1], z: w[2] }), p);

  console.log("1. insert on XY");
  await page.evaluate(() => window.__fundacad.handleAction("referenceImage"));
  await page.waitForTimeout(400);
  const xy = await screen([30, 30, 0]);
  await page.mouse.move(xy.x, xy.y);
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
  await page.mouse.click(xy.x, xy.y);
  await (await chooser).setFiles(PNG);
  await page.waitForFunction(() => window.store.referenceImages().length === 1, null, { timeout: 20000 }).catch(async (e) => {
    console.log(await page.evaluate(() => JSON.stringify({ conn: window.geometry.connected, toasts: [...document.querySelectorAll(".toast .toast-msg")].map((t) => t.textContent) })));
    throw e;
  });
  const entry = await page.evaluate(() => window.store.referenceImages()[0]);
  check("the entry names the blob by its hash", entry.image === HASH, entry.image);
  check("it sits on XY with the file's pixel size", entry.plane === "XY" && entry.px[0] === 400 && entry.px[1] === 200, JSON.stringify(entry.plane) + " " + JSON.stringify(entry.px));
  await page.waitForFunction(() => {
    let ok = false;
    window.viewport.scene.scene.traverse((o) => { if (o.userData.referenceImage && o.material.map) ok = true; });
    return ok;
  }, null, { timeout: 10000 });
  let q = await quad();
  check("a textured quad 100 x 50 mm", q && q.textured && near(q.sx, 100) && near(q.sy, 50), q && `${q.sx} x ${q.sy}`);

  console.log("2. calibrate to 100 mm");
  await page.click('[data-panel="reference-image"] [data-action="calibrate"]');
  const a = await screen(world(q, 0.1, 0.5));
  const b = await screen(world(q, 0.9, 0.5));
  await page.mouse.click(a.x, a.y);
  await page.waitForTimeout(150);
  await page.mouse.click(b.x, b.y);
  await page.waitForSelector('[data-panel="reference-image"] [data-field="distance"]', { timeout: 5000 });
  await page.fill('[data-panel="reference-image"] [data-field="distance"]', "100");
  await page.press('[data-panel="reference-image"] [data-field="distance"]', "Enter");
  await page.waitForTimeout(300);
  q = await quad();
  // The clicks land on whole pixels, so the picked points are within a pixel of u 0.1 and 0.9.
  const cal = await page.evaluate(() => window.store.referenceImages()[0]);
  check("the quad is about 125 x 62.5 mm", near(q.sx, 125, 1.5) && near(q.sy, 62.5, 0.75), `${q.sx} x ${q.sy}`);
  check("the aspect is kept", near(q.sx / q.sy, 2, 1e-9), String(q.sx / q.sy));
  // Where the two clicks landed on XY, then where those image points are now.
  const landed = await page.evaluate(({ a, b }) => {
    let mesh = null;
    window.viewport.scene.scene.traverse((o) => { if (o.userData.referenceImage) mesh = o; });
    const V = mesh.position.constructor;
    const plane = { normal: new V(0, 0, 1), constant: 0, distanceToPoint(p) { return this.normal.dot(p) + this.constant; } };
    const at = (p) => { const w = window.viewport.screenToPlane(p.x, p.y, plane); return [w.x, w.y]; };
    return [at(a), at(b)];
  }, { a, b });
  const before = { at: [0, 0], width: 100 };
  const uOf = (x) => (x - before.at[0]) / before.width + 0.5;
  const ua = uOf(landed[0][0]);
  const ub = uOf(landed[1][0]);
  const wa = world(q, ua, 0.5);
  const wb = world(q, ub, 0.5);
  check("the two picked image points are 100 mm apart", near(Math.hypot(wb[0] - wa[0], wb[1] - wa[1]), 100, 0.01), String(Math.hypot(wb[0] - wa[0], wb[1] - wa[1])));
  check("the first picked point did not move", near(wa[0], landed[0][0], 0.01) && near(wa[1], landed[0][1], 0.01), JSON.stringify([wa, landed[0]]));
  check("width and height in the entry follow", near(cal.width, q.sx, 1e-6), `${cal.width}`);

  if (process.env.SC_SHOT) await page.screenshot({ path: process.env.SC_SHOT });

  console.log("3. save and reopen");
  const text = await page.evaluate(() => window.store.toJSON());
  check("the file carries the list", JSON.parse(text).referenceImages?.length === 1);
  await page.evaluate((t) => { window.store.newDocument(); window.store.load(t); }, text);
  await page.waitForFunction(() => {
    let ok = false;
    window.viewport.scene.scene.traverse((o) => { if (o.userData.referenceImage && o.material.map) ok = true; });
    return ok;
  }, null, { timeout: 10000 }).catch(() => {});
  const back = await quad();
  check("the quad is back, textured, at the same size", back && back.textured && near(back.sx, q.sx, 1e-6) && near(back.sy, q.sy, 1e-6), back && `${back.sx} x ${back.sy}`);

  console.log("4. pictures and exports");
  check("the built document holds no image", await page.evaluate(() => !("referenceImages" in window.store.document)));
  const shots = await page.evaluate(() => {
    const plain = window.viewport.renderStill(1, { realtime: true });
    const withRefs = window.viewport.renderStill(1, { realtime: true, references: true });
    const list = window.store.referenceImages().map((r) => ({ ...r, hidden: true }));
    window.store.setReferenceImages(list);
    const hidden = window.viewport.renderStill(1, { realtime: true, references: true });
    return { plain, withRefs, hidden };
  });
  check("a picture leaves the image out by default", shots.plain === shots.hidden, `${shots.plain.length} vs ${shots.hidden.length}`);
  check("with the switch on the image is in it", shots.withRefs !== shots.plain);

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
