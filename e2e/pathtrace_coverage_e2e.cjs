// Path traced fills the whole view at the view's aspect and its samples add up,
// at the start, after a resize to a tall window, with Realtime while moving
// unticked and ticked again, and after an orbit. The traced box must sit within
// 2 px of the Realtime box. On WebGPU the restart's preview, with the frame
// budget pinned at its floor, must cover every row: a preview with more pixels
// than path slots traced only a band across the middle.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_CHROME=<chrome exe>] [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_TRACER=native-dev] [SC_DPR=1.25] [SC_VIEWPORT=1600x1000] \
//     node e2e/pathtrace_coverage_e2e.cjs [outDir]
// SC_TRACER=native-dev traces on the native tracer through tracer_serve, see
// e2e/pathtrace_moving_e2e.cjs for how to build it.
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "pathtrace_coverage_shots");
const NATIVE = process.env.SC_TRACER === "native-dev";
const BACKEND = NATIVE ? /^native/ : /WebGPU/;
const DPR = Number(process.env.SC_DPR || "1");
const [VW, VH] = (process.env.SC_VIEWPORT || "1600x1000").split("x").map(Number);
const target = process.env.CARGO_TARGET_DIR || path.join(__dirname, "..", "src-tauri", "target");
const SERVE =
  process.env.SC_TRACER_SERVE ||
  path.join(target, "release", "examples", process.platform === "win32" ? "tracer_serve.exe" : "tracer_serve");
const FLOOR_SLOTS = 16384;
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
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

// Runs in the page: the box of the pixels unlike the corner, as fractions of the image.
function bodyBoxSrc() {
  return `(d, w, h) => {
    const bg = [d[0], d[1], d[2]];
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 60) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    let blackRows = 0;
    for (let y = 0; y < h; y++) {
      let lit = false;
      for (let x = 0; x < w && !lit; x++) { const i = (y * w + x) * 4; lit = d[i] + d[i + 1] + d[i + 2] > 3; }
      if (!lit) blackRows++;
    }
    return { w, h, x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h, blackRows };
  }`;
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
    const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR });
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    await page.addInitScript(
      ([port, t, box]) => {
        window.__bodyBox = (0, eval)(box);
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
      [PORT, TOKEN, bodyBoxSrc()],
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
    await setPref("realtimeWhileMoving", true);
    // The background traced with the rest, as the user who saw the band had it,
    // so a pixel the preview never reached is black rather than the backdrop.
    await setPref("environment", "none");
    await setPref("envBackground", true);
    await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "box", length: 60, width: 40, height: 30 });
      s.addFeature({ id: s.nextId(), type: "cylinder", radius: 12, height: 50 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 1) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await page.evaluate(() => window.__fundacad.handleAction("iso"));
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(600);
    await page.mouse.move(5, 5);
    // No cap, so a fast GPU is still drawing frames when one is read back.
    await page.evaluate(() => {
      window.viewport.trace.cap = 1e6;
    });
    await page.click('[data-view-mode="pathtraced"]');

    const canvasBox = () =>
      page.evaluate(() => {
        const r = window.viewport.canvas.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    const waitSamples = (n) =>
      page
        .waitForFunction(
          (n) => {
            const s = window.viewport.traceStatus;
            return s.shown && s.samples >= n ? s : null;
          },
          n,
          { timeout: 180000, polling: 100 },
        )
        .then((h) => h.jsonValue());
    // The traced canvas copied in the task that drew it: a WebGPU canvas is
    // blank once presented, and the native frames land in their own upload.
    const traced = () =>
      page.evaluate(
        () =>
          new Promise((ok) => {
            const b = window.viewport.trace.backend;
            const read = () => {
              const c = document.createElement("canvas");
              c.width = b.canvas.width;
              c.height = b.canvas.height;
              const g = c.getContext("2d");
              g.drawImage(b.canvas, 0, 0);
              return window.__bodyBox(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
            };
            const native = typeof b.blit?.upload === "function";
            const hook = native ? b.blit : b;
            const key = native ? "upload" : "renderSample";
            const own = hook[key];
            hook[key] = function (...a) {
              const r = own.apply(this, a);
              hook[key] = own;
              ok(read());
              return r;
            };
            setTimeout(() => {
              hook[key] = own;
              ok(null);
            }, 5000);
          }),
      );
    const realtime = () =>
      page.evaluate(async () => {
        const bm = await createImageBitmap(
          await (await fetch(window.viewport.renderStill(1, { realtime: true }))).blob(),
        );
        const c = new OffscreenCanvas(bm.width, bm.height);
        const g = c.getContext("2d");
        g.drawImage(bm, 0, 0);
        return window.__bodyBox(g.getImageData(0, 0, bm.width, bm.height).data, bm.width, bm.height);
      });
    const px = (b, c) => ({ x0: b.x0 * c.width, y0: b.y0 * c.height, x1: b.x1 * c.width, y1: b.y1 * c.height });
    const fmt = (b) => `${b.x0.toFixed(1)},${b.y0.toFixed(1)} to ${b.x1.toFixed(1)},${b.y1.toFixed(1)}`;

    const covers = async (tag) => {
      const st = await waitSamples(17);
      const c = await canvasBox();
      const t = await traced();
      const r = await realtime();
      if (!t) return check(`${tag}: a traced frame was drawn`, false);
      const tc = px(t, c),
        rc = px(r, c);
      const off = Math.max(...["x0", "y0", "x1", "y1"].map((k) => Math.abs(tc[k] - rc[k])));
      const style = await page.evaluate(() => {
        const s = window.viewport.trace.backend.canvas.getBoundingClientRect();
        return { x: s.x, y: s.y, width: s.width, height: s.height };
      });
      const shown = Math.max(
        Math.abs(style.x - c.x),
        Math.abs(style.y - c.y),
        Math.abs(style.width - c.width),
        Math.abs(style.height - c.height),
      );
      check(
        `${tag}: the traced canvas covers the view`,
        shown <= 1,
        `traced ${JSON.stringify(style)}, view ${JSON.stringify(c)}`,
      );
      check(
        `${tag}: the trace is at the view's aspect`,
        Math.abs(t.w / t.h - c.width / c.height) < 0.01,
        `trace ${t.w}x${t.h}, view ${c.width}x${c.height}`,
      );
      check(
        `${tag}: the traced bodies sit within 2 px of Realtime's`,
        off <= 2,
        `traced ${fmt(tc)}, realtime ${fmt(rc)}, off ${off.toFixed(1)} px`,
      );
      check(`${tag}: the samples rise past 16`, st.samples > 16, `${st.samples} on ${st.backend}`);
      await page.screenshot({ path: path.join(OUT, `${tag}.png`) });
    };
    // WebGPU only, and only with Realtime while moving unticked: the native
    // tracer draws no preview.
    const preview = async (tag) => {
      const c = await canvasBox();
      const r = px(await realtime(), c);
      return previewAt(tag, c, r);
    };
    const previewAt = (tag, c, r) =>
      page
        .evaluate(
          (slots) =>
            new Promise((ok) => {
              const h = window.viewport.trace;
              const b = h.backend;
              const t = b.tracer;
              const learn = h.budget.frame;
              h.budget.frame = () => false;
              b.setFrameBudget(slots);
              const own = b.renderSample;
              const done = (v) => {
                b.renderSample = own;
                h.budget.frame = learn;
                b.setFrameBudget(h.budget.budget);
                ok(v);
              };
              b.renderSample = function (n) {
                const first = t._resetTime === -1;
                const r = own.call(this, n);
                if (!first) return r;
                const c = document.createElement("canvas");
                c.width = b.canvas.width;
                c.height = b.canvas.height;
                const g = c.getContext("2d");
                g.drawImage(b.canvas, 0, 0);
                const img = window.__bodyBox(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
                const out = t._pathTracer.outputTarget.image;
                done({
                  img,
                  pixels: out.width * out.height,
                  rays: t._pathTracer.rayCount,
                  scale: t.lowResScale,
                  renderScale: t.renderScale,
                  png: c.toDataURL("image/png"),
                });
                return r;
              };
              setTimeout(() => done(null), 5000);
              h.restart();
            }),
          FLOOR_SLOTS,
        )
        .then((p) => {
          if (!p) return check(`${tag}: a preview frame was drawn`, false);
          fs.writeFileSync(
            path.join(OUT, `preview-${tag.replace(/ /g, "-")}.png`),
            Buffer.from(p.png.split(",")[1], "base64"),
          );
          check(
            `${tag}: the preview at the floor budget has no more pixels than path slots`,
            p.pixels <= FLOOR_SLOTS && p.rays >= p.pixels,
            `${p.pixels} pixels, ${p.rays} rays, scale ${p.scale.toFixed(3)}`,
          );
          check(
            `${tag}: the preview covers every row`,
            p.img.blackRows === 0,
            `${p.img.blackRows} of ${p.img.h} rows black`,
          );
          const texel = 1 / (p.renderScale * p.scale);
          const pc = px(p.img, c);
          const off = Math.max(...["x0", "y0", "x1", "y1"].map((k) => Math.abs(pc[k] - r[k])));
          check(
            `${tag}: the preview's bodies sit within 2 of its texels of Realtime's`,
            off <= 2 * texel,
            `preview ${fmt(pc)}, realtime ${fmt(r)}, off ${off.toFixed(1)} px, texel ${texel.toFixed(1)} px`,
          );
        });
    const orbit = async () => {
      const c = await canvasBox();
      const cx = c.x + c.width / 2,
        cy = c.y + c.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button: "right" });
      for (let i = 1; i <= 20; i++) {
        await page.mouse.move(cx + i * 8, cy + i * 2);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      }
      await page.mouse.up({ button: "right" });
      await page.mouse.move(5, 5);
    };

    console.log(`${NATIVE ? "native" : "WebGPU"}, DPR ${DPR}, ${VW}x${VH}`);
    await covers("start");
    await setPref("realtimeWhileMoving", false);
    if (!NATIVE) await preview("unticked");
    await covers("unticked");
    await orbit();
    await covers("unticked orbit");
    await page.setViewportSize({ width: Math.round(VH * 0.6), height: VH });
    await page.waitForTimeout(500);
    if (!NATIVE) await preview("unticked tall");
    await covers("unticked tall");
    await setPref("realtimeWhileMoving", true);
    await covers("ticked tall");
    await page.setViewportSize({ width: VW, height: VH });
    await page.waitForTimeout(500);
    await covers("ticked wide");
    await orbit();
    await covers("ticked orbit");
    const st = await page.evaluate(() => window.viewport.traceStatus.backend);
    check("no tracer fault changed the backend", BACKEND.test(st || ""), st);
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
