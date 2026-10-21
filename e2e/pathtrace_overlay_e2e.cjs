// The overlay over a traced picture, in a real browser: edges, the grid, the
// triad, selection, hover, the Move gizmo and the toggles that hide them must
// draw over Path traced exactly as over Realtime, and stay on the traced bodies.
//
// Per state the WebGL frame is grabbed in the task that drew it: Realtime with
// overlays (A), Realtime in Clean view (B) and the overlay frame of Path traced
// (P). P over B must equal A to within a few pixels. Then three arrow key view
// steps must restart the trace on the new view, an orbit with Realtime while
// moving off must keep the edges on the trace mid drag, and an HDR shown behind
// must not paint the overlay frame opaque over the trace.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_CHROME=<chrome exe>] [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_TRACER=native-dev] node e2e/pathtrace_overlay_e2e.cjs [outDir]
// SC_TRACER=native-dev traces on the native tracer through tracer_serve:
//   cargo build --release --example tracer_serve --manifest-path src-tauri/tracer/Cargo.toml
// SC_TRACER_SERVE points at the example if CARGO_TARGET_DIR moved it. A vite
// port other than 5173 needs FUNDACAD_EXTRA_ORIGINS for the engine and here.
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "pathtrace_overlay_shots");
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

// A sky and ground panorama with a bright sun, as a Radiance HDR.
function panorama(w, h) {
  const head = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`, "latin1");
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const el = (0.5 - (y + 0.5) / h) * Math.PI;
    for (let x = 0; x < w; x++) {
      const az = ((x + 0.5) / w) * 2 * Math.PI;
      let c = el > 0 ? [0.25, 0.45, 1.2] : [0.12, 0.5, 0.08];
      const dAz = Math.min(Math.abs(az - Math.PI / 2), 2 * Math.PI - Math.abs(az - Math.PI / 2));
      if (Math.hypot(dAz * Math.cos(el), el - 0.6) < 0.08) c = [60, 30, 6];
      const m = Math.max(...c);
      const e = Math.floor(Math.log2(m)) + 1;
      const s = 256 / 2 ** e;
      const o = (y * w + x) * 4;
      px[o] = Math.min(255, Math.floor(c[0] * s));
      px[o + 1] = Math.min(255, Math.floor(c[1] * s));
      px[o + 2] = Math.min(255, Math.floor(c[2] * s));
      px[o + 3] = e + 128;
    }
  }
  return Buffer.concat([head, px]);
}

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
    args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"],
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
    const viewMode = (fn, ...a) => page.evaluate(async ([fn, a]) => (await import("/src/ui/viewMode.ts"))[fn](...a), [fn, a]);
    await setPref("bloom", 0);
    await setPref("denoise", "off");
    await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "box", length: 60, width: 40, height: 30 });
      s.addFeature({ id: s.nextId(), type: "box", length: 20, width: 20, height: 50 });
      s.addFeature({ id: s.nextId(), type: "move", bodies: ["body2"], dx: 55, dy: 0, dz: 10, rx: 0, ry: 0, rz: 0 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 2) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await page.waitForTimeout(800);
    await page.mouse.move(5, 5);
    const box = await page.evaluate(() => {
      const r = window.viewport.canvas.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    });
    const mode = (m) => page.$eval(`[data-view-mode="${m}"]`, (b) => b.click());
    const settle = (ms = 600) => page.evaluate(async (ms) => { window.viewport.requestRender(); await new Promise((r) => setTimeout(r, ms)); }, ms);
    const waitShown = () => page.waitForFunction(() => {
      const s = window.viewport.traceStatus;
      return s.shown && s.samples >= 16 ? s : null;
    }, null, { timeout: 240000, polling: 250 }).then((h) => h.jsonValue());
    const save = (name, png) => fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(png.split(",")[1], "base64"));
    // One forced frame of the WebGL canvas, read back before the browser composites another.
    const grab = async (name) => save(name, await page.evaluate((name) => {
      const vp = window.viewport;
      vp.scene.post.render(vp.rig.active);
      const c = document.createElement("canvas");
      c.width = vp.canvas.width;
      c.height = vp.canvas.height;
      const g = c.getContext("2d");
      g.drawImage(vp.canvas, 0, 0);
      (window.__grabs ??= {})[name] = g.getImageData(0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    }, name));
    // P over B against A: pixels more than 24 of 255 off in any channel, and how
    // many pixels each draws as overlay.
    const compare = (a, b, p) => page.evaluate(([a, b, p]) => {
      const A = window.__grabs[a], B = window.__grabs[b], P = window.__grabs[p];
      let wrong = 0, rt = 0, pt = 0;
      for (let k = 0; k < A.data.length; k += 4) {
        const al = P.data[k + 3] / 255;
        let dm = 0, dr = 0;
        for (let c = 0; c < 3; c++) {
          dm = Math.max(dm, Math.abs(P.data[k + c] * al + B.data[k + c] * (1 - al) - A.data[k + c]));
          dr = Math.max(dr, Math.abs(A.data[k + c] - B.data[k + c]));
        }
        if (dm > 24) wrong++;
        if (dr > 24) rt++;
        if (P.data[k + 3] > 8) pt++;
      }
      return { wrong, rt, pt, px: A.width * A.height };
    }, [a, b, p]);
    const home = async () => {
      await mode("realtime");
      await page.evaluate(() => { window.viewport.setSelectedBodies([]); window.__fundacad.handleAction("iso"); });
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__fundacad.handleAction("fit"));
      await page.mouse.move(5, 5);
      await settle(600);
    };

    const states = [
      { name: "rest", setup: async () => {} },
      { name: "selected", setup: () => page.evaluate(() => window.viewport.setSelectedBodies(["body1"])) },
      { name: "hover", setup: async () => {
        const at = await page.evaluate(() => {
          const vp = window.viewport, r = vp.canvas.getBoundingClientRect();
          const m = new vp.rig.active.position.constructor(0, 0, 30).project(vp.rig.active);
          return { x: r.left + (m.x + 1) / 2 * r.width, y: r.top + (1 - m.y) / 2 * r.height };
        });
        await page.mouse.move(at.x, at.y);
        await page.waitForTimeout(300);
      } },
      { name: "gizmo", setup: async () => {
        await page.evaluate(() => window.viewport.setSelectedBodies(["body1"]));
        await page.evaluate(() => window.__fundacad.handleAction("move"));
        await page.waitForTimeout(300);
      }, undo: async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(200); } },
      { name: "front-ortho", setup: async () => {
        await page.evaluate(() => window.__fundacad.handleAction("front"));
        await page.waitForTimeout(400);
        await page.evaluate(() => window.__fundacad.handleAction("fit"));
      } },
      { name: "edges-off", setup: () => viewMode("setOverlay", "edges", false), undo: () => viewMode("setOverlay", "edges", true) },
    ];
    for (const st of states) {
      await home();
      await st.setup();
      await settle(800);
      await grab(`${st.name}-rt-on`);
      await viewMode("setOverlaysOn", false);
      await settle(400);
      await grab(`${st.name}-rt-clean`);
      await viewMode("setOverlaysOn", true);
      await settle(400);
      await mode("pathtraced");
      const done = await waitShown();
      check(`${st.name}: the tracer runs on ${NATIVE ? "the native tracer" : "WebGPU"}`, BACKEND.test(done.backend), done.backend);
      await settle(400);
      await grab(`${st.name}-pt-overlay`);
      const c = await compare(`${st.name}-rt-on`, `${st.name}-rt-clean`, `${st.name}-pt-overlay`);
      check(`${st.name}: Realtime draws an overlay to compare`, st.name === "edges-off" || c.rt > 500, `${c.rt} px`);
      check(`${st.name}: the Path traced overlay draws what Realtime draws`, c.wrong <= c.px * 0.001,
        `${c.wrong} of ${c.px} px off, Realtime ${c.rt} px, Path traced ${c.pt} px`);
      await st.undo?.();
    }

    // Clean view hides every overlay over the trace too.
    await home();
    await viewMode("setOverlaysOn", false);
    await mode("pathtraced");
    await waitShown();
    await settle(400);
    await grab("clean-pt-overlay");
    const cleanPx = await page.evaluate(() => {
      const P = window.__grabs["clean-pt-overlay"];
      let n = 0;
      for (let k = 3; k < P.data.length; k += 4) if (P.data[k] > 8) n++;
      return n;
    });
    check("Clean view draws no overlay over the trace", cleanPx <= 50, `${cleanPx} px`);
    await viewMode("setOverlaysOn", true);

    // Arrow key steps move the camera outside the rig's damped update. Glowing
    // bodies on a light theme without the grid: the traced silhouette is the
    // green, the edges the near black.
    await page.evaluate(async () => (await import("/src/ui/theme.ts")).setTheme("solarized-light"));
    await page.evaluate(() => window.store.setBodiesMaterial(["body1", "body2"], "m-emitter"));
    await viewMode("setOverlay", "grid", false);
    const hide = await page.addStyleTag({ content: "body * { visibility: hidden !important } canvas { visibility: visible !important }" });
    const offset = async (name) => {
      const buf = await page.screenshot({ clip: box });
      fs.writeFileSync(path.join(OUT, name + ".png"), buf);
      return page.evaluate(async (a) => {
        const bm = await createImageBitmap(await (await fetch(a)).blob());
        const c = new OffscreenCanvas(bm.width, bm.height);
        const g = c.getContext("2d");
        g.drawImage(bm, 0, 0);
        const d = g.getImageData(0, 0, bm.width, bm.height).data;
        const bb = () => ({ x0: bm.width, y0: bm.height, x1: -1, y1: -1 });
        const green = bb(), dark = bb();
        const add = (b, x, y) => { b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y); };
        for (let y = 0; y < bm.height; y++) for (let x = 0; x < bm.width; x++) {
          const i = (y * bm.width + x) * 4;
          if (d[i + 1] - Math.max(d[i], d[i + 2]) > 45) add(green, x, y);
          if (d[i] + d[i + 1] + d[i + 2] < 90) add(dark, x, y);
        }
        if (green.x1 < 0 || dark.x1 < 0) return null;
        return Math.max(Math.abs(green.x0 - dark.x0), Math.abs(green.x1 - dark.x1), Math.abs(green.y0 - dark.y0), Math.abs(green.y1 - dark.y1));
      }, "data:image/png;base64," + buf.toString("base64"));
    };
    for (const rtm of [true, false]) {
      await setPref("realtimeWhileMoving", rtm);
      await home();
      await mode("pathtraced");
      await waitShown();
      await settle(1500);
      const rest = await offset(`keys-${rtm}-rest`);
      for (let k = 0; k < 3; k++) {
        await page.evaluate(() => window.__fundacad.handleAction("view-step-left"));
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(500);
      await waitShown();
      await settle(1500);
      const after = await offset(`keys-${rtm}-after`);
      check(`arrow key steps, Realtime while moving ${rtm ? "on" : "off"}: the trace follows the new view`,
        rest !== null && after !== null && after <= 4, `edges to traced bodies ${rest} px at rest, ${after} px after`);
    }
    // An orbit with Realtime while moving off: the trace on screen is a frame or
    // two behind the mouse, so the edges over it must be drawn from its camera.
    await home();
    await mode("pathtraced");
    await waitShown();
    await settle(1500);
    const still = await offset("drag-rest");
    const cx = box.x + box.width * 0.75, cy = box.y + box.height * 0.8;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    const during = [];
    for (let k = 0, x = cx; k < 6; k++) {
      for (let q = 0; q < 6; q++) {
        x -= 6;
        await page.mouse.move(x, cy);
        await page.waitForTimeout(16);
      }
      during.push(await offset(`drag-${k}`));
    }
    await page.mouse.up({ button: "right" });
    const worst = during.includes(null) ? null : Math.max(...during);
    check("an orbit with Realtime while moving off: the edges stay on the traced bodies mid drag",
      still !== null && worst !== null && worst - still < 2, `${still} px at rest, ${during.join(", ")} px mid drag`);
    await hide.evaluate((e) => e.remove());
    await setPref("realtimeWhileMoving", true);
    await viewMode("setOverlay", "grid", true);

    // An HDR behind: the tracer draws the panorama, the overlay frame must stay clear.
    await home();
    await page.evaluate(async () => (await import("/src/ui/workspace.ts")).setWorkspace("render"));
    await page.waitForTimeout(800);
    await page.setInputFiles("[data-env-file]", { name: "test-sky.hdr", mimeType: "image/vnd.radiance", buffer: panorama(512, 256) });
    await page.waitForFunction(() => /^hdr:/.test(JSON.parse(localStorage.getItem("fundacad.render") || "{}").environment || ""), null, { timeout: 20000 });
    await page.$eval("[data-env-behind]", (b) => b.click());
    await settle(2500);
    await page.mouse.move(5, 5);
    await mode("pathtraced");
    await waitShown();
    await settle(600);
    await grab("hdr-pt-overlay");
    const opaque = await page.evaluate(() => {
      const P = window.__grabs["hdr-pt-overlay"];
      let n = 0;
      for (let k = 3; k < P.data.length; k += 4) if (P.data[k] > 250) n++;
      return { share: n / (P.width * P.height), behind: !!window.viewport.scene.scene.background };
    });
    check("an HDR shown behind is in the Realtime scene", opaque.behind);
    check("the overlay frame stays clear over a trace with an HDR behind", opaque.share < 0.1, `${(opaque.share * 100).toFixed(1)} % opaque`);

    const tracedAfter = await page.evaluate(() => window.viewport.traceStatus.backend);
    check("no tracer fault dropped the view to Realtime", BACKEND.test(tracedAfter || ""), tracedAfter);
  } finally {
    await browser.close();
    serve?.srv.kill();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); serve?.srv.kill(); process.exit(1); });
