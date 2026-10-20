// Ridges contributed across a body, in a real browser with a real WebGL renderer.
//
// The unit tests pin the profile, the uniforms and the program key. This measures
// the picture: a 20 mm cube seen square on, ridges switched on through the Printed
// look plugin's settings, every still decoded in the page. The ridge period has to match the pitch
// in pixels, the face across the axis has to stay quiet, far away the face must
// neither shimmer nor change brightness (the fade and the roughness fold), and no
// pitch change, motion start or motion stop may link a new program.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_URL=http://localhost:5173/] [SC_ENGINE_PORT=8765] \
//     node e2e/relief_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "relief_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const PITCH = 0.3;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const shaderErrors = [];
    page.on("console", (m) => { if (/Shader Error|Program Info Log|WebGL: INVALID/i.test(m.text())) shaderErrors.push(m.text().slice(0, 400)); });
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
    await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) { await modal.click(); await page.waitForTimeout(300); }

    const built = await page.evaluate(async () => {
      window.store.addFeature({ id: window.store.nextId(), type: "box", length: 20, width: 20, height: 20 });
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const b = window.store.buildState;
        if (!b.building && b.result?.bodies?.length >= 1) return true;
      }
      return false;
    });
    check("box built", built);

    // Helpers live in the page: view setup, stills decoded to luminance, regions.
    await page.evaluate(() => {
      const v = window.viewport;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__r = {
        async view(side, zoomOut = 1) {
          v.setProjection("ortho");
          v.setStandardView(side);
          await wait(900);
          const cam = v.rig.active;
          if (zoomOut !== 1) { cam.zoom /= zoomOut; cam.updateProjectionMatrix(); v.requestRender(); }
          await raf(); await raf(); await wait(200);
        },
        async relief(r) {
          const m = await import("/src/plugins/settings.ts");
          let s = m.pluginSettingsOf("FundaCAD.PrintLook");
          for (let i = 0; !s && i < 50; i++) { await wait(100); s = m.pluginSettingsOf("FundaCAD.PrintLook"); }
          if (!r) { s.set("layerLines", false); return; }
          const dir = { "0,0,1": "+Z", "0,0,-1": "-Z", "1,0,0": "+X", "-1,0,0": "-X", "0,1,0": "+Y", "0,-1,0": "-Y" }[r.axis.join(",")];
          s.set("direction", dir);
          s.set("layerHeight", r.pitch);
          s.set("depth", r.depth);
          s.set("variation", r.tintJitter ?? 0);
          s.set("grooveShading", r.cavity ?? 0);
          s.set("layerLines", true);
        },
        async settle() { for (let i = 0; i < 60; i++) { v.requestRender(); await raf(); } await wait(300); },
        async still(name) {
          const url = v.renderStill(1, { realtime: true });
          const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
          const c = document.createElement("canvas");
          c.width = img.width; c.height = img.height;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          const cam = v.rig.active;
          const mmPerPx = (cam.top - cam.bottom) / cam.zoom / img.height;
          const toPx = (x, y, z) => {
            const p = new window.__THREE_V3(x, y, z).project(cam);
            return [(p.x + 1) / 2 * img.width, (1 - p.y) / 2 * img.height];
          };
          window.__shots = window.__shots || {};
          window.__shots[name] = url;
          return { w: img.width, h: img.height, d, mmPerPx, toPx };
        },
      };
      window.__lum = (s, x, y) => {
        const i = (Math.round(y) * s.w + Math.round(x)) * 4;
        return 0.2126 * s.d[i] + 0.7152 * s.d[i + 1] + 0.0722 * s.d[i + 2];
      };
      window.__stats = (vals) => {
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        return { mean: m, sd: Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length) };
      };
      // The dominant period of a profile, by autocorrelation of its mean removed values.
      window.__period = (vals, lo, hi) => {
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        const x = vals.map((a) => a - m);
        let best = 0, bestLag = 0;
        const ac = [];
        for (let lag = lo; lag <= hi; lag++) {
          let s = 0;
          for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
          s /= x.length - lag;
          ac.push(s);
          if (s > best) { best = s; bestLag = lag; }
        }
        // Parabolic peak refinement for a sub pixel period.
        const k = bestLag - lo;
        if (k > 0 && k < ac.length - 1) {
          const a = ac[k - 1], b = ac[k], c = ac[k + 1];
          const den = a - 2 * b + c;
          if (den !== 0) return bestLag + 0.5 * (a - c) / den;
        }
        return bestLag;
      };
    });
    // The app's own Vector3, taken off the camera.
    await page.evaluate(() => { window.__THREE_V3 = window.viewport.rig.active.position.constructor; });

    // A face region in pixels: the cube face at the given fixed coordinate.
    const measure = (name, side) => page.evaluate(async ([name, side]) => {
      const s = await window.__r.still(name);
      const L = (x, y) => window.__lum(s, x, y);
      let colA, colB, region;
      if (side === "front") {
        colA = s.toPx(0, -10, -8); colB = s.toPx(0, -10, 8);
        const a = s.toPx(-6, -10, -6), b = s.toPx(6, -10, 6);
        region = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      } else {
        colA = s.toPx(0, -8, 10); colB = s.toPx(0, 8, 10);
        const a = s.toPx(-6, -6, 10), b = s.toPx(6, 6, 10);
        region = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      }
      const col = [];
      const y0 = Math.min(colA[1], colB[1]), y1 = Math.max(colA[1], colB[1]);
      for (let y = Math.ceil(y0); y <= Math.floor(y1); y++) col.push(L(colA[0], y));
      const all = [];
      let black = 0, n = 0;
      for (let y = Math.ceil(region[1]); y <= Math.floor(region[3]); y++) {
        for (let x = Math.ceil(region[0]); x <= Math.floor(region[2]); x++) {
          const i = (y * s.w + x) * 4;
          if (s.d[i] === 0 && s.d[i + 1] === 0 && s.d[i + 2] === 0) black++;
          n++;
          all.push(L(x, y));
        }
      }
      const st = window.__stats(all);
      const cs = window.__stats(col);
      return { mmPerPx: s.mmPerPx, colLen: col.length, col, colSd: cs.sd, mean: st.mean, sd: st.sd, black, n,
        regionPx: region.map((v) => Math.round(v)) };
    }, [name, side]);

    const programs = () => page.evaluate(() => window.viewport.scene.renderer.info.programs.length);
    const save = async (name) => {
      const b64 = await page.evaluate((n) => window.__shots[n].slice(window.__shots[n].indexOf(",") + 1), name);
      fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(b64, "base64"));
    };
    const short = (m) => ({ mmPerPx: +m.mmPerPx.toFixed(4), mean: +m.mean.toFixed(2), sd: +m.sd.toFixed(2), colSd: +m.colSd.toFixed(2), black: m.black, n: m.n });

    // --- near, square on to a side wall ----------------------------------------
    await page.evaluate(() => window.__r.view("front"));
    await page.evaluate(() => window.__r.settle());
    const offNear = await measure("front-off", "front");
    await save("front-off");
    const progOff = await programs();

    const relief = { axis: [0, 0, 1], pitch: PITCH, depth: 0.35, cavity: 0.4, tintJitter: 0 };
    await page.evaluate((r) => window.__r.relief(r), relief);
    await page.evaluate(() => window.__r.settle());
    const near = await measure("front-on", "front");
    await save("front-on");
    const progOn = await programs();
    const want = PITCH / near.mmPerPx;
    const got = await page.evaluate(([col, lo, hi]) => window.__period(col, lo, hi), [near.col, Math.max(2, Math.floor(want * 0.5)), Math.ceil(want * 1.6)]);
    check("the ridges show on the wall", near.colSd > offNear.colSd + 3, { off: short(offNear), on: short(near) });
    check("the ridge period is the pitch in pixels within 1 px", Math.abs(got - want) <= 1, { want: +want.toFixed(2), got: +got.toFixed(2) });
    check("no black pixels on the wall", near.black === 0, near.black);

    // --- a pitch change and a motion start and stop link nothing -----------------
    await page.evaluate((r) => window.__r.relief({ ...r, pitch: 0.2, depth: 0.5 }), relief);
    await page.evaluate(() => window.__r.settle());
    const progPitch = await programs();
    check("a pitch change links no program", progPitch === progOn, { before: progOn, after: progPitch, off: progOff });
    const cv = await page.evaluate(() => { const r = window.viewport.scene.renderer.domElement.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await page.mouse.move(cv[0] + 200, cv[1] + 200);
    await page.mouse.down({ button: "middle" });
    for (let i = 0; i < 12; i++) { await page.mouse.move(cv[0] + 200 + i * 6, cv[1] + 200 + i * 3); await page.waitForTimeout(30); }
    const progMoving = await programs();
    await page.mouse.up({ button: "middle" });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__r.settle());
    const progStill = await programs();
    check("a motion start and stop link no program", progMoving === progOn && progStill === progOn, { on: progOn, moving: progMoving, still: progStill });
    await page.evaluate((r) => window.__r.relief(r), relief);

    // --- the face across the axis stays quiet -------------------------------------
    await page.evaluate(() => window.__r.view("top"));
    await page.evaluate(() => window.__r.relief(null));
    await page.evaluate(() => window.__r.settle());
    const topOff = await measure("top-off", "top");
    await page.evaluate((r) => window.__r.relief(r), relief);
    await page.evaluate(() => window.__r.settle());
    const topOn = await measure("top-on", "top");
    await save("top-on");
    check("the top face stays quiet", topOn.sd < topOff.sd + 1 && Math.abs(topOn.mean - topOff.mean) < 2, { off: short(topOff), on: short(topOn) });

    // --- far away: no shimmer, same brightness -------------------------------------
    const farZoom = (PITCH / near.mmPerPx) / 0.3;
    await page.evaluate((z) => window.__r.view("front", z), farZoom);
    await page.evaluate(() => window.__r.settle());
    const far = await measure("front-far", "front");
    await save("front-far");
    await page.evaluate(() => window.__r.relief(null));
    await page.evaluate(() => window.__r.settle());
    const farOff = await measure("front-far-off", "front");
    await page.evaluate((r) => window.__r.relief(r), relief);
    const pxPerLayer = PITCH / far.mmPerPx;
    const ratio = far.mean / near.mean;
    check("far away the wall shows no moire", far.sd < farOff.sd + 2.5, { pxPerLayer: +pxPerLayer.toFixed(2), on: short(far), off: short(farOff) });
    check("far and near mean luminance within 6 percent", Math.abs(ratio - 1) <= 0.06, { near: +near.mean.toFixed(2), far: +far.mean.toFixed(2), ratio: +ratio.toFixed(4) });
    check("no black pixels far away", far.black === 0, far.black);

    // --- frame time, relief on and off --------------------------------------------
    await page.evaluate(() => window.__r.view("front"));
    const frames = (on) => page.evaluate(async ([on, r]) => {
      await window.__r.relief(on ? r : null);
      await window.__r.settle();
      const v = window.viewport, gl = v.scene.renderer.getContext(), px = new Uint8Array(4);
      const raf = () => new Promise((res) => requestAnimationFrame(res));
      const t0 = performance.now();
      for (let i = 0; i < 120; i++) { v.requestRender(); await raf(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      return (performance.now() - t0) / 120;
    }, [on, relief]);
    const msOff = await frames(false);
    const msOn = await frames(true);
    console.log(`  frame time over 120 forced renders: relief off ${msOff.toFixed(2)} ms, on ${msOn.toFixed(2)} ms`);

    check("no shader errors", shaderErrors.length === 0, shaderErrors.slice(0, 2).join(" | "));
    fs.writeFileSync(path.join(OUT, "relief.json"), JSON.stringify({
      want, got, near: short(near), offNear: short(offNear), topOff: short(topOff), topOn: short(topOn),
      far: short(far), farOff: short(farOff), pxPerLayer, ratio, programs: { off: progOff, on: progOn, pitch: progPitch, moving: progMoving, still: progStill },
      msOff, msOn,
    }, null, 1));
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
