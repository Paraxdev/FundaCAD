// Path traced's Realtime while moving switch, in a real browser.
//
// Ticked (the default), an orbit draws the Realtime look and the trace counts
// up again once the view rests. Unticked from the Display popover, the trace
// stays up through the orbit, restarts on every move, and no Realtime frame is
// drawn. Screenshots of the popover in a dark and a light theme.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_CHROME=<chrome exe>] [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_TRACER=native-dev] node e2e/pathtrace_moving_e2e.cjs [outDir]
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
const OUT = path.resolve(process.argv[2] || "pathtrace_moving_shots");
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
    const pref = (k) => page.evaluate(async (k) => (await import("/src/ui/renderPrefs.ts")).renderPrefs()[k], k);
    await setPref("bloom", 0);
    await setPref("denoise", "off");
    await setPref("realtimeWhileMoving", true);
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
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(600);
    await page.mouse.move(5, 5);

    const box = await page.evaluate(() => {
      const r = window.viewport.canvas.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    });
    const status = () => page.evaluate(() => window.viewport.traceStatus);
    const waitSamples = (n) =>
      page
        .waitForFunction(
          (n) => {
            const s = window.viewport.traceStatus;
            return s.shown && s.samples >= n ? s : null;
          },
          n,
          { timeout: 120000, polling: 100 },
        )
        .then((h) => h.jsonValue());
    const shots = {};
    const shot = async (name) => {
      const buf = await page.screenshot({ clip: box });
      fs.writeFileSync(path.join(OUT, name), buf);
      shots[name] = buf;
    };
    // The share of the view lit like the pale box, against the dark ground.
    const litShare = (name) =>
      page.evaluate(
        async (a) => {
          const bm = await createImageBitmap(await (await fetch(a)).blob());
          const c = new OffscreenCanvas(bm.width, bm.height);
          const g = c.getContext("2d");
          g.drawImage(bm, 0, 0);
          const d = g.getImageData(0, 0, bm.width, bm.height).data;
          let lit = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 450) lit++;
          return lit / (d.length / 4);
        },
        "data:image/png;base64," + shots[name].toString("base64"),
      );
    // The traced canvas copied in the task that drew it, the share of it lit
    // like the pale box against the dark ground.
    const tracedLit = () =>
      page.evaluate(
        () =>
          new Promise((ok) => {
            const b = window.viewport.trace.backend;
            const own = b.renderSample;
            b.renderSample = function (n) {
              const p = own.call(this, n);
              b.renderSample = own;
              const c = document.createElement("canvas");
              c.width = b.canvas.width;
              c.height = b.canvas.height;
              const g = c.getContext("2d");
              g.drawImage(b.canvas, 0, 0);
              const d = g.getImageData(0, 0, c.width, c.height).data;
              let lit = 0;
              for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 450) lit++;
              ok({ lit: lit / (d.length / 4), samples: window.viewport.traceStatus.samples });
              return p;
            };
            setTimeout(() => ok(null), 3000);
          }),
      );
    const lit = {};
    // A right drag orbits; each step is read back two frames after it moved.
    const orbit = async (tag, steps = 30) => {
      const reads = [];
      const cx = box.x + box.width / 2,
        cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button: "right" });
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(cx + i * 8, cy + i * 2);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        reads.push(await status());
        if (i === Math.floor(steps / 2)) {
          if (tag === "off") lit[tag] = await tracedLit();
          await shot(`orbit-${tag}.png`);
        }
      }
      await page.mouse.up({ button: "right" });
      await page.mouse.move(5, 5);
      return reads;
    };
    const openDisplay = async () => {
      await page.click('[title="Display"]');
      await page.waitForSelector("[data-pt-moving]", { timeout: 5000 });
    };
    const ticked = () =>
      page.$eval(
        "[data-pt-moving]",
        (e) => e.getAttribute("aria-checked") ?? e.querySelector("[aria-checked]")?.getAttribute("aria-checked"),
      );

    await page.click('[data-view-mode="pathtraced"]');
    let s = await waitSamples(8);
    check(`the tracer runs on ${NATIVE ? "the native tracer" : "WebGPU"}`, BACKEND.test(s.backend), s.backend);

    await openDisplay();
    check("Realtime while moving is ticked by default", (await ticked()) === "true", String(await ticked()));
    for (const theme of ["fundacad", "solarized-light"]) {
      await page.evaluate(async (t) => (await import("/src/ui/theme.ts")).setTheme(t), theme);
      await page.waitForTimeout(400);
      fs.writeFileSync(path.join(OUT, `display-${theme}.png`), await page.screenshot());
    }
    await page.evaluate(async () => (await import("/src/ui/theme.ts")).setTheme("fundacad"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Ticked: Realtime while the view moves, the trace once it rests.
    await waitSamples(8);
    // Watched from before the release: the Realtime copy over the trace, part faded.
    const fading = page.evaluate(
      () =>
        new Promise((ok) => {
          const until = performance.now() + 4000;
          const look = () => {
            const mid = [...window.viewport.canvas.parentElement.querySelectorAll("canvas")].some((c) => {
              const o = Number(c.style.opacity);
              return (
                c !== window.viewport.canvas && c.style.display !== "none" && c.style.opacity !== "" && o > 0 && o < 1
              );
            });
            if (mid) ok(true);
            else if (performance.now() > until) ok(false);
            else requestAnimationFrame(look);
          };
          look();
        }),
    );
    let reads = await orbit("on");
    const moving = reads.slice(2);
    check(
      "ticked: every orbit frame shows Realtime",
      moving.every((r) => r.state === "moving" && !r.shown),
      `states ${[...new Set(moving.map((r) => r.state))].join(",")}, shown ${moving.filter((r) => r.shown).length} of ${moving.length}`,
    );
    check(
      "ticked: Realtime frames are drawn during the orbit",
      reads[reads.length - 1].realtimeFrames > reads[0].realtimeFrames,
      `${reads[0].realtimeFrames} to ${reads[reads.length - 1].realtimeFrames}`,
    );
    const back = await waitSamples(1).catch(() => null);
    check("ticked: the trace is back after the view rests", !!back);
    check("ticked: the Realtime picture fades out over the trace", await fading);
    const a = (await status()).samples;
    await page.waitForTimeout(700);
    const b = (await status()).samples;
    check("ticked: the samples count up after the rest", b > a, `${a} then ${b}`);
    const fadeLeft = await page.evaluate(
      () =>
        [...window.viewport.canvas.parentElement.querySelectorAll("canvas")].filter(
          (c) => c !== window.viewport.canvas && c.style.opacity !== "" && c.style.display !== "none",
        ).length,
    );
    check("ticked: the Realtime fade is gone once the trace is up", fadeLeft === 0, `${fadeLeft} left`);
    await shot("rest-on.png");

    // Unticked from the popover: the trace stays up and restarts on every move.
    await openDisplay();
    await page.click("[data-pt-moving]");
    check("the switch shows unticked", (await ticked()) === "false", String(await ticked()));
    await page.keyboard.press("Escape");
    check("unticking saves the pref", (await pref("realtimeWhileMoving")) === false);
    const settled = (await waitSamples(16)).samples;
    reads = await orbit("off");
    const tracing = reads.slice(2);
    check(
      "unticked: every orbit frame keeps the trace up",
      tracing.every((r) => r.state === "trace" && r.shown),
      `states ${[...new Set(tracing.map((r) => r.state))].join(",")}, shown ${tracing.filter((r) => r.shown).length} of ${tracing.length}`,
    );
    const low = Math.min(...tracing.map((r) => r.samples));
    check("unticked: the samples restart during the orbit", low < settled, `lowest ${low}, settled ${settled}`);
    const litOff = lit.off?.lit ?? 0;
    check(
      "unticked: the traced box is on the traced canvas mid orbit, not a cleared picture",
      litOff > 0.03,
      `${(litOff * 100).toFixed(1)}% lit, shot ${((await litShare("orbit-off.png")) * 100).toFixed(1)}% lit`,
    );
    check(
      "unticked: no Realtime frame is drawn during the orbit",
      reads[reads.length - 1].realtimeFrames === reads[0].realtimeFrames,
      `${reads[0].realtimeFrames} to ${reads[reads.length - 1].realtimeFrames}`,
    );
    const c = (await waitSamples(4)).samples;
    await page.waitForTimeout(700);
    const d = (await status()).samples;
    check("unticked: the samples count up after the orbit", d > c, `${c} then ${d}`);
    await shot("rest-off.png");

    await setPref("realtimeWhileMoving", true);
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
