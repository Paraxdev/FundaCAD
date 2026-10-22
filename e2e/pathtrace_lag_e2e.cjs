// Path traced keeps up with a 2 s orbit with Realtime while moving off: every
// frame on screen is traced at a camera at most three frames old, the edges
// draw with the camera of the frame on screen on every display frame, the last
// camera reaches the screen within three frames of the stop, and at rest the
// traced box sits within 2 px of the Realtime box. The native tracer once
// played back a queue of every camera the page sent, up to 1.5 s late.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_CHROME=<chrome exe>] [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_TRACER=native-dev] [SC_VIEWPORT=2560x1440] \
//     node e2e/pathtrace_lag_e2e.cjs
// SC_TRACER=native-dev traces on the native tracer through tracer_serve, see
// e2e/pathtrace_moving_e2e.cjs for how to build it.
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const NATIVE = process.env.SC_TRACER === "native-dev";
const [VW, VH] = (process.env.SC_VIEWPORT || "2560x1440").split("x").map(Number);
const target = process.env.CARGO_TARGET_DIR || path.join(__dirname, "..", "src-tauri", "target");
const SERVE = process.env.SC_TRACER_SERVE
  || path.join(target, "release", "examples", process.platform === "win32" ? "tracer_serve.exe" : "tracer_serve");
const ORBIT_MS = 2000;

if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

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

// Runs in the page: the box of the pixels unlike the corner, in pixels.
function bodyBox(d, w, h) {
  const bg = [d[0], d[1], d[2]];
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 60) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h };
}

let serve = null;
(async () => {
  let url = URL;
  if (NATIVE) {
    serve = startTracerServe();
    url += (url.includes("?") ? "&" : "?") + `token=${encodeURIComponent(TOKEN)}&tracer=native-dev&port=${await serve.port}`;
  }
  const browser = await chromium.launch({
    ...(EXE ? { executablePath: EXE } : { channel: "chrome" }),
    args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: VW, height: VH } });
    page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
    await page.addInitScript(([port, t, box]) => {
      window.__bodyBox = (0, eval)(`(${box})`);
      const N = window.WebSocket;
      window.WebSocket = class extends N {
        constructor(u, p) {
          if (!String(u).includes(":8765/") && !String(u).endsWith(":8765")) { super(u, p); return; }
          let s = String(u).replace(":8765", ":" + port);
          s = s.replace(/([?&])token=[^&]*/, `$1token=${t}`);
          super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
        }
      };
    }, [PORT, TOKEN, bodyBox.toString()]);
    await page.goto(url);
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) { await modal.click(); await page.waitForTimeout(300); }
    const setPref = (k, v) => page.evaluate(async ([k, v]) => (await import("/src/ui/renderPrefs.ts")).setRenderPref(k, v), [k, v]);
    await setPref("bloom", 0);
    await setPref("denoise", "off");
    await setPref("realtimeWhileMoving", false);
    await setPref("environment", "none");
    await setPref("envBackground", true);
    await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "box", length: 60, width: 40, height: 30 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 1) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await page.evaluate(() => { window.__fundacad.handleAction("iso"); window.__fundacad.handleAction("fit"); });
    await page.waitForTimeout(600);
    await page.mouse.move(5, 5);
    // No cap, so frames still come when the traced box is read at rest.
    await page.evaluate(() => { window.viewport.trace.cap = 1e6; });
    await page.click('[data-view-mode="pathtraced"]');
    const settled = () => page.waitForFunction(() => {
      const s = window.viewport.traceStatus;
      return s.shown && s.samples >= 16 ? s : null;
    }, null, { timeout: 240000, polling: 250 }).then((h) => h.jsonValue());
    const st = await settled();
    check("traces on the backend asked for", NATIVE ? /^native/.test(st.backend) : /WebGPU/.test(st.backend), st.backend);

    const log = await page.evaluate((ms) => new Promise((done) => {
      const host = window.viewport.trace;
      const b = host.backend;
      const log = { cams: [], ups: [], ticks: [], frames: [] };
      const now = () => performance.now();
      const native = typeof b.scene?.camera === "function";
      if (native) {
        const cam = b.scene.camera.bind(b.scene);
        b.scene.camera = (c, lens) => {
          const e = { enq: now(), after: null };
          log.cams.push(e);
          const p = cam(c, lens);
          p.then((v) => { e.after = v; }, () => {});
          return p;
        };
        const up = b.blit.upload.bind(b.blit);
        b.blit.upload = (f) => { log.ups.push({ t: now(), seq: f.seq }); up(f); };
        const next = b.link.next.bind(b.link);
        b.link.next = () => { const t0 = now(); const p = next(); p.then(() => log.frames.push(now() - t0), () => {}); return p; };
      } else {
        const uc = b.updateCamera.bind(b);
        b.updateCamera = (c, l) => { log.cams.push({ enq: now() }); uc(c, l); };
        const rs = b.renderSample.bind(b);
        b.renderSample = (n) => {
          const k = log.cams.length - 1, t0 = now();
          const p = rs(n);
          p.then(() => { log.ups.push({ t: now(), k }); log.frames.push(now() - t0); }, () => {});
          return p;
        };
      }
      const t0 = now();
      const step = () => {
        const moving = now() - t0 < ms;
        if (moving) {
          window.viewport.rig.orbitBy(0.004, 0.001);
          window.viewport.requestRender();
        }
        log.ticks.push({ t: now(), view: native ? !!host.frameView : true, moving });
        if (now() - t0 < ms + 1500) requestAnimationFrame(step);
        else done(log);
      };
      requestAnimationFrame(step);
    }), ORBIT_MS);

    const cams = log.cams;
    const tracedAt = (u) => {
      if (u.k !== undefined) return u.k;
      let k = -1;
      for (let i = 0; i < cams.length; i++) if (cams[i].after !== null && ((u.seq - cams[i].after) | 0) > 0) k = i;
      return k;
    };
    const ups = log.ups.map((u) => ({ ...u, k: tracedAt(u) }));
    const frames = [...log.frames].sort((a, b) => a - b);
    const frame = frames[frames.length >> 1] ?? 0;
    const tick = log.ticks.length > 1 ? (log.ticks.at(-1).t - log.ticks[0].t) / (log.ticks.length - 1) : 16;
    const stop = cams.at(-1)?.enq ?? 0;
    const during = ups.filter((u) => u.k >= 0 && u.t <= stop);
    const age = during.map((u) => u.t - cams[u.k].enq);
    const oldest = age.length ? Math.max(...age) : Infinity;
    const limit = 3 * frame + 2 * tick;
    console.log(`  ${cams.length} cameras, ${ups.length} frames, frame p50 ${frame.toFixed(1)} ms, display frame ${tick.toFixed(1)} ms`);
    check("the orbit sent cameras and drew frames", cams.length > 30 && during.length > 10, `${cams.length} cameras, ${during.length} frames`);
    check("every frame on screen is traced at a camera at most three frames old", oldest <= limit,
      `oldest ${oldest.toFixed(0)} ms, limit ${limit.toFixed(0)} ms`);
    const first = ups[0]?.t ?? Infinity;
    const lost = log.ticks.filter((t) => t.moving && t.t > first + 2 * tick && !t.view).length;
    check("the edges draw with the camera of the frame on screen on every display frame", lost === 0, `${lost} without it`);
    const landed = ups.find((u) => u.k === cams.length - 1 && u.t >= stop);
    const after = landed ? landed.t - stop : Infinity;
    check("the last camera is on screen within three frames of the stop", after <= limit, `${after.toFixed(0)} ms, limit ${limit.toFixed(0)} ms`);

    await settled();
    // Copied in the task that drew it: a WebGPU canvas is blank once presented,
    // and the native frames land in their own upload.
    const boxes = await page.evaluate(async () => {
      const b = window.viewport.trace.backend;
      const traced = await new Promise((ok) => {
        const native = typeof b.blit?.upload === "function";
        const hook = native ? b.blit : b;
        const key = native ? "upload" : "renderSample";
        const own = hook[key];
        hook[key] = function (...a) {
          const r = own.apply(this, a);
          hook[key] = own;
          const c = document.createElement("canvas");
          c.width = b.canvas.width;
          c.height = b.canvas.height;
          const g = c.getContext("2d");
          g.drawImage(b.canvas, 0, 0);
          ok(window.__bodyBox(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height));
          return r;
        };
      });
      const bm = await createImageBitmap(await (await fetch(window.viewport.renderStill(1, { realtime: true }))).blob());
      const r = new OffscreenCanvas(bm.width, bm.height).getContext("2d");
      r.drawImage(bm, 0, 0);
      const realtime = window.__bodyBox(r.getImageData(0, 0, bm.width, bm.height).data, bm.width, bm.height);
      const v = window.viewport.canvas.getBoundingClientRect();
      return { traced, realtime, w: v.width, h: v.height };
    });
    const off = Math.max(...["x0", "x1"].map((k) => Math.abs(boxes.traced[k] - boxes.realtime[k]) * boxes.w),
      ...["y0", "y1"].map((k) => Math.abs(boxes.traced[k] - boxes.realtime[k]) * boxes.h));
    check("at rest the traced box sits within 2 px of the Realtime box", off <= 2, `${off.toFixed(1)} px apart`);
  } finally {
    await browser.close();
  }
})()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    if (serve) { serve.srv.stdin.end(); serve.srv.kill(); }
    console.log(failures ? `FAIL ${failures}` : "PASS");
    process.exitCode = failures ? 1 : 0;
  });
