// The View cube's orthographic views in Path traced, in a real browser.
//
// Two glowing 40 mm cubes at different depths, 1.5 m apart in the front view,
// for the front, right and top views: orthographic, both must be drawn the
// same size, and the traced silhouettes must sit where Realtime draws them. A
// far, narrow perspective stand in shrinks the far cube and moves its edges.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_CHROME=<chrome exe>] [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_TRACER=native-dev] node e2e/pathtrace_ortho_e2e.cjs [outDir]
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
const OUT = path.resolve(process.argv[2] || "pathtrace_ortho_shots");
const NATIVE = process.env.SC_TRACER === "native-dev";
const BACKEND = NATIVE ? /^native/ : /WebGPU/;
const [VW, VH] = (process.env.SC_VIEWPORT || "1200x800").split("x").map(Number);
const target = process.env.CARGO_TARGET_DIR || path.join(__dirname, "..", "src-tauri", "target");
const SERVE =
  process.env.SC_TRACER_SERVE ||
  path.join(target, "release", "examples", process.platform === "win32" ? "tracer_serve.exe" : "tracer_serve");
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
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    // Only the engine's socket: the native frames carry their own token.
    await page.addInitScript(
      ([port, t]) => {
        const N = window.WebSocket;
        window.WebSocket = class extends N {
          constructor(u, p) {
            if (!String(u).includes(":8765/") && !String(u).endsWith(":8765")) {
              super(u, p);
              return;
            }
            let s = String(u).replace(":8765", ":" + port);
            s = s.replace(/([?&])token=[^&]*/, `$1token=${t}`);
            super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
          }
        };
      },
      [PORT, TOKEN],
    );
    await page.goto(url);
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) {
      await modal.click();
      await page.waitForTimeout(300);
    }
    const setPref = (k, v) =>
      page.evaluate(async ([k, v]) => (await import("/src/ui/renderPrefs.ts")).setRenderPref(k, v), [k, v]);
    await setPref("bloom", 0);
    await setPref("denoise", "off");
    await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "box", length: 40, width: 40, height: 40 });
      s.addFeature({ id: s.nextId(), type: "box", length: 40, width: 40, height: 40 });
      s.addFeature({ id: s.nextId(), type: "move", bodies: ["body1"], dx: -60, dy: -60, dz: 60, rx: 0, ry: 0, rz: 0 });
      s.addFeature({ id: s.nextId(), type: "move", bodies: ["body2"], dx: 60, dy: 1500, dz: -60, rx: 0, ry: 0, rz: 0 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 2) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await page.evaluate(() => window.store.setBodiesMaterial(["body1", "body2"], "m-emitter"));
    await page.waitForTimeout(800);
    await page.mouse.move(5, 5);

    const box = await page.evaluate(() => {
      const r = window.viewport.canvas.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    });
    // The panels hidden, so they cover no body.
    const shot = async (name) => {
      const css = await page.addStyleTag({
        content: "body * { visibility: hidden !important } canvas { visibility: visible !important }",
      });
      const buf = await page.screenshot({ clip: box });
      await css.evaluate((e) => e.remove());
      fs.writeFileSync(path.join(OUT, name), buf);
      return "data:image/png;base64," + buf.toString("base64");
    };
    // Each glowing body's box in image pixels: the columns that hold green
    // grouped into runs, then the rows of each run.
    const bodies = (a) =>
      page.evaluate(async (a) => {
        const bm = await createImageBitmap(await (await fetch(a)).blob());
        const c = new OffscreenCanvas(bm.width, bm.height);
        const g = c.getContext("2d");
        g.drawImage(bm, 0, 0);
        const d = g.getImageData(0, 0, bm.width, bm.height).data;
        const W = bm.width,
          H = bm.height;
        const on = (x, y) => {
          const i = (y * W + x) * 4;
          return d[i + 1] - Math.max(d[i], d[i + 2]) > 45;
        };
        const runs = [];
        for (let x = 0; x < W; x++) {
          let any = false;
          for (let y = 0; y < H && !any; y++) any = on(x, y);
          if (!any) continue;
          if (runs.length && runs[runs.length - 1].x1 >= x - 2) runs[runs.length - 1].x1 = x;
          else runs.push({ x0: x, x1: x });
        }
        return runs
          .filter((r) => r.x1 - r.x0 > 4)
          .map(({ x0, x1 }) => {
            let top = H,
              bottom = -1;
            for (let y = 0; y < H; y++)
              for (let x = x0; x <= x1; x++)
                if (on(x, y)) {
                  top = Math.min(top, y);
                  bottom = Math.max(bottom, y);
                }
            return { left: x0, top, w: x1 - x0 + 1, h: bottom - top + 1 };
          });
      }, a);
    const settle = (ms = 1200) =>
      page.evaluate(async (ms) => {
        window.viewport.requestRender();
        await new Promise((r) => setTimeout(r, ms));
      }, ms);
    const waitDone = () =>
      page
        .waitForFunction(
          () => {
            const s = window.viewport.traceStatus;
            return s.state === "done" && s.samples >= 32 ? s : null;
          },
          null,
          { timeout: 240000, polling: 250 },
        )
        .then((h) => h.jsonValue());
    const mode = (m) => page.click(`[data-view-mode="${m}"]`);

    // The front view fits the 1.5 m depth too, so it zooms in on the cubes.
    for (const [view, zoom] of [
      ["front", 6],
      ["right", 0],
      ["top", 0],
    ]) {
      await mode("realtime");
      await page.evaluate((v) => window.__fundacad.handleAction(v), view);
      await page.waitForTimeout(400);
      await page.evaluate(() => window.__fundacad.handleAction("fit"));
      await settle(600);
      for (let i = 0; i < zoom; i++) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(150);
      }
      await page.mouse.move(5, 5);
      await settle(1500);
      const ortho = await page.evaluate(() => !!window.viewport.camera.isOrthographicCamera);
      check(`${view}: Realtime draws it orthographic`, ortho);
      const rt = await bodies(await shot(`rt-${view}.png`));
      await mode("pathtraced");
      const done = await waitDone();
      check(
        `${view}: the tracer runs on ${NATIVE ? "the native tracer" : "WebGPU"}`,
        BACKEND.test(done.backend),
        done.backend,
      );
      await settle(600);
      const pt = await bodies(await shot(`pt-${view}.png`));
      console.log(`  ${view} realtime ${JSON.stringify(rt)}\n  ${view} traced   ${JSON.stringify(pt)}`);
      check(
        `${view}: both cubes are on screen in both modes`,
        rt.length === 2 && pt.length === 2,
        `${rt.length} and ${pt.length}`,
      );
      if (rt.length !== 2 || pt.length !== 2) continue;
      const [a, b] = pt;
      check(
        `${view}: the traced cubes are the same size at both depths`,
        Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2,
        `widths ${a.w} ${b.w}, heights ${a.h} ${b.h}`,
      );
      const off = Math.max(
        ...pt.flatMap((p, i) => [p.left - rt[i].left, p.top - rt[i].top, p.w - rt[i].w, p.h - rt[i].h].map(Math.abs)),
      );
      check(
        `${view}: the traced silhouettes sit where Realtime draws them`,
        off <= 2,
        `largest difference ${off.toFixed(2)} px`,
      );
    }
    const tracedAfter = await page.evaluate(() => window.viewport.traceStatus.backend);
    check("no tracer fault dropped the view to Realtime", BACKEND.test(tracedAfter || ""), tracedAfter);
  } finally {
    await browser.close();
    serve?.srv.kill();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  serve?.srv.kill();
  process.exit(1);
});
