// What Path traced shows while the view moves, measured: no partial or black frame, no flash
// over the WCAG 2.3.1 general limit, and how long a camera change takes to reach the screen.
//
// A stop and go orbit in the real app, on the native tracer or with FLASH_TRACER=webgpu on
// WebGPU, there on SwiftShader unless FLASH_WEBGPU_REAL=1. Each frame is seen twice:
// - the trace canvas, read in the same task as each draw, so nothing is missed;
// - the composed page, from the browser's screencast, which holds the Realtime picture,
//   the fade and the overlays, but can skip frames.
// Neither sees the OS compositor or the monitor.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_CHROME=<chrome exe>] [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] node e2e/pathtrace_flash_e2e.cjs [outDir]
// SC_TRACER_SERVE points at the tracer_serve example, or SC_TRACER_PORT at one already
// listening with the same token, with SC_TRACER_FRAMES_PORT for its frame socket when it sits
// behind a port map, as in Docker. FLASH_MEASURE_ONLY=1 prints and writes the numbers and
// always exits 0, for a baseline on code known to fail. FLASH_MODEL is a .funda file to orbit
// in place of the small test plate. FLASH_PAUSE_SCALE and FLASH_SETTLE_MS stretch the orbit's
// pauses and its end, so a slow software adapter gets to a sample before the next move.
// FLASH_CAMERA=ex,ey,ez,tx,ty,tz starts each orbit from that view, for a model seen from inside.
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { analyse, blackEdges, toGridSource } = require("./lib/flash.cjs");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "pathtrace_flash_shots");
const MEASURE_ONLY = process.env.FLASH_MEASURE_ONLY === "1";
const WEBGPU = process.env.FLASH_TRACER === "webgpu";
const MODEL = process.env.FLASH_MODEL ? fs.readFileSync(process.env.FLASH_MODEL, "utf8") : null;
const [VW, VH] = (process.env.SC_VIEWPORT || "800x560").split("x").map(Number);
const ORBIT_MS = Number(process.env.FLASH_ORBIT_MS || 8000);
const PAUSE_SCALE = Number(process.env.FLASH_PAUSE_SCALE || 1);
const SETTLE_MS = Number(process.env.FLASH_SETTLE_MS || 1200);
const CAMERA = process.env.FLASH_CAMERA ? process.env.FLASH_CAMERA.split(",").map(Number) : null;
const target = process.env.CARGO_TARGET_DIR || path.join(__dirname, "..", "src-tauri", "target");
const SERVE =
  process.env.SC_TRACER_SERVE ||
  path.join(target, "release", "examples", process.platform === "win32" ? "tracer_serve.exe" : "tracer_serve");
const COLS = 40;
const ROWS = 25;
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

// A piped stdin: tracer_serve exits when it closes, so it never outlives this script.
function startTracerServe() {
  const srv = spawn(SERVE, [TOKEN], { stdio: ["pipe", "pipe", "inherit"] });
  const port = new Promise((ok, fail) => {
    let buf = "";
    srv.stdout.on("data", (d) => {
      buf += d;
      const m = /^LISTENING (\d+)/m.exec(buf);
      if (m) ok(m[1]);
    });
    srv.on("error", fail);
    srv.on("exit", (c) => fail(new Error(`tracer_serve exited with ${c}`)));
    setTimeout(() => fail(new Error("tracer_serve printed no port")), 20000);
  });
  return { srv, port };
}

// Runs in the page. The trace canvas has no preserved buffer, so it is read right after each draw.
function installCapture([cols, rows, webgpu]) {
  const log = { on: false, draws: [], ticks: [], cameras: [] };
  window.__flash = log;
  const linear = Float32Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const backend = () => window.viewport?.trace?.backend;
  const record = (px, w, h) => {
    const lum = new Array(cols * rows).fill(0);
    const hits = new Array(cols * rows).fill(0);
    for (let y = 0; y < h; y += 2) {
      const cy = Math.min(rows - 1, Math.floor((y * rows) / h));
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const cell = cy * cols + Math.min(cols - 1, Math.floor((x * cols) / w));
        lum[cell] += 0.2126 * linear[px[i]] + 0.7152 * linear[px[i + 1]] + 0.0722 * linear[px[i + 2]];
        hits[cell]++;
      }
    }
    const v = window.viewport.trace;
    const entry = {
      t: performance.now(),
      w,
      h,
      lum: lum.map((s, i) => (hits[i] ? s / hits[i] : 0)),
      shown: v.shown,
      state: v.state,
      samples: v.samples,
      seq: null,
    };
    log.draws.push(entry);
    queueMicrotask(() => (entry.seq = backend()?.shownSeq ?? null));
  };
  if (webgpu) {
    // The app greys Path traced on a fallback adapter, and SwiftShader is one.
    Object.defineProperty(GPUAdapterInfo.prototype, "isFallbackAdapter", { get: () => false });
    // A WebGPU canvas reads blank after its task, so it is copied right after the submit that drew it.
    let drew = false;
    const copy = new OffscreenCanvas(1, 1);
    const g = copy.getContext("2d", { willReadFrequently: true });
    const texture = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      drew = true;
      return texture.call(this);
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (buffers) {
      submit.call(this, buffers);
      const c = backend()?.canvas;
      if (!drew || !log.on || !c?.width) return;
      drew = false;
      copy.width = c.width;
      copy.height = c.height;
      g.drawImage(c, 0, 0);
      record(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    };
  } else {
    const real = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (...a) {
      real.apply(this, a);
      if (!log.on || this.canvas === window.viewport?.canvas || this.getContextAttributes().depth !== false) return;
      const w = this.drawingBufferWidth;
      const h = this.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      this.readPixels(0, 0, w, h, this.RGBA, this.UNSIGNED_BYTE, px);
      record(px, w, h);
    };
  }
  const loop = () => {
    requestAnimationFrame(loop);
    if (!log.on) return;
    const v = window.viewport?.trace;
    if (!v) return;
    const freeze = window.viewport.freeze?.el;
    log.ticks.push({
      t: performance.now(),
      shown: v.shown,
      state: v.state,
      samples: v.samples,
      draws: log.draws.length,
      freeze: freeze && freeze.style.display !== "none" ? Number(freeze.style.opacity) : 0,
    });
  };
  requestAnimationFrame(loop);
  log.watchCameras = () => {
    if (webgpu) return true;
    const c = backend()?.cameras;
    if (!c || c.__watched) return !!c;
    c.__watched = true;
    const send = c.send.bind(c);
    c.send = (camera) => {
      const entry = { t: performance.now(), after: null, answered: 0 };
      log.cameras.push(entry);
      const take = send(camera);
      return (reply) => {
        take(reply);
        entry.after = typeof reply === "number" ? reply : null;
        entry.answered = performance.now();
      };
    };
    return true;
  };
}

// Seqs are u32 and wrap.
const after = (seq, a) => seq !== null && a !== null && ((seq - a) | 0) > 0;

function median(v) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return +s[s.length >> 1].toFixed(1);
}
const worst = (v) => (v.length ? +Math.max(...v).toFixed(1) : null);

/** From each camera sent to the first drawn frame traced with it or a newer one, and to the first whole one. */
function lag(cameras, draws) {
  const first = [];
  const whole = [];
  for (const c of cameras) {
    const d = draws.find((x) => x.t >= c.t && after(x.seq, c.after));
    if (d) first.push(d.t - c.t);
    const w = draws.find((x) => x.t >= c.t && after(x.seq, c.after) && blackEdges(x.lum, COLS).share === 0);
    if (w) whole.push(w.t - c.t);
  }
  return {
    cameras: cameras.length,
    firstMedian: median(first),
    firstWorst: worst(first),
    wholeMedian: median(whole),
    wholeWorst: worst(whole),
  };
}

/** The page's ticks where the trace was up, unfaded enough to read, over a frame with a black edge. */
function visibleBands(ticks, draws) {
  let n = 0;
  let shownWithBand = 0;
  for (const t of ticks) {
    if (!t.shown || !t.draws) continue;
    const d = draws[t.draws - 1];
    const share = blackEdges(d.lum, COLS).share;
    if (share < 0.1 || share >= 1) continue;
    shownWithBand++;
    if (t.freeze < 0.9) n++;
  }
  return { shownWithBand, visible: n };
}

/** Each time the trace and Realtime swap places in a second, at worst. */
function swapsPerSecond(ticks) {
  const swaps = [];
  for (let i = 1; i < ticks.length; i++) if (ticks[i].shown !== ticks[i - 1].shown) swaps.push(ticks[i].t);
  let most = 0;
  for (const t of swaps) most = Math.max(most, swaps.filter((s) => s > t - 1000 && s <= t).length);
  return { swaps: swaps.length, mostInASecond: most };
}

function browserArgs() {
  const common = ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist"];
  // Chrome offers no WebGPU adapter at all once ANGLE is told to use SwiftShader, so a WebGPU run leaves ANGLE alone.
  if (WEBGPU && process.env.FLASH_WEBGPU_REAL === "1") return [...common, "--enable-unsafe-webgpu"];
  if (WEBGPU) return ["--no-sandbox", "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"];
  // The native page still draws Realtime with WebGL, on SwiftShader so the GPU stays idle.
  return [...common, "--use-angle=swiftshader"];
}

let serve = null;
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let port = process.env.SC_TRACER_PORT;
  if (!port && !WEBGPU) {
    serve = startTracerServe();
    port = await serve.port;
  }
  const pick = WEBGPU ? "tracer=webgpu" : `tracer=native-dev&port=${port}`;
  const url = URL + (URL.includes("?") ? "&" : "?") + `token=${encodeURIComponent(TOKEN)}&${pick}`;
  const browser = await chromium.launch({
    ...(EXE ? { executablePath: EXE } : { channel: "chrome" }),
    args: browserArgs(),
  });
  const report = { viewport: [VW, VH], orbitMs: ORBIT_MS, runs: {} };
  try {
    const page = await browser.newPage({ colorScheme: "dark", viewport: { width: VW, height: VH } });
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    page.on("console", (m) => {
      if (/tracer|native|fault/i.test(m.text())) console.log(`[page] ${m.text().slice(0, 300)}`);
    });
    await page.addInitScript(installCapture, [COLS, ROWS, WEBGPU]);
    // Only the engine's socket: the native frames carry their own token.
    await page.addInitScript(
      ([port, t, frames, tracer]) => {
        const N = window.WebSocket;
        window.WebSocket = class extends N {
          constructor(u, p) {
            if (!String(u).includes(":8765/") && !String(u).endsWith(":8765")) {
              const portOf = new window.URL(String(u)).port;
              const skip = !frames || portOf === tracer || portOf === window.location.port;
              super(skip ? u : String(u).replace(`:${portOf}`, `:${frames}`), p);
              return;
            }
            let s = String(u).replace(":8765", ":" + port);
            s = s.replace(/([?&])token=[^&]*/, `$1token=${t}`);
            super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
          }
        };
      },
      [PORT, TOKEN, process.env.SC_TRACER_FRAMES_PORT || "", String(port)],
    );
    await page.goto(url);
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) {
      await modal.click();
      await page.waitForTimeout(300);
    }
    const setPref = (k, v) =>
      page.evaluate(async ([k, v]) => (await import("/src/ui/renderPrefs.ts")).setRenderPref(k, v), [k, v]);
    await page.evaluate(async (model) => {
      const s = window.store;
      if (model) s.load(model);
      else {
        s.addFeature({ id: s.nextId(), type: "box", length: 80, width: 80, height: 6 });
        s.addFeature({ id: s.nextId(), type: "cylinder", radius: 12, height: 40 });
      }
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 2) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    }, MODEL);
    await page.evaluate(() => window.__fundacad.handleAction("iso"));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(800);
    await setPref("denoise", "off");
    await setPref("bloom", 0);
    // A software WebGL renderer reads as a low powered computer, which greys Path traced until a second click lifts it.
    await page.evaluate(() => {
      const pt = document.querySelector('[data-view-mode="pathtraced"]');
      if (pt.getAttribute("aria-disabled") === "true") pt.click();
      pt.click();
    });
    await page
      .waitForFunction(() => (window.viewport.trace?.samples ?? 0) >= 1 && window.__flash.watchCameras(), null, {
        timeout: 90000,
      })
      .catch(() => {});
    const backendName = await page.evaluate(() => window.viewport.trace?.backendName ?? "");
    if (!backendName) {
      const v = await page.evaluate(() => {
        const t = window.viewport.trace;
        return [
          window.viewport.viewModeNow,
          window.viewport.tracerKind,
          t.state,
          t.note,
          t.disabled,
          t.lastFault,
          t.samples,
        ];
      });
      console.log("no tracer:", JSON.stringify(v));
    }
    console.log(`backend ${backendName}`);
    report.backend = backendName;
    report.adapters = await page.evaluate(async () => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const a = await navigator.gpu?.requestAdapter();
      return { webgl: info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL), webgpu: a?.info?.architecture };
    });
    console.log(JSON.stringify(report.adapters));
    if (!(WEBGPU ? /WebGPU/ : /^native/).test(backendName))
      throw new Error(`the wanted tracer did not start: ${backendName}`);
    // The middle of the view: the panels around it are lit whatever the trace does.
    const box = await page.evaluate(() => {
      const r = window.viewport.canvas.getBoundingClientRect();
      return {
        x: Math.round(r.x + r.width * 0.3),
        y: Math.round(r.y + r.height * 0.14),
        width: Math.round(r.width * 0.4),
        height: Math.round(r.height * 0.7),
      };
    });
    const cdp = await page.context().newCDPSession(page);

    // Pauses either side of STILL_MS, so the trace restarts and is cut off again.
    const PAUSES = [60, 180, 90, 240, 400, 160, 700].map((p) => p * PAUSE_SCALE);
    // Stepped in the page's own frames, so the steps do not wait on this script.
    const orbit = (ms) =>
      page.evaluate(
        async ([ms, pauses]) => {
          const frame = () => new Promise((r) => requestAnimationFrame(r));
          const end = performance.now() + ms;
          let dir = 1;
          let leg = 0;
          while (performance.now() < end) {
            const until = performance.now() + 220;
            while (performance.now() < until) {
              window.viewport.rig.orbitBy(dir * 0.02, 0.004 * dir);
              await frame();
            }
            if (leg % 3 === 2) dir = -dir;
            await new Promise((r) => setTimeout(r, pauses[leg++ % pauses.length]));
          }
        },
        [ms, PAUSES],
      );

    const run = async (name, realtimeOn, motion) => {
      await page.evaluate(async (m) => (await import("/src/ui/motion.ts")).setMotion(m), motion);
      await setPref("realtimeWhileMoving", realtimeOn);
      if (CAMERA)
        await page.evaluate((c) => {
          const V = window.viewport.camera.position.constructor;
          window.viewport.rig.setLookAt(new V(c[0], c[1], c[2]), new V(c[3], c[4], c[5]), false);
        }, CAMERA);
      await page.waitForTimeout(1500);
      const frames = [];
      const onFrame = (e) => {
        frames.push({ wall: e.metadata.timestamp * 1000, data: e.data });
        cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => {});
      };
      cdp.on("Page.screencastFrame", onFrame);
      await page.evaluate(() => {
        const f = window.__flash;
        f.draws.length = 0;
        f.ticks.length = 0;
        f.cameras.length = 0;
        f.watchCameras();
        f.on = true;
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
      const startWall = Date.now();
      await orbit(ORBIT_MS);
      await page.waitForTimeout(SETTLE_MS);
      console.log(`${name}: orbit done, ${frames.length} screencast frames`);
      await cdp.send("Page.stopScreencast");
      cdp.off("Page.screencastFrame", onFrame);
      const log = await page.evaluate(() => {
        const f = window.__flash;
        f.on = false;
        return { draws: f.draws, ticks: f.ticks, cameras: f.cameras };
      });
      // WebGPU's canvas holds raw passes behind the Realtime picture, only what is up counts there.
      const counted = WEBGPU ? log.draws.filter((d) => d.shown) : log.draws;
      const trace = analyse(
        counted.map((d) => ({ t: d.t, lum: Float32Array.from(d.lum) })),
        COLS,
      );
      // Decoded on a blank page once the run is over, so it costs the run nothing.
      const decoder = await browser.newPage();
      await decoder.evaluate(`window.__toGrid = ${toGridSource}`);
      const composed = [];
      for (const f of frames) {
        const lum = await decoder.evaluate(
          async ([data, b, cols, rows]) => {
            const bm = await createImageBitmap(await (await fetch("data:image/jpeg;base64," + data)).blob());
            const c = new OffscreenCanvas(b.width, b.height);
            const g = c.getContext("2d", { willReadFrequently: true });
            g.drawImage(bm, -b.x, -b.y);
            return Array.from(
              window.__toGrid(g.getImageData(0, 0, b.width, b.height).data, b.width, b.height, cols, rows),
            );
          },
          [f.data, box, COLS, ROWS],
        );
        composed.push({ t: f.wall - startWall, lum: Float32Array.from(lum) });
      }
      await decoder.close();
      const screen = analyse(composed, COLS);
      const worstShot = screen.bad[0];
      if (worstShot)
        fs.writeFileSync(path.join(OUT, `${name}_bad.jpg`), Buffer.from(frames[worstShot.i].data, "base64"));
      if (frames.length)
        fs.writeFileSync(path.join(OUT, `${name}_last.jpg`), Buffer.from(frames[frames.length - 1].data, "base64"));
      const out = {
        trace: { ...trace, bad: trace.bad.slice(0, 6) },
        screen: { ...screen, bad: screen.bad.slice(0, 6) },
        handover: visibleBands(log.ticks, log.draws),
        swaps: swapsPerSecond(log.ticks),
        lag: lag(log.cameras, log.draws),
        rafs: log.ticks.length,
        draws: log.draws.length,
        darkCounted: counted.filter((d) => d.lum.reduce((sum, l) => sum + l, 0) / d.lum.length < 0.2 * trace.meanHigh)
          .length,
      };
      report.runs[name] = out;
      console.log(name, JSON.stringify(out));
      check(`${name}: no partial frame on screen`, screen.bands === 0, `${screen.bands} of ${screen.frames}`);
      check(`${name}: no lit frame goes black`, screen.blackFrames === 0, `${screen.blackFrames} of ${screen.frames}`);
      check(
        `${name}: no partial frame reaches the trace canvas`,
        trace.bands === 0,
        `${trace.bands} of ${trace.frames}`,
      );
      check(`${name}: at most three flashes a second on screen`, !screen.overLimit, `${screen.flashes}`);
      check(`${name}: at most three flashes a second on the trace`, !trace.overLimit, `${trace.flashes}`);
    };

    await run("realtime_on_motion_on", true, true);
    await run("realtime_on_motion_off", true, false);
    await run("realtime_off", false, true);

    // How fast this tracer is on this scene: one small move, then the trace at rest.
    await setPref("realtimeWhileMoving", true);
    await page.waitForTimeout(1500);
    report.timing = await page.evaluate(async () => {
      const v = window.viewport;
      const before = v.trace.samples;
      v.rig.orbitBy(0.02, 0);
      const start = performance.now();
      const marks = { 1: null, 16: null, 64: null, 256: null };
      let restarted = false;
      while (performance.now() - start < 10000 && marks[256] === null) {
        await new Promise((r) => requestAnimationFrame(r));
        const n = v.trace.samples;
        restarted ||= n < before;
        if (!restarted) continue;
        for (const m of Object.keys(marks))
          if (marks[m] === null && n >= m) marks[m] = Math.round(performance.now() - start);
      }
      return { before, msToSamples: marks, samples: v.trace.samples };
    });
    console.log("timing", JSON.stringify(report.timing));
  } finally {
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
    await browser.close();
    serve?.srv.kill();
  }
  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures && !MEASURE_ONLY ? 1 : 0);
})().catch((e) => {
  console.error(e);
  serve?.srv.kill();
  process.exit(1);
});
