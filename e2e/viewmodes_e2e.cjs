// View modes in the browser: the Matcap, Realtime, Path traced switch on the
// view bar, Z and Shift+Z, one mode per workspace kept across a reload, Matcap
// over glass, emission, clearcoat, a face paint, x-ray and a section, and the
// Path traced tooltip in and out of performance mode. Prints the Matcap and
// Realtime frame times. Wants a GPU Chrome for the timings.
//
//   engine --ws, vite, then
//   SC_TOKEN=<engine token> node e2e/viewmodes_e2e.cjs [N=64]
// SC_URL (default http://localhost:5173/), SC_ENGINE_PORT (default 8765) and
// SC_OUT (screenshot folder, default the OS temp dir) pick the setup, SC_ANGLE (default d3d11) the WebGL backend
// and SC_HEADLESS=1 a headless Chrome.

const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const APP = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const ANGLE = process.env.SC_ANGLE || "d3d11";
const OUT = process.env.SC_OUT || path.join(os.tmpdir(), "viewmodes_e2e");
const N = +(process.argv[2] || 64);
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const PERF_TIP =
  "To avoid crashes or unintentional freezes path tracing has been turned off. To re-enable, turn off performance mode.";

let failures = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: process.env.SC_HEADLESS === "1",
    args: [`--use-angle=${ANGLE}`, "--no-sandbox"].concat(
      ANGLE === "swiftshader" ? ["--enable-unsafe-swiftshader"] : ["--enable-gpu", "--ignore-gpu-blocklist"],
    ),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
    await page.addInitScript((ws) => {
      const W = window.WebSocket;
      window.WebSocket = class extends W {
        constructor(u, p) {
          super(String(u).replace(":8765", `:${ws}`), p);
        }
      };
    }, ENGINE_PORT);
    await page.addInitScript(() => {
      window.__gpuSubmits = 0;
      window.__rafs = 0;
      const q = globalThis.GPUQueue?.prototype;
      if (q) {
        const submit = q.submit;
        q.submit = function (...a) {
          window.__gpuSubmits++;
          return submit.apply(this, a);
        };
      }
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) =>
        raf((t) => {
          window.__rafs++;
          cb(t);
        });
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__saved = { name: this.download, href: this.href };
        return click.call(this);
      };
    });
    const open = async () => {
      await page.goto(`${APP}?token=${TOKEN}`);
      await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
      await page.waitForTimeout(1500);
      const modal = await page.$(".modal-close");
      if (modal) await modal.click();
    };
    await open();
    const gpu = await page.evaluate(() => {
      const g = window.viewport.scene.renderer.getContext();
      const d = g.getExtension("WEBGL_debug_renderer_info");
      return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?";
    });
    console.log(`gpu ${gpu}`);
    // A software renderer starts on the low power tier, which blocks Path traced.
    if (/swiftshader|llvmpipe|software/i.test(gpu)) {
      console.error("needs a GPU: the low power tier a software renderer gets blocks Path traced");
      process.exitCode = 1;
      return;
    }
    await page.evaluate(async () => {
      const { setRenderPref } = await import("/src/ui/renderPrefs.ts");
      setRenderPref("viewModeModel", "realtime");
      setRenderPref("viewModeRender", "realtime");
      setRenderPref("performanceMode", false);
    });

    await page.evaluate(async (N) => {
      const s = window.store,
        v = window.viewport;
      const side = Math.ceil(Math.sqrt(N));
      const features = [];
      for (let i = 0; i < N; i++) {
        if (i % 2) features.push({ id: `c${i}`, type: "cylinder", radius: 8, height: 20 });
        else features.push({ id: `c${i}`, type: "sphere", radius: 9 });
        features.push({
          id: `m${i}`,
          type: "move",
          bodies: [`body${i + 1}`],
          dx: (i % side) * 25,
          dy: Math.floor(i / side) * 25,
          dz: 0,
          rx: 0,
          ry: 0,
          rz: 0,
        });
      }
      s.load(JSON.stringify({ parameters: {}, features }));
      const t0 = performance.now();
      while (s.buildState.building || v.bodyMeshes.length < N) {
        if (performance.now() - t0 > 60000) throw new Error("build timed out");
        await new Promise((r) => setTimeout(r, 300));
      }
      const ids = (off) =>
        Array.from({ length: N }, (_, i) => i)
          .filter((i) => i % 8 === off)
          .map((i) => `body${i + 1}`);
      s.setBodiesMaterial(ids(0), s.addMaterial({ name: "glass", color: "#9fd8ff", opacity: 0.3, roughness: 0.05 }));
      s.setBodiesMaterial(ids(3), s.addMaterial({ name: "emit", color: "#ff7a2a", emissive: 0.8 }));
      s.setBodiesMaterial(
        ids(5),
        s.addMaterial({ name: "coat", color: "#c03040", clearcoat: 1, metalness: 0.2, roughness: 0.3 }),
      );
      s.setFacesMaterial(
        [0, 1].map((face) => ({ body: "body2", face })),
        s.addMaterial({ name: "paint", color: "#2f6bff" }),
      );
      await new Promise((r) => setTimeout(r, 3000));
      window.__fundacad.handleAction("fit");
      await new Promise((r) => setTimeout(r, 1500));
    }, N);
    await page.mouse.move(5, 5);

    const state = () =>
      page.evaluate(() => {
        const v = window.viewport;
        const pressed = [...document.querySelectorAll("[data-view-mode]")]
          .filter((b) => b.getAttribute("aria-pressed") === "true")
          .map((b) => b.dataset.viewMode);
        const pt = document.querySelector('[data-view-mode="pathtraced"]');
        return {
          mode: v.viewMode,
          post: v.scene.post.viewMode,
          pressed,
          ptTitle: pt?.getAttribute("title"),
          ptDisabled: pt?.getAttribute("aria-disabled"),
        };
      });
    const materialIds = () =>
      page.evaluate(() => {
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
    check(
      s.ptDisabled !== "true" && s.ptTitle === "Path traced (Z)",
      "Path traced is offered on a WebGPU Chrome",
      s.ptTitle,
    );
    const titles = await page.$$eval("[data-view-mode]", (bs) => bs.map((b) => b.getAttribute("title")));
    check(titles[0] === "Matcap (Z)" && titles[1] === "Realtime (Z)", "button titles", titles);
    await shotBar("buttons-realtime.png");
    await shotView("realtime.png");

    const before = await materialIds();
    const rt1 = await snap();

    const traceStart = Date.now();
    await page.click('[data-view-mode="pathtraced"]');
    s = await state();
    check(s.mode === "pathtraced" && s.post === "pathtraced", "Path traced button", s);
    const traced = await page
      .waitForFunction(
        () => {
          const t = window.viewport.traceStatus;
          return t.samples >= 64 && t.shown ? t : null;
        },
        null,
        { timeout: 90000, polling: 100 },
      )
      .then(
        (h) => h.jsonValue(),
        (e) => ({ error: String(e) }),
      );
    check(traced.samples >= 64 && traced.shown, "Path traced reaches 64 samples and shows them", traced);
    // A GPU another program is busy on traces several times slower, so a wait for the cap is four times the time
    // the first 64 samples took, scaled to 256, and never under two minutes.
    const traceMs = Math.max(120000, 4 * 4 * (Date.now() - traceStart));
    console.log(`first 64 samples in ${Date.now() - traceStart} ms, a wait for the cap allows ${traceMs} ms`);
    await shotView("pathtraced-64.png");
    const capped = await page
      .waitForFunction(
        () => (window.viewport.traceStatus.state === "done" ? window.viewport.traceStatus : null),
        null,
        { timeout: traceMs, polling: 200 },
      )
      .then(
        (h) => h.jsonValue(),
        (e) => ({ error: String(e) }),
      );
    check(capped.state === "done" && capped.samples >= 256, "the tracer stops at the sample cap", capped);
    const status = () => page.evaluate(() => window.viewport.traceStatus);
    const setDenoise = (v) =>
      page.evaluate(async (d) => (await import("/src/ui/renderPrefs.ts")).setRenderPref("denoise", d), v);
    const waitDenoised = () =>
      page
        .waitForFunction(() => window.viewport.traceStatus.denoised, null, { timeout: traceMs, polling: 100 })
        .then(
          () => status(),
          (e) => ({ error: String(e) }),
        );
    const t0 = Date.now();
    const den = await waitDenoised();
    check(den.denoised === true && den.state === "done", "the final denoise lands at the cap", {
      ...den,
      ms: Date.now() - t0,
    });
    await shotView("pathtraced-256-denoised.png");
    await setDenoise("off");
    await page.waitForTimeout(300);
    const raw = await status();
    check(!raw.denoised && raw.samples >= 256, "denoise off shows the raw samples without tracing again", raw);
    await shotView("pathtraced-256-raw.png");
    // The tracer restarts on any camera or scene change; restart() is the same reset without moving the view.
    const at16 = async (name) => {
      await page.evaluate(() => window.viewport.trace.restart());
      const h = await page.waitForFunction(
        () => (window.viewport.traceStatus.samples >= 16 ? window.viewport.traceStatus : null),
        null,
        { timeout: 60000, polling: 16 },
      );
      const st = await h.jsonValue();
      await page.screenshot({ path: path.join(OUT, name), clip: { x: 0, y: 40, width: 1400, height: 860 } });
      return st;
    };
    console.log("raw at", (await at16("pathtraced-16-raw.png")).samples, "samples");
    await setDenoise("standard");
    console.log("filtered at", (await at16("pathtraced-16-filtered.png")).samples, "samples");
    const again = await waitDenoised();
    check(again.denoised === true, "the denoise runs again after a restart", again);
    check(
      JSON.stringify(await materialIds()) === JSON.stringify(before),
      "body materials are the same objects in Path traced",
    );

    const counters = () => page.evaluate(() => ({ submits: window.__gpuSubmits, rafs: window.__rafs }));
    await page.waitForTimeout(500);
    const c0 = await counters();
    await page.waitForTimeout(2000);
    const c1 = await counters();
    // The viewport's own loop keeps its rAF, drawing only on demand; the tracer must add no GPU work.
    check(c1.submits - c0.submits === 0, "no GPU work at the cap", {
      submits: c1.submits - c0.submits,
      rafs: c1.rafs - c0.rafs,
    });
    const cost = await page.evaluate(() => {
      const t = window.viewport.trace.backend?.tracer;
      return { budget: t?.frameBudget, renderScale: t?.renderScale, cap: t?.maxSamples };
    });
    check(
      cost.renderScale === 0.75 && cost.cap === 256,
      "traces at three quarters of the canvas up to 256 samples",
      cost,
    );

    await page.evaluate(async () => (await import("/src/ui/workspace.ts")).setWorkspace("render"));
    await page.click('[data-view-mode="pathtraced"]');
    await page.waitForFunction(() => !!window.viewport.tracedPictureSize(1), null, { timeout: 60000, polling: 200 });
    await page.click('#renderdock [role=tab][data-tab="camera"]');
    await page.click('[data-scale="1"]');
    await page.click('[data-samples="64"]');
    const offer = await page.evaluate(() => ({
      traced: document.querySelector("#rd-traced input")?.checked,
      size: window.viewport.tracedPictureSize(1),
    }));
    check(offer.traced === true, "the Camera tab offers a traced picture in Path traced", offer);
    const p0 = Date.now();
    await page.click("#rd-take-picture");
    await page.waitForFunction(() => window.viewport.traceStatus.picturing, null, { timeout: 10000, polling: 16 });
    const during = await page.evaluate(() => ({
      shown: window.viewport.traceStatus.shown,
      button: document.querySelector("#rd-take-picture")?.textContent,
    }));
    await page.waitForFunction(() => !!window.__saved, null, { timeout: traceMs, polling: 100 });
    const pictureMs = Date.now() - p0;
    const pic = await page.evaluate(async () => {
      const load = (src) =>
        new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = src;
        });
      const pixels = (img) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const traced = await load(window.__saved.href);
      const raster = await load(window.viewport.renderStill(1, { realtime: true }));
      const a = pixels(traced),
        b = pixels(raster);
      // The difference is taken over the model only, where the raster still is off its own corner background: the
      // Render workspace frames the model small, so a whole frame mean is mostly two equal backgrounds.
      const bg = (b[0] + b[1] + b[2]) / 3;
      let sum = 0,
        sq = 0,
        diff = 0,
        model = 0;
      const n = a.length / 4;
      for (let i = 0; i < a.length; i += 4) {
        const l = (a[i] + a[i + 1] + a[i + 2]) / 3;
        sum += l;
        sq += l * l;
        const r = (b[i] + b[i + 1] + b[i + 2]) / 3;
        if (a.length === b.length && Math.abs(r - bg) > 8) {
          diff += Math.abs(l - r);
          model++;
        }
      }
      const mean = sum / n;
      return {
        name: window.__saved.name,
        w: traced.width,
        h: traced.height,
        rw: raster.width,
        rh: raster.height,
        mean: +mean.toFixed(1),
        sd: +Math.sqrt(sq / n - mean * mean).toFixed(1),
        modelPx: model,
        diffFromRaster: +(diff / Math.max(1, model)).toFixed(2),
      };
    });
    const base64 = await page.evaluate(() => window.__saved.href.slice(window.__saved.href.indexOf(",") + 1));
    fs.writeFileSync(path.join(OUT, "picture-traced.png"), Buffer.from(base64, "base64"));
    const after = await page
      .waitForFunction(
        () =>
          window.viewport.traceStatus.samples > 0 && !window.viewport.traceStatus.picturing
            ? window.viewport.traceStatus
            : null,
        null,
        { timeout: 30000, polling: 100 },
      )
      .then(
        (h) => h.jsonValue(),
        (e) => ({ error: String(e) }),
      );
    check(
      during.shown === false && /Cancel/.test(during.button || ""),
      "the viewport shows Realtime while the picture traces",
      during,
    );
    check(
      pic.w === offer.size.width && pic.h === offer.size.height && pic.sd > 5 && pic.diffFromRaster > 1,
      "a traced picture is saved at the view's size and is not the raster still",
      { ...pic, ms: pictureMs },
    );
    check(after.samples > 0 && after.shown, "the viewport traces again after the picture", after);
    await page.click('[data-view-mode="realtime"]');
    await page.evaluate(async () => (await import("/src/ui/workspace.ts")).setWorkspace("model"));
    await page.evaluate(async () => (await import("/src/ui/renderPrefs.ts")).setRenderPref("performanceMode", true));
    await page.waitForTimeout(300);
    s = await state();
    check(
      s.mode === "realtime" && s.ptDisabled === "true" && s.ptTitle?.startsWith(PERF_TIP),
      "performance mode drops Path traced to Realtime",
      s,
    );
    // aria-disabled reads as disabled to Playwright, but a soft block still takes the user's click.
    await page.click('[data-view-mode="pathtraced"]', { force: true });
    await page.waitForTimeout(300);
    s = await state();
    check(s.mode === "realtime" && s.ptDisabled === "true", "the first click on the greyed Path traced only warns", s);
    await page.click('[data-view-mode="pathtraced"]', { force: true });
    await page.waitForTimeout(500);
    s = await state();
    check(s.mode === "pathtraced" && s.ptDisabled !== "true", "a second click enables Path traced for the session", s);
    const kept = await page.evaluate(() => JSON.stringify(localStorage).includes("override"));
    check(!kept, "the session override is not saved", kept);
    await page.click('[data-view-mode="realtime"]');
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
    check(
      JSON.stringify(await materialIds()) === JSON.stringify(before),
      "body materials are the same objects in Matcap",
    );

    const timing = await page.evaluate(() => {
      const v = window.viewport,
        r = v.scene.renderer,
        gl = r.getContext(),
        px = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const time = (fn, n = 60) => {
        fn();
        sync();
        const a = [];
        for (let i = 0; i < n; i++) {
          const t = performance.now();
          fn();
          sync();
          a.push(performance.now() - t);
        }
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
    check(
      JSON.stringify(await materialIds()) === JSON.stringify(before),
      "body materials are the same objects back in Realtime",
    );
    const rt2 = await snap();
    const trip = await page.evaluate(
      async ([a, b]) => {
        const px = async (u) => {
          const i = new Image();
          i.src = u;
          await i.decode();
          const c = document.createElement("canvas");
          c.width = i.width;
          c.height = i.height;
          const g = c.getContext("2d");
          g.drawImage(i, 0, 0);
          return g.getImageData(0, 0, i.width, i.height).data;
        };
        const [p, q] = await Promise.all([px(a), px(b)]);
        let changed = 0;
        for (let i = 0; i < p.length; i += 4)
          if (Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])) > 2)
            changed++;
        return { same: a === b, sameSize: p.length === q.length, changed, of: p.length / 4 };
      },
      [rt1, rt2],
    );
    check(trip.sameSize && trip.changed === 0, "Realtime draws the same pixels after a trip through Matcap", trip);
    const programsAfter = await page.evaluate(() => window.viewport.scene.renderer.info.programs.length);
    check(programsAfter - programsBefore <= 1, "one matcap program, nothing recompiled", {
      programsBefore,
      programsAfter,
    });

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
    await page.evaluate(async () =>
      (await import("/src/ui/renderPrefs.ts")).setRenderPref("viewModeModel", "realtime"),
    );
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
