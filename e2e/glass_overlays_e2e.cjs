// Glass shows bodies through it, never the viewport's helpers. A diamond slab
// (IOR 2.42) stands in front of a selected box with the move gizmo on it. One
// frame is instrumented to list what three draws into the transmission target
// glass refracts, and in which order helpers and glass reach the screen. Then
// the gizmo's pixels are compared with the same frame where the slab is opaque:
// a refracted gizmo is drawn off its hit area, a gizmo on top of glass is not.
//
// Needs a GPU browser: a software rasteriser drops glass to flat alpha, which
// has no transmission pass and so shows nothing.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<token> SC_CHROME=<chrome.exe> node e2e/glass_overlays_e2e.cjs
// Optional: SC_URL (default http://localhost:5173/), SC_ENGINE_PORT to reach an
// engine on another port than 8765, SC_OUT for the screenshots, SC_TAG.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.env.SC_OUT || "/tmp/glass_overlays_shots");
const TAG = process.env.SC_TAG || "after";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.SC_CHROME || "/usr/bin/chromium",
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  await page.addInitScript(([port, t]) => {
    const N = window.WebSocket;
    window.WebSocket = class extends N {
      constructor(u, p) {
        const s = String(u).replace("127.0.0.1:8765", "127.0.0.1:" + port).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    };
  }, [PORT, TOKEN]);
  await page.goto(URL);
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }

  const built = await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: s.nextId(), type: "box", length: 20, width: 20, height: 20 });
    s.addFeature({ id: s.nextId(), type: "box", length: 60, width: 4, height: 60 });
    s.addFeature({ id: s.nextId(), type: "move", bodies: ["body2"], dx: 0, dy: -25, dz: 0, rx: 0, ry: 0, rz: 35 });
    s.addFeature({ id: s.nextId(), type: "box", length: 140, width: 2, height: 100 });
    s.addFeature({ id: s.nextId(), type: "move", bodies: ["body3"], dx: 0, dy: 40, dz: 0, rx: 0, ry: 0, rz: 0 });
    await s.rebuildNow();
    for (let i = 0; i < 300; i++) {
      const b = s.buildState;
      if (!b.building && b.result?.bodies?.length >= 3) return b.result.bodies.length;
      await new Promise((r) => setTimeout(r, 100));
    }
    return s.buildState.result?.bodies?.length ?? 0;
  });
  check("three bodies built", built === 3, `got ${built}`);
  await page.evaluate(() => {
    const s = window.store;
    s.setBodiesMaterial(["body3"], s.addMaterial({ name: "wall", color: "#e8e8e8" }));
    s.setBodiesMaterial(["body1"], s.addMaterial({ name: "red", color: "#c03030" }));
    s.setBodiesMaterial(["body2"], "m-glass");
    s.updateMaterial("m-glass", { ior: 2.42, thickness: 4 });
  });
  await page.evaluate(() => window.__fundacad.handleAction("front"));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.viewport.setSelectedBodies(["body1"]);
    window.__fundacad.handleAction("move");
  });
  await page.waitForTimeout(800);

  const report = await page.evaluate(async () => {
    const vp = window.viewport;
    const r = vp.scene.renderer, scene = vp.scene.scene;
    const bodies = new Set(vp.bodyMeshes.map((b) => b.mesh));
    const glass = vp.bodyMeshes.find((b) => b.id === "body2").mesh;
    const log = [];
    const undo = [];
    let frame = 0;
    scene.traverse((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
      const id = `${o.parent?.name || o.parent?.type}/${o.name || o.type}`;
      const orig = o.onBeforeRender;
      o.onBeforeRender = function (rr, ...rest) {
        // Only the transmission target generates mipmaps, which tells it apart.
        if (frame === 1) log.push({ id, body: bodies.has(o), glass: o === glass, offscreen: !!rr.getRenderTarget()?.texture?.generateMipmaps });
        return orig.call(this, rr, ...rest);
      };
      undo.push(() => { o.onBeforeRender = orig; });
    });
    const R0 = r.render;
    r.render = function (...a) { frame++; return R0.apply(this, a); };
    vp.requestRender();
    await new Promise((res) => setTimeout(res, 600));
    r.render = R0;
    undo.forEach((u) => u());
    const main = log.filter((e) => !e.offscreen);
    const glassAt = main.findIndex((e) => e.glass);
    return {
      helpersOffscreen: [...new Set(log.filter((e) => e.offscreen && !e.body).map((e) => e.id))],
      bodiesOffscreen: log.filter((e) => e.offscreen && e.body).length,
      glassDrawn: glassAt >= 0,
      helpersBeforeGlass: [...new Set(main.slice(0, Math.max(0, glassAt)).filter((e) => !e.body).map((e) => e.id))],
    };
  });
  fs.writeFileSync(path.join(OUT, `${TAG}_report.json`), JSON.stringify(report, null, 1));
  check("the glass is drawn with a transmission pass", report.glassDrawn && report.bodiesOffscreen > 0);
  check("no helper is drawn into what glass refracts", report.helpersOffscreen.length === 0, report.helpersOffscreen.join(" "));
  check("no helper is drawn before the glass", report.helpersBeforeGlass.length === 0, report.helpersBeforeGlass.join(" "));

  // Where the scale cubes and arrow heads truly are, on screen.
  const marks = await page.evaluate(() => {
    const vp = window.viewport, cam = vp.rig.active;
    const cv = vp.scene.renderer.domElement.getBoundingClientRect();
    const out = [];
    vp.scene.scene.traverse((o) => {
      const kind = o.geometry?.type;
      if (!o.isMesh || o.renderOrder !== 999 || (kind !== "ConeGeometry" && kind !== "BoxGeometry")) return;
      const p = new o.position.constructor();
      o.getWorldPosition(p).project(cam);
      out.push({ kind, color: o.material.color.getHexString(), x: Math.round(cv.left + (p.x + 1) / 2 * cv.width), y: Math.round(cv.top + (1 - p.y) / 2 * cv.height) });
    });
    return out;
  });
  // Centroid of pixels where the handle's dominant channel stands out, robust
  // to the glass tint. The green handles face the camera in Front view.
  const centroids = async (png) => page.evaluate(async ([b64, ms]) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return ms.map((m) => {
      const ch = m.color.startsWith("ff") ? 0 : 2;
      const r = 22, d = g.getImageData(m.x - r, m.y - r, 2 * r, 2 * r).data;
      let n = 0, sx = 0, sy = 0;
      for (let i = 0; i < d.length; i += 4) {
        const o = [0, 1, 2].filter((k) => k !== ch).map((k) => d[i + k]);
        if (d[i + ch] - (o[0] + o[1]) / 2 > 35) { n++; sx += (i / 4) % (2 * r); sy += Math.floor(i / 4 / (2 * r)); }
      }
      return { ...m, n, cx: n ? m.x - r + sx / n : null, cy: n ? m.y - r + sy / n : null };
    });
  }, [png.toString("base64"), marks.filter((m) => !m.color.startsWith("5ad1"))]);

  const withGlass = await page.screenshot({ path: path.join(OUT, `${TAG}_selected_gizmo.png`) });
  await page.evaluate(() => { const s = window.store; s.setBodiesMaterial(["body2"], s.addMaterial({ name: "plain", color: "#8899aa" })); });
  await page.waitForTimeout(800);
  await page.evaluate(async () => { window.viewport.requestRender(); await new Promise((r) => setTimeout(r, 500)); });
  const opaque = await page.screenshot({ path: path.join(OUT, `${TAG}_noglass.png`) });
  const a = await centroids(withGlass), b = await centroids(opaque);
  fs.writeFileSync(path.join(OUT, `${TAG}_marks.json`), JSON.stringify({ glass: a, opaque: b }, null, 1));
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = b[i];
    const off = p.cx === null || q.cx === null ? Infinity : Math.hypot(p.cx - q.cx, p.cy - q.cy);
    check(`${p.kind} #${p.color} is drawn where it is under glass as without`, off <= 1 && Math.abs(p.n - q.n) <= q.n * 0.1,
      `${off.toFixed(1)} px off, ${p.n} vs ${q.n} px`);
  }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
