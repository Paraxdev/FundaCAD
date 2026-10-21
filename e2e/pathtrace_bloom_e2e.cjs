// Bloom on the Path traced image, in a real browser on a real WebGPU device.
//
// An emitting cylinder over a plate, traced to the cap with the denoise off:
// moving the Bloom slider must glow around the emitter without restarting the
// samples, back to 0 must give the exact image it started from, the far
// corner (the background, out of the halo) must stay as it was, and the traced
// Picture must glow the same way. Realtime is measured on the same view as the
// control the traced glow is held against, over the halo pixels that are dark
// background in both looks: bloom is added before the tone map, so a lit plate
// near white gains almost nothing in 8 bits and would make the order check
// measure the plate's lighting instead of the glow.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_CHROME=<chrome exe>] [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] node e2e/pathtrace_bloom_e2e.cjs [outDir]
// On a cold vite the first Path traced load optimizes the tracer's modules and
// reloads the page mid run: run it once more on a warm server.
//
// SC_TRACER=native-dev runs the same checks on the native tracer outside the
// app, through tracer_serve (no WebGPU needed, lavapipe will do). The traced
// Picture checks are skipped there, the native tracer saves no Picture yet.
//   cargo build --release --example tracer_serve --manifest-path src-tauri/tracer/Cargo.toml
// SC_TRACER_SERVE points at the example if CARGO_TARGET_DIR moved it,
// SC_VIEWPORT=<w>x<h> shrinks the page for a slow software device.
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "pathtrace_bloom_shots");
const NATIVE = process.env.SC_TRACER === "native-dev";
const BACKEND = NATIVE ? /^native/ : /WebGPU/;
const [VW, VH] = (process.env.SC_VIEWPORT || "1200x800").split("x").map(Number);
const target = process.env.CARGO_TARGET_DIR || path.join(__dirname, "..", "src-tauri", "target");
const SERVE = process.env.SC_TRACER_SERVE
  || path.join(target, "release", "examples", process.platform === "win32" ? "tracer_serve.exe" : "tracer_serve");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
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

let serve = null;
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let url = URL;
  if (NATIVE) {
    serve = startTracerServe();
    const port = await serve.port;
    url += (url.includes("?") ? "&" : "?") + `token=${encodeURIComponent(TOKEN)}&tracer=native-dev&port=${port}`;
  }
  const browser = await chromium.launch({
    ...(EXE ? { executablePath: EXE } : { channel: "chrome" }),
    // The native page still draws Realtime with WebGL, and a runner without a GPU has none unless ANGLE is told to use SwiftShader.
    args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", ...(NATIVE ? ["--use-angle=swiftshader"] : [])],
  });
  try {
    const page = await browser.newPage({ viewport: { width: VW, height: VH } });
    page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
    // Only the engine's socket: the native frames carry their own token.
    await page.addInitScript(([port, t]) => {
      const N = window.WebSocket;
      window.WebSocket = class extends N {
        constructor(u, p) {
          if (!String(u).includes(":8765/") && !String(u).endsWith(":8765")) { super(u, p); return; }
          let s = String(u).replace(":8765", ":" + port);
          s = s.replace(/([?&])token=[^&]*/, `$1token=${t}`);
          super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
        }
      };
    }, [PORT, TOKEN]);
    await page.goto(url);
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) { await modal.click(); await page.waitForTimeout(300); }
    const setPref = (k, v) => page.evaluate(async ([k, v]) => (await import("/src/ui/renderPrefs.ts")).setRenderPref(k, v), [k, v]);
    await setPref("bloom", 0);
    await setPref("denoise", "off");
    await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "box", length: 80, width: 80, height: 6 });
      s.addFeature({ id: s.nextId(), type: "cylinder", radius: 6, height: 40 });
      s.addFeature({ id: s.nextId(), type: "move", bodies: ["body2"], dx: 0, dy: 0, dz: 23, rx: 0, ry: 0, rz: 0 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 2) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await page.evaluate(() => window.__fundacad.handleAction("iso"));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(800);
    await page.evaluate(() => window.store.setBodiesMaterial(["body2"], "m-emitter"));
    await page.waitForTimeout(800);
    await page.mouse.move(5, 5);

    const box = await page.evaluate(() => {
      const r = window.viewport.canvas.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    });
    const shot = async (name) => {
      const buf = await page.screenshot({ clip: box });
      fs.writeFileSync(path.join(OUT, name), buf);
      return "data:image/png;base64," + buf.toString("base64");
    };
    // Max delta and mean gain over a region, the region in image pixels.
    const compare = (a, b, region) => page.evaluate(async ([a, b, region]) => {
      const px = async (s) => {
        const bm = await createImageBitmap(await (await fetch(s)).blob());
        const c = new OffscreenCanvas(bm.width, bm.height);
        const g = c.getContext("2d");
        g.drawImage(bm, 0, 0);
        return { d: g.getImageData(0, 0, bm.width, bm.height).data, w: bm.width, h: bm.height };
      };
      const A = await px(a), B = await px(b);
      const r = region || { x: 0, y: 0, w: A.w, h: A.h };
      let max = 0, sum = 0, n = 0;
      for (let y = Math.max(0, r.y); y < Math.min(A.h, r.y + r.h); y++) {
        for (let x = Math.max(0, r.x); x < Math.min(A.w, r.x + r.w); x++) {
          const i = (y * A.w + x) * 4;
          const d = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]), Math.abs(A.d[i + 2] - B.d[i + 2]));
          if (d > max) max = d;
          sum += (B.d[i] + B.d[i + 1] + B.d[i + 2]) - (A.d[i] + A.d[i + 1] + A.d[i + 2]);
          n++;
        }
      }
      return { max, meanGain: +(sum / Math.max(1, n) / 3).toFixed(3), pixels: n };
    }, [a, b, region]);
    // Mean gain of both looks over the region's pixels darker than 48 in both bloom 0 images.
    const darkGain = (a0, a1, b0, b1, region) => page.evaluate(async ([a0, a1, b0, b1, r]) => {
      const px = async (s) => {
        const bm = await createImageBitmap(await (await fetch(s)).blob());
        const c = new OffscreenCanvas(bm.width, bm.height);
        const g = c.getContext("2d");
        g.drawImage(bm, 0, 0);
        return { d: g.getImageData(0, 0, bm.width, bm.height).data, w: bm.width, h: bm.height };
      };
      const [A0, A1, B0, B1] = await Promise.all([a0, a1, b0, b1].map(px));
      const sum = (P, i) => P.d[i] + P.d[i + 1] + P.d[i + 2];
      const peak = (P, i) => Math.max(P.d[i], P.d[i + 1], P.d[i + 2]);
      let sa = 0, sb = 0, n = 0;
      for (let y = Math.max(0, r.y); y < Math.min(A0.h, r.y + r.h); y++) {
        for (let x = Math.max(0, r.x); x < Math.min(A0.w, r.x + r.w); x++) {
          const i = (y * A0.w + x) * 4;
          if (peak(A0, i) >= 48 || peak(B0, i) >= 48) continue;
          sa += sum(A1, i) - sum(A0, i);
          sb += sum(B1, i) - sum(B0, i);
          n++;
        }
      }
      return { realtime: +(sa / Math.max(1, n) / 3).toFixed(3), traced: +(sb / Math.max(1, n) / 3).toFixed(3), pixels: n };
    }, [a0, a1, b0, b1, region]);
    // The emitter's centre: the saturated green of #42e07a once tone mapped.
    const emitterAt = (a) => page.evaluate(async (a) => {
      const bm = await createImageBitmap(await (await fetch(a)).blob());
      const c = new OffscreenCanvas(bm.width, bm.height);
      const g = c.getContext("2d");
      g.drawImage(bm, 0, 0);
      const d = g.getImageData(0, 0, bm.width, bm.height).data;
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 1] > 230 && d[i] < 200 && d[i + 2] < 220) { const p = i / 4; sx += p % bm.width; sy += Math.floor(p / bm.width); n++; }
      }
      return n ? { x: Math.round(sx / n), y: Math.round(sy / n), n } : null;
    }, a);
    const settle = (ms = 1200) => page.evaluate(async (ms) => { window.viewport.requestRender(); await new Promise((r) => setTimeout(r, ms)); }, ms);
    const waitDone = () => page.waitForFunction(() => {
      const s = window.viewport.traceStatus;
      return s.state === "done" && s.samples >= 256 ? s : null;
    }, null, { timeout: 240000, polling: 250 }).then((h) => h.jsonValue());

    // Background only, clear of the panels and 400 px from the emitter.
    const corner = { x: Math.round(950 * VW / 1200), y: Math.round(560 * VH / 800), w: 60, h: 60 };

    await settle();
    const rt0 = await shot("rt-bloom0.png");
    await setPref("bloom", 0.6);
    await settle(2000);
    const rt6 = await shot("rt-bloom06.png");
    const em = await emitterAt(rt0);
    check("the emitter is on screen", !!em, JSON.stringify(em));
    const halo = em ? { x: em.x - 120, y: em.y - 160, w: 240, h: 320 } : corner;
    const rtHalo = await compare(rt0, rt6, halo);
    const rtCorner = await compare(rt0, rt6, corner);
    console.log("  realtime control: halo", JSON.stringify(rtHalo), "corner", JSON.stringify(rtCorner));

    await setPref("bloom", 0);
    await settle();
    // A software WebGL renderer reads as a low powered computer, which greys Path traced until a second click lifts it.
    const pt = '[data-view-mode="pathtraced"]';
    if ((await page.getAttribute(pt, "aria-disabled")) === "true") await page.click(pt, { force: true });
    await page.click(pt, { force: true });
    const done = await waitDone();
    check(`the tracer runs on ${NATIVE ? "the native tracer" : "WebGPU"}`, BACKEND.test(done.backend), done.backend);
    await settle();
    const pt0 = await shot("pt-bloom0.png");
    const s0 = done.samples;

    await setPref("bloom", 0.6);
    await settle(1500);
    const pt6 = await shot("pt-bloom06.png");
    const st = await page.evaluate(() => window.viewport.traceStatus);
    const ptHalo = await compare(pt0, pt6, halo);
    const ptCorner = await compare(pt0, pt6, corner);
    check("bloom 0.6 glows around the emitter in Path traced", ptHalo.meanGain > 1, JSON.stringify(ptHalo));
    const dark = await darkGain(rt0, rt6, pt0, pt6, halo);
    check("the glow is of Realtime's order", dark.pixels > 5000 && dark.traced > dark.realtime / 5 && dark.traced < dark.realtime * 4,
      `traced ${dark.traced}, realtime ${dark.realtime} over ${dark.pixels} dark pixels`);
    check("the slider redraws without restarting the samples", st.samples === s0 && st.state === "done", `${s0} -> ${st.samples}`);
    check("the background out of the halo is unchanged", ptCorner.max <= Math.max(1, rtCorner.max), JSON.stringify(ptCorner));

    await setPref("bloom", 0);
    await settle(1500);
    const pt0again = await shot("pt-bloom0-again.png");
    const back = await compare(pt0, pt0again);
    check("bloom back to 0 is the exact image it started from", back.max === 0, JSON.stringify(back));

    const picture = async (amount, name) => {
      await setPref("bloom", amount);
      await settle(300);
      const url = await page.evaluate(() => window.viewport.renderTracedPicture({ scale: 1, samples: 64 }));
      fs.writeFileSync(path.join(OUT, name), Buffer.from(url.split(",")[1], "base64"));
      await waitDone();
      return url;
    };
    if (NATIVE) {
      console.log("  skip  the traced Picture, the native tracer saves none yet");
    } else {
      const pic0 = await picture(0, "picture-bloom0.png");
      const pic6 = await picture(0.6, "picture-bloom06.png");
      const picHalo = await compare(pic0, pic6, halo);
      const picCorner = await compare(pic0, pic6, corner);
      check("the traced Picture glows at 0.6", picHalo.meanGain > 1, JSON.stringify(picHalo));
      check("the Picture's background out of the halo is unchanged", picCorner.max <= Math.max(2, rtCorner.max), JSON.stringify(picCorner));
    }

    const tracedAfter = await page.evaluate(() => window.viewport.traceStatus.backend);
    check("no tracer fault dropped the view to Realtime", BACKEND.test(tracedAfter || ""), tracedAfter);
  } finally {
    await browser.close();
    serve?.srv.kill();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); serve?.srv.kill(); process.exit(1); });
