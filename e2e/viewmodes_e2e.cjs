// View modes in the browser: the Matcap, Realtime, Path traced switch on the
// view bar, Z and Shift+Z, one mode per workspace kept across a reload, Matcap
// over glass, emission, clearcoat, a face paint, x-ray and a section, and the
// Path traced tooltip in and out of performance mode. Prints the Matcap and
// Realtime frame times. Wants a GPU Chrome for the timings.
//
//   engine --ws, vite, then
//   SC_TOKEN=<engine token> node e2e/viewmodes_e2e.cjs [N=64]
// SC_URL (default http://localhost:5173/), SC_ENGINE_PORT (default 8765) and
// SC_OUT (screenshot folder, default the OS temp dir) pick the setup.

const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const APP = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = process.env.SC_OUT || path.join(os.tmpdir(), "viewmodes_e2e");
const N = +(process.argv[2] || 64);
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const PERF_TIP = "To avoid crashes or unintentional freezes path tracing has been turned off. To re-enable, turn off performance mode.";

let failures = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: process.env.SC_HEADLESS === "1",
    args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
    await page.addInitScript((ws) => {
      const W = window.WebSocket;
      window.WebSocket = class extends W {
        constructor(u, p) { super(String(u).replace(":8765", `:${ws}`), p); }
      };
    }, ENGINE_PORT);
    await page.addInitScript(() => {
      window.__gpuSubmits = 0;
      window.__rafs = 0;
      const q = globalThis.GPUQueue?.prototype;
      if (q) {
        const submit = q.submit;
        q.submit = function (...a) { window.__gpuSubmits++; return submit.apply(this, a); };
      }
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => raf((t) => { window.__rafs++; cb(t); });
    });
    const open = async () => {
      await page.goto(`${APP}?token=${TOKEN}`);
      await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
      await page.waitForTimeout(1500);
      const modal = await page.$(".modal-close");
      if (modal) await modal.click();
    };
    await open();
    await page.evaluate(async () => {
      const { setRenderPref } = await import("/src/ui/renderPrefs.ts");
      setRenderPref("viewModeModel", "realtime");
      setRenderPref("viewModeRender", "realtime");
      setRenderPref("performanceMode", false);
    });

    await page.evaluate(async (N) => {
      const s = window.store, v = window.viewport;
      const side = Math.ceil(Math.sqrt(N));
      const features = [];
      for (let i = 0; i < N; i++) {
        if (i % 2) features.push({ id: `c${i}`, type: "cylinder", radius: 8, height: 20 });
        else features.push({ id: `c${i}`, type: "sphere", radius: 9 });
        features.push({ id: `m${i}`, type: "move", bodies: [`body${i + 1}`], dx: (i % side) * 25, dy: Math.floor(i / side) * 25, dz: 0, rx: 0, ry: 0, rz: 0 });
      }
      s.load(JSON.stringify({ parameters: {}, features }));
      const t0 = performance.now();
      while (s.buildState.building || v.bodyMeshes.length < N) {
        if (performance.now() - t0 > 60000) throw new Error("build timed out");
        await new Promise((r) => setTimeout(r, 300));
      }
      const ids = (off) => Array.from({ length: N }, (_, i) => i).filter((i) => i % 8 === off).map((i) => `body${i + 1}`);
      s.setBodiesMaterial(ids(0), s.addMaterial({ name: "glass", color: "#9fd8ff", opacity: 0.3, roughness: 0.05 }));
      s.setBodiesMaterial(ids(3), s.addMaterial({ name: "emit", color: "#ff7a2a", emissive: 0.8 }));
      s.setBodiesMaterial(ids(5), s.addMaterial({ name: "coat", color: "#c03040", clearcoat: 1, metalness: 0.2, roughness: 0.3 }));
      s.setFacesMaterial([0, 1].map((face) => ({ body: "body2", face })), s.addMaterial({ name: "paint", color: "#2f6bff" }));
      await new Promise((r) => setTimeout(r, 3000));
      window.__fundacad.handleAction("fit");
      await new Promise((r) => setTimeout(r, 1500));
    }, N);
    await page.mouse.move(5, 5);

    const state = () => page.evaluate(() => {
      const v = window.viewport;
      const pressed = [...document.querySelectorAll("[data-view-mode]")]
        .filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.viewMode);
      const pt = document.querySelector('[data-view-mode="pathtraced"]');
      return {
        mode: v.viewMode, post: v.scene.post.viewMode, pressed,
        ptTitle: pt?.getAttribute("title"), ptDisabled: pt?.getAttribute("aria-disabled"),
      };
    });
    const materialIds = () => page.evaluate(() => {
      window.__vmMats ??= new WeakMap();
      let n = 0;
      return window.viewport.bodyMeshes.map((b) => {
        const m = b.mesh.material;
        if (!window.__vmMats.has(m)) window.__vmMats.set(m, ++n + 1000 * Math.random());
        return [b.id, window.__vmMats.get(m), Array.isArray(m) ? m.map((x) => x.type).join("+") : m.type];
      });
    });
    const snap = () => page.evaluate(() => window.viewport.screenshotPNG());
    const shotBar = (name) => page.locator(".view-modes").screenshot({ path: path.join(OUT, name) });
    const shotView = async (name) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, name), clip: { x: 0, y: 40, width: 1400, height: 860 } });
    };

    let s = await state();
    check(s.mode === "realtime" && s.pressed.join() === "realtime", "opens on Realtime", s);
    await page.waitForFunction(() => window.viewport.renderTier.webgpu !== undefined, null, { timeout: 10000 });
    s = await state();
    check(s.ptDisabled !== "true" && s.ptTitle === "Path traced (Z)", "Path traced is offered on a WebGPU Chrome", s.ptTitle);
    const titles = await page.$$eval("[data-view-mode]", (bs) => bs.map((b) => b.getAttribute("title")));
    check(titles[0] === "Matcap (Z)" && titles[1] === "Realtime (Z)", "button titles", titles);
    await shotBar("buttons-realtime.png");
    await shotView("realtime.png");

    const before = await materialIds();
    const rt1 = await snap();

    await page.click('[data-view-mode="pathtraced"]');
    s = await state();
    check(s.mode === "pathtraced" && s.post === "pathtraced", "Path traced button", s);
    const traced = await page.waitForFunction(() => {
      const t = window.viewport.traceStatus;
      return t.samples >= 64 && t.shown ? t : null;
    }, null, { timeout: 90000, polling: 100 }).then((h) => h.jsonValue(), (e) => ({ error: String(e) }));
    check(traced.samples >= 64 && traced.shown, "Path traced reaches 64 samples and shows them", traced);
    await shotView("pathtraced-64.png");
    const capped = await page.waitForFunction(() => (window.viewport.traceStatus.state === "done" ? window.viewport.traceStatus : null), null, { timeout: 120000, polling: 200 })
      .then((h) => h.jsonValue(), (e) => ({ error: String(e) }));
    check(capped.state === "done" && capped.samples >= 256, "the tracer stops at the sample cap", capped);
    const status = () => page.evaluate(() => window.viewport.traceStatus);
    const setDenoise = (v) => page.evaluate(async (d) => (await import("/src/ui/renderPrefs.ts")).setRenderPref("denoise", d), v);
    const waitDenoised = () => page.waitForFunction(() => window.viewport.traceStatus.denoised, null, { timeout: 60000, polling: 100 })
      .then(() => status(), (e) => ({ error: String(e) }));
    const t0 = Date.now();
    const den = await waitDenoised();
    check(den.denoised === true && den.state === "done", "the final denoise lands at the cap", { ...den, ms: Date.now() - t0 });
    await shotView("pathtraced-256-denoised.png");
    await setDenoise("off");
    await page.waitForTimeout(300);
    const raw = await status();
    check(!raw.denoised && raw.samples >= 256, "denoise off shows the raw samples without tracing again", raw);
    await shotView("pathtraced-256-raw.png");
    // The tracer restarts on any camera or scene change; restart() is the same reset without moving the view.
    const at16 = async (name) => {
      await page.evaluate(() => window.viewport.trace.restart());
      const h = await page.waitForFunction(() => (window.viewport.traceStatus.samples >= 16 ? window.viewport.traceStatus : null), null, { timeout: 60000, polling: 16 });
      const st = await h.jsonValue();
      await page.screenshot({ path: path.join(OUT, name), clip: { x: 0, y: 40, width: 1400, height: 860 } });
      return st;
    };
    console.log("raw at", (await at16("pathtraced-16-raw.png")).samples, "samples");
    await setDenoise("standard");
    console.log("filtered at", (await at16("pathtraced-16-filtered.png")).samples, "samples");
    const again = await waitDenoised();
    check(again.denoised === true, "the denoise runs again after a restart", again);
    check(JSON.stringify(await materialIds()) === JSON.stringify(before), "body materials are the same objects in Path traced");

    const counters = () => page.evaluate(() => ({ submits: window.__gpuSubmits, rafs: window.__rafs }));
    await page.waitForTimeout(500);
    const c0 = await counters();
    await page.waitForTimeout(2000);
    const c1 = await counters();
    // The viewport's own loop keeps its rAF, drawing only on demand; the tracer must add no GPU work.
    check(c1.submits - c0.submits === 0, "no GPU work at the cap", { submits: c1.submits - c0.submits, rafs: c1.rafs - c0.rafs });
    const cost = await page.evaluate(() => {
      const t = window.viewport.trace.backend?.tracer;
      return { budget: t?.frameBudget, renderScale: t?.renderScale, cap: t?.maxSamples };
    });
    check(cost.renderScale === 0.75 && cost.cap === 256, "traces at three quarters of the canvas up to 256 samples", cost);
    await page.evaluate(async () => (await import("/src/ui/renderPrefs.ts")).setRenderPref("performanceMode", true));
    await page.waitForTimeout(300);
    s = await state();
    check(s.mode === "realtime" && s.ptDisabled === "true" && s.ptTitle?.startsWith(PERF_TIP), "performance mode drops Path traced to Realtime", s);
    await page.evaluate(async () => (await import("/src/ui/renderPrefs.ts")).setRenderPref("performanceMode", false));
    await page.waitForTimeout(300);
    await page.click('[data-view-mode="realtime"]');
    await page.waitForTimeout(300);
    const programsBefore = await page.evaluate(() => window.viewport.scene.renderer.info.programs.length);

    await page.click('[data-view-mode="matcap"]');
    s = await state();
    check(s.mode === "matcap" && s.post === "matcap" && s.pressed.join() === "matcap", "Matcap button", s);
    await shotBar("buttons-matcap.png");
    await shotView("matcap.png");
    check(JSON.stringify(await materialIds()) === JSON.stringify(before), "body materials are the same objects in Matcap");

    const timing = await page.evaluate(() => {
      const v = window.viewport, r = v.scene.renderer, gl = r.getContext(), px = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const time = (fn, n = 60) => {
        fn(); sync();
        const a = [];
        for (let i = 0; i < n; i++) { const t = performance.now(); fn(); sync(); a.push(performance.now() - t); }
        a.sort((x, y) => x - y);
        return { median: +a[a.length >> 1].toFixed(2), max: +a[a.length - 1].toFixed(2) };
      };
      const draw = () => v.scene.post.render(v.rig.active);
      const post = v.scene.post;
      const matcap = time(draw);
      post.viewMode = "realtime";
      r.shadowMap.autoUpdate = false;
      const realtimeCached = time(draw);
      r.shadowMap.autoUpdate = true;
      const realtimeShadows = time(draw);
      post.viewMode = "matcap";
      draw();
      return { matcap, realtimeCached, realtimeShadows };
    });
    console.log("frame ms (render + 1px readback, median of 60):", JSON.stringify(timing));
    fs.writeFileSync(path.join(OUT, "timing.json"), JSON.stringify(timing, null, 2));

    await page.keyboard.press("z");
    s = await state();
    check(s.mode === "realtime", "Z from Matcap goes to Realtime", s.mode);
    await page.keyboard.press("z");
    s = await state();
    check(s.mode === "pathtraced", "Z goes on to Path traced", s.mode);
    await page.keyboard.press("z");
    s = await state();
    check(s.mode === "matcap", "Z wraps round to Matcap", s.mode);
    await page.keyboard.press("Shift+Z");
    await page.keyboard.press("Shift+Z");
    s = await state();
    check(s.mode === "realtime", "Shift+Z goes back", s.mode);
    check(JSON.stringify(await materialIds()) === JSON.stringify(before), "body materials are the same objects back in Realtime");
    const rt2 = await snap();
    check(rt1 === rt2, "Realtime is byte identical after a trip through Matcap", { a: rt1.length, b: rt2.length });
    const programsAfter = await page.evaluate(() => window.viewport.scene.renderer.info.programs.length);
    check(programsAfter - programsBefore <= 1, "one matcap program, nothing recompiled", { programsBefore, programsAfter });

    await page.click('[data-view-mode="matcap"]');
    await page.evaluate(() => window.__fundacad.handleAction("toggle-xray"));
    await shotView("matcap-xray.png");
    await page.evaluate(() => window.__fundacad.handleAction("toggle-xray"));
    await page.evaluate(async () => {
      const url = [...document.scripts].map((x) => x.src).find((x) => /three/.test(x));
      const THREE = url ? await import(url) : await import("/node_modules/.vite/deps/three.js");
      window.viewport.setSectionView({ plane: new THREE.Plane(new THREE.Vector3(0, -1, 0), 50), ghost: 0.15 });
    });
    await shotView("matcap-section.png");
    await page.evaluate(() => window.viewport.setSectionView(null));

    await page.evaluate(async () => (await import("/src/ui/workspace.ts")).setWorkspace("render"));
    s = await state();
    check(s.mode === "realtime", "Render keeps its own mode", s.mode);
    await page.evaluate(async () => (await import("/src/ui/workspace.ts")).setWorkspace("model"));
    s = await state();
    check(s.mode === "matcap", "Model comes back on Matcap", s.mode);

    await page.evaluate(async () => (await import("/src/ui/renderPrefs.ts")).setRenderPref("performanceMode", true));
    await page.waitForTimeout(300);
    s = await state();
    check(s.ptDisabled === "true" && s.ptTitle?.startsWith(PERF_TIP), "performance mode tooltip", s.ptTitle);
    await shotBar("buttons-performance.png");
    await page.evaluate(async () => (await import("/src/ui/renderPrefs.ts")).setRenderPref("performanceMode", false));

    await open();
    s = await state();
    check(s.mode === "matcap", "Matcap is kept across a reload", s.mode);
    await page.evaluate(async () => (await import("/src/ui/renderPrefs.ts")).setRenderPref("viewModeModel", "realtime"));
    console.log(`screenshots in ${OUT}`);
  } finally {
    await browser.close();
  }
  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
