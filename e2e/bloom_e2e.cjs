// Bloom in a real browser on a real GPU: turning it on must not change the
// background or the glass, and with performance mode off it must stay on while
// the camera moves, also on the reduced motion level a slow machine drops to.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome exe> [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_ANGLE=d3d11] node e2e/bloom_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const ANGLE = process.env.SC_ANGLE || "d3d11";
const OUT = path.resolve(process.argv[2] || "bloom_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const maxDelta = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: [`--use-angle=${ANGLE}`, "--enable-gpu", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
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
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) { await modal.click(); await page.waitForTimeout(300); }
    const gpu = await page.evaluate(() => {
      const gl = window.viewport.scene.renderer.getContext();
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    check("renderer is a GPU, not SwiftShader", !/swiftshader/i.test(gpu), gpu);

    // Every drawn frame, and whether it went through the composer.
    await page.evaluate(() => {
      const post = window.viewport.scene.post;
      const plain = post.render.bind(post);
      window.__frames = [];
      post.render = (cam, motion) => {
        let composed = false;
        const c = post.composer;
        const spy = c && c.render;
        if (c) c.render = (...a) => { composed = true; return spy.apply(c, a); };
        try { plain(cam, motion); } finally { if (c) c.render = spy; }
        window.__frames.push({ motion: !!motion, composed: composed || (!c && !!post.composer) });
      };
    });

    // A glass box with a square hole and a glass rod standing in it.
    await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "box", length: 60, width: 60, height: 40 });
      s.addFeature({ id: s.nextId(), type: "box", length: 16, width: 16, height: 60 });
      s.addFeature({ id: s.nextId(), type: "boolean", operation: "cut", target: "body1", tools: ["body2"] });
      s.addFeature({ id: s.nextId(), type: "cylinder", radius: 6, height: 100 });
      s.addFeature({ id: s.nextId(), type: "move", bodies: ["body3"], dx: 0, dy: 0, dz: 30, rx: 0, ry: 0, rz: 0 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await page.evaluate(() => window.__fundacad.handleAction("iso"));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.store.setBodiesMaterial(["body1", "body3"], "m-glass"));
    await page.waitForTimeout(800);

    const setPref = (k, v) => page.evaluate(async ([k, v]) => {
      (await import("/src/ui/renderPrefs.ts")).setRenderPref(k, v);
    }, [k, v]);
    const settle = () => page.evaluate(async () => {
      window.viewport.requestRender();
      await new Promise((r) => setTimeout(r, 800));
    });
    // Mean colour of each [x0, y0, x1, y1] box of a screenshot, or the per channel median with "median".
    const measure = (png, boxes, how = "mean") => page.evaluate(async ([b64, boxes, how]) => {
      const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
      const c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      return boxes.map(([x0, y0, x1, y1]) => {
        const d = x.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        const ch = [[], [], []];
        for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) ch[k].push(d[i + k]);
        return ch.map((v) => {
          if (how === "median") { v.sort((a, b) => a - b); return v[v.length >> 1]; }
          return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10;
        });
      });
    }, [png.toString("base64"), boxes, how]);
    const shot = async (name) => {
      const buf = await page.screenshot();
      fs.writeFileSync(path.join(OUT, name + ".png"), buf);
      return buf;
    };
    // bg is a patch of ground right of the model at 1200 x 800, far enough that the
    // glow of the rod's top at bloom 1 does not reach it, its median steps over the grid lines.
    const glassBoxes = () => page.evaluate(() => {
      const v = window.viewport, cam = v.rig.active, r = v.scene.renderer.domElement.getBoundingClientRect();
      const P = (x, y, z) => {
        const p = new (v.scene.scene.position.constructor)(x, y, z).project(cam);
        return [Math.round(r.left + ((p.x + 1) / 2) * r.width), Math.round(r.top + ((1 - p.y) / 2) * r.height)];
      };
      const sq = ([x, y], h) => [x - h, y - h, x + h, y + h];
      return { rod: sq(P(0, 0, 55), 3), box: sq(P(22, -22, 20), 8), bg: [940, 600, 1040, 680], ground: [300, 420, 400, 560] };
    });

    const setTheme = (id) => page.evaluate(async (id) => {
      (await import("/src/ui/theme.ts")).setTheme(id);
    }, id);
    // 1. The background and the glass, bloom off and on, for each ground, at the
    // default amount and at the top of the slider, where the threshold is lowest.
    const grounds = [["theme"], ["dark"], ["grey"], ["light"], ["theme", "solarized-light"]];
    for (const [bg, theme] of grounds) for (const amount of [0.4, 1]) {
      const ground = theme ? `${bg}_${theme}` : bg;
      if (theme) await setTheme(theme);
      await setPref("background", bg);
      await setPref("bloom", 0);
      await settle();
      const at = await glassBoxes();
      const off = await shot(`bg_${ground}_bloom0`);
      const directOn = await page.evaluate(() => window.__frames.at(-1).composed);
      await setPref("bloom", amount);
      await settle();
      const on = await shot(`bg_${ground}_bloom${amount}`);
      const composerOn = await page.evaluate(() => window.__frames.at(-1).composed);
      check(`${ground}: bloom 0 draws direct, ${amount} through the composer`, !directOn && composerOn, `composed ${directOn} then ${composerOn}`);
      const [bgOff] = await measure(off, [at.bg], "median");
      const [bgOn] = await measure(on, [at.bg], "median");
      check(`${ground}: background identical with bloom ${amount}`, maxDelta(bgOff, bgOn) <= 1, `${bgOff} vs ${bgOn}`);
      const [gridOff] = await measure(off, [at.ground], "mean");
      const [gridOn] = await measure(on, [at.ground], "mean");
      check(`${ground}: grid lines identical with bloom ${amount}`, maxDelta(gridOff, gridOn) <= 1.5, `mean ${gridOff} vs ${gridOn}`);
      const [rodOff, boxOff] = await measure(off, [at.rod, at.box]);
      const [rodOn, boxOn] = await measure(on, [at.rod, at.box]);
      console.log(`    ${ground} at ${amount}: rod ${rodOff} -> ${rodOn}, box face ${boxOff} -> ${boxOn}`);
      check(`${ground}: glass box face keeps its colour with bloom on`, maxDelta(boxOff, boxOn) <= 4, `${boxOff} vs ${boxOn}`);
      if (theme) await setTheme("fundacad");
    }
    await setPref("background", "theme");

    // 2. An orbit on the reduced motion level a slow machine drops to.
    const orbit = async (name) => {
      await page.evaluate(() => {
        const m = window.viewport.motion;
        m.lvl = 1; m.maxLevel = 1; m.slowUntil = 1e15; m.probe = () => false; m.mayRise = () => false;
        window.__frames.length = 0;
      });
      const cx = 600, cy = 400;
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button: "right" });
      for (let i = 1; i <= 30; i++) {
        await page.mouse.move(cx + i * 6, cy + i);
        await page.waitForTimeout(16);
        if (i % 10 === 0) await shot(`${name}_mid${i}`);
      }
      await page.waitForTimeout(16);
      const last = await shot(`${name}_last`);
      const at = await glassBoxes();
      await page.mouse.up({ button: "right" });
      await page.waitForTimeout(1500);
      const rest = await shot(`${name}_rest`);
      const frames = await page.evaluate(() => window.__frames.slice());
      return { last, rest, at, frames };
    };
    await setPref("bloom", 0.4);
    await settle();
    const live = await orbit("orbit_perf_off");
    const motion = live.frames.filter((f) => f.motion);
    check("performance mode off: motion level 1 is in effect", motion.length > 5, `${motion.length} motion frames of ${live.frames.length}`);
    check("performance mode off: every orbit frame goes through the composer", motion.length > 0 && motion.every((f) => f.composed), `${motion.filter((f) => f.composed).length}/${motion.length}`);
    const [bgRest, rodRest, boxRest] = await measure(live.rest, [live.at.bg, live.at.rod, live.at.box], "median");
    const [bgLast, rodLast, boxLast] = await measure(live.last, [live.at.bg, live.at.rod, live.at.box], "median");
    check("background the same while orbiting and at rest", maxDelta(bgLast, bgRest) <= 1, `${bgLast} vs ${bgRest}`);
    check("glass the same while orbiting and at rest (no white frames)", maxDelta(rodLast, rodRest) <= 12 && maxDelta(boxLast, boxRest) <= 6, `rod ${rodLast} vs ${rodRest}, box ${boxLast} vs ${boxRest}`);

    await setPref("performanceMode", true);
    await settle();
    const perf = await orbit("orbit_perf_on");
    const perfMotion = perf.frames.filter((f) => f.motion);
    check("performance mode on: orbit frames may skip the passes", perfMotion.length > 0 && perfMotion.every((f) => !f.composed), `${perfMotion.filter((f) => !f.composed).length}/${perfMotion.length} without`);
    await setPref("performanceMode", false);
    await settle();

    // 3. Nested glass, for a human look.
    await setPref("bloom", 0);
    await settle();
    await shot("nested_glass_bloom0");
    await setPref("bloom", 0.4);
    await settle();
    await shot("nested_glass_bloom04");
    await setPref("bloom", 0.4);
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
