// Bloom spills only from glowing faces: a lit white body next to a glowing one
// must not halo, on every ground and theme, while the glowing body keeps its glow.
// The white body's surroundings are measured against the same body painted black,
// which cannot bloom, so what both share is the glowing neighbour's far field.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome exe> [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_ANGLE=d3d11] node e2e/bloom_halo_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const ANGLE = process.env.SC_ANGLE || "d3d11";
const OUT = path.resolve(process.argv[2] || "bloom_halo_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

const inPage = () => {
  const v = window.viewport;
  const V3 = v.scene.scene.position.constructor;
  window.__rects = () => {
    const cam = v.rig.active, r = v.scene.renderer.domElement.getBoundingClientRect();
    return Object.fromEntries(v.bodyMeshes.map((b) => {
      const g = b.mesh.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox.clone().applyMatrix4(b.mesh.matrixWorld);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
        const p = new V3(x, y, z).project(cam);
        const sx = r.left + ((p.x + 1) / 2) * r.width, sy = r.top + ((1 - p.y) / 2) * r.height;
        x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
      }
      return [b.id, [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)]];
    }));
  };
  // Texels the bright pass let through over each rect, read right after the bloom pass of one frame.
  window.__bright = (rects) => new Promise((resolve) => {
    const post = v.scene.post, bloom = post.bloom;
    if (!bloom || !bloom.enabled) return resolve(null);
    const wrapped = bloom.render;
    bloom.render = function (...args) {
      bloom.render = wrapped;
      wrapped.apply(this, args);
      const t = bloom.renderTargetBright, w = t.width, h = t.height;
      const buf = new Uint16Array(w * h * 4);
      v.scene.renderer.readRenderTargetPixels(t, 0, 0, w, h, buf);
      const cr = v.scene.renderer.domElement.getBoundingClientRect();
      const count = (rect) => {
        const sx = w / cr.width, sy = h / cr.height;
        let n = 0;
        for (let Y = Math.max(0, Math.floor((rect[1] - cr.top) * sy)); Y < Math.min(h, Math.ceil((rect[3] - cr.top) * sy)); Y++) {
          for (let X = Math.max(0, Math.floor((rect[0] - cr.left) * sx)); X < Math.min(w, Math.ceil((rect[2] - cr.left) * sx)); X++) {
            const i = ((h - 1 - Y) * w + X) * 4;
            if ((buf[i] & 0x7fff) || (buf[i + 1] & 0x7fff) || (buf[i + 2] & 0x7fff)) n++;
          }
        }
        return n;
      };
      resolve(Object.fromEntries(Object.entries(rects).map(([id, r]) => [id, count(r)])));
    };
    v.requestRender();
    setTimeout(() => resolve("no frame"), 4000);
  });
  // The band 3 to 18 px outside a rect, mean and max luma rise from one PNG to another.
  window.__ring = async (b64a, b64b, rect) => {
    const load = async (b64) => {
      const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
      const c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, img.width, img.height);
    };
    const A = await load(b64a), B = await load(b64b);
    const L = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const inR = (x, y, e) => x >= rect[0] - e && x < rect[2] + e && y >= rect[1] - e && y < rect[3] + e;
    let n = 0, sum = 0, max = 0;
    for (let y = Math.max(0, rect[1] - 18); y < Math.min(A.height, rect[3] + 18); y++) {
      for (let x = Math.max(0, rect[0] - 18); x < Math.min(A.width, rect[2] + 18); x++) {
        if (inR(x, y, 3)) continue;
        const i = (y * A.width + x) * 4, d = L(B.data, i) - L(A.data, i);
        n++; sum += d; max = Math.max(max, d);
      }
    }
    return { mean: Math.round((sum / n) * 10) / 10, max: Math.round(max) };
  };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: [`--use-angle=${ANGLE}`, "--enable-gpu", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
    page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
    await page.addInitScript(([port, t]) => {
      const N = window.WebSocket;
      window.WebSocket = class extends N {
        constructor(u, p) {
          let s = String(u).replace("127.0.0.1:8765", "127.0.0.1:" + port);
          s = s.replace(/([?&])token=[^&]*/, `$1token=${t}`);
          super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
        }
      };
    }, [PORT, TOKEN]);
    await page.goto(URL);
    await page.waitForFunction(() => !!window.store && !!window.viewport && window.geometry?.connected, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) { await modal.click(); await page.waitForTimeout(300); }
    const gpu = await page.evaluate(() => {
      const gl = window.viewport.scene.renderer.getContext();
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    check("renderer is a GPU, not SwiftShader", !/swiftshader/i.test(gpu), gpu);

    await page.evaluate(async () => {
      const s = window.store;
      const settled = async (n) => {
        for (let i = 0; i < 300; i++) {
          const b = s.buildState;
          if (!b.building && (b.result?.bodies?.length ?? 0) >= n) return;
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      s.addFeature({ id: s.nextId(), type: "box", length: 18, width: 18, height: 18 });
      s.addFeature({ id: s.nextId(), type: "box", length: 18, width: 18, height: 18 });
      await s.rebuildNow();
      await settled(2);
      s.addFeature({ id: s.nextId(), type: "move", bodies: ["body2"], dx: 70, dy: -23, dz: 6, rx: 0, ry: 0, rz: 17 });
      await s.rebuildNow();
      await settled(2);
      window.__mats = {
        W: s.addMaterialPreset({ id: "w", name: "white", color: "#ffffff", metalness: 0, roughness: 0.6 }),
        K: s.addMaterialPreset({ id: "k", name: "black", color: "#000000", metalness: 0, roughness: 1 }),
        G: s.addMaterialPreset({ id: "g", name: "glow", color: "#d9f2b4", metalness: 0, roughness: 0.6, emissive: 0.35, castsLight: false }),
      };
      s.setBodiesMaterial(["body1"], window.__mats.W);
      s.setBodiesMaterial(["body2"], window.__mats.G);
    });
    await page.evaluate(() => window.__fundacad.handleAction("iso"));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(1200);
    await page.mouse.move(5, 5);
    await page.evaluate(inPage);

    const setPref = (k, v) => page.evaluate(async ([k, v]) => (await import("/src/ui/renderPrefs.ts")).setRenderPref(k, v), [k, v]);
    const setTheme = (id) => page.evaluate(async (id) => (await import("/src/ui/theme.ts")).setTheme(id), id);
    const paint = (m) => page.evaluate((m) => window.store.setBodiesMaterial(["body1"], window.__mats[m]), m);
    const settle = () => page.evaluate(async () => { window.viewport.requestRender(); await new Promise((r) => setTimeout(r, 900)); });
    const shot = async (n) => { const b = await page.screenshot(); fs.writeFileSync(path.join(OUT, n + ".png"), b); return b.toString("base64"); };
    const ring = (a, b, rect) => page.evaluate(([a, b, r]) => window.__ring(a, b, r), [a, b, rect]);

    for (const [ground, theme] of [["theme", "fundacad"], ["theme", "solarized-light"], ["dark", "fundacad"], ["light", "fundacad"]]) {
      await setTheme(theme);
      await setPref("background", ground);
      const tag = `${ground}/${theme}`;
      const shots = {};
      let bright = null;
      for (const m of ["W", "K"]) {
        await paint(m);
        for (const amount of [0, 0.4, 1]) {
          await setPref("bloom", amount);
          await settle();
          shots[`${m}${amount}`] = await shot(`${ground}_${theme}_${m}_bloom${amount}`);
          if (m === "W" && amount === 0.4) bright = await page.evaluate((r) => window.__bright(r), await page.evaluate(() => window.__rects()));
        }
      }
      const rects = await page.evaluate(() => window.__rects());
      for (const amount of [0.4, 1]) {
        const white = await ring(shots.W0, shots[`W${amount}`], rects.body1);
        const black = await ring(shots.K0, shots[`K${amount}`], rects.body1);
        check(`${tag}: a white body next to a glow gains no halo of its own at bloom ${amount}`,
          white.mean <= black.mean + 1.5 && white.max <= black.max + 5, `white ${JSON.stringify(white)}, black ${JSON.stringify(black)}`);
      }
      const glow = await ring(shots.W0, shots["W0.4"], rects.body2);
      check(`${tag}: the glowing body still glows at bloom 0.4`, glow.mean >= 6 && glow.max >= 80, JSON.stringify(glow));
      check(`${tag}: the bright pass lets nothing through over the white body`, bright && bright.body1 === 0 && bright.body2 > 1000, JSON.stringify(bright));
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
