// An imported HDR lights a chrome sphere the right way up in Realtime and Path
// traced, turns with its rotation, shows behind the model when asked, and a
// saved environment comes back by name.
//
// The panorama is generated here: a blue sky, a green ground and an orange sun,
// so a chrome sphere reflecting it upright is blue on top and green below.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_CHROME=<chrome exe>] [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] node e2e/hdr_environment_e2e.cjs [outDir]
//
// SC_TRACER=native-dev traces through tracer_serve instead of WebGPU:
//   cargo build --release --example tracer_serve --manifest-path src-tauri/tracer/Cargo.toml
// SC_TRACER_SERVE points at the example if CARGO_TARGET_DIR moved it. Each
// built in room and the HDR then have to come out within 15 percent of the
// Realtime sphere's mean luminance.
const { spawn } = require("child_process");
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "hdr_environment_shots");
const NATIVE = process.env.SC_TRACER === "native-dev";
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
  return new Promise((ok, fail) => {
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
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let url = URL;
  if (NATIVE) {
    const port = await startTracerServe();
    url += (url.includes("?") ? "&" : "?") + `token=${encodeURIComponent(TOKEN)}&tracer=native-dev&port=${port}`;
  }
  const browser = await chromium.launch({
    ...(EXE ? { executablePath: EXE } : { channel: "chrome" }),
    args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    if (process.env.SC_DEBUG)
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning") console.log("  console", m.type(), m.text().slice(0, 300));
      });
    await page.addInitScript(
      ([port, t]) => {
        const N = window.WebSocket;
        window.WebSocket = class extends N {
          constructor(u, p) {
            // Only the engine's socket: the native frames carry their own token.
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
    const prefs = (code) =>
      page.evaluate(async (code) => {
        const m = await import("/src/ui/renderPrefs.ts");
        return new Function("m", code)(m);
      }, code);
    await prefs(`m.setRenderPref("bloom", 0); m.setRenderPref("denoise", "off"); m.setRenderPref("environment", "studio");
      m.setRenderPref("envRotation", 0); m.setRenderPref("envExposure", 0); m.setRenderPref("envBackground", false);
      m.setRenderPref("background", "grey");`);
    await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "sphere", radius: 20 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      s.setBodiesMaterial(["body1"], "m-chrome");
    });
    await page.evaluate(async () => (await import("/src/ui/workspace.ts")).setWorkspace("render"));
    await page.waitForTimeout(500);
    await page.click('[data-tab="environment"]');
    await page.evaluate(() => window.__fundacad.handleAction("front"));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(800);
    await page.mouse.move(5, 5);

    const box = await page.evaluate(() => {
      const r = window.viewport.canvas.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    });
    const shot = async (name, clip = box) => {
      const buf = await page.screenshot({ clip });
      fs.writeFileSync(path.join(OUT, name), buf);
      return "data:image/png;base64," + buf.toString("base64");
    };
    const settle = (ms = 1500) =>
      page.evaluate(async (ms) => {
        window.viewport.requestRender();
        await new Promise((r) => setTimeout(r, ms));
      }, ms);
    // The sphere's pixels told from the ground by colour, then blue minus green
    // in its top and bottom thirds, and the corner's colour.
    // The sphere (radius 20 at the origin) on screen, from the viewport's camera.
    const disc = () =>
      page.evaluate(() => {
        const cam = window.viewport.camera;
        const V = cam.position.constructor;
        const r = window.viewport.canvas.getBoundingClientRect();
        const px = (v) => {
          const p = v.project(cam);
          return [((p.x + 1) / 2) * r.width, ((1 - p.y) / 2) * r.height];
        };
        const c = px(new V(0, 0, 0));
        const e = px(new V(0, 1, 0).applyQuaternion(cam.quaternion).multiplyScalar(20));
        return { x: c[0], y: c[1], r: Math.hypot(e[0] - c[0], e[1] - c[1]) };
      });
    const measure = (img, sphere = null) =>
      page.evaluate(
        async ([img, sphere]) => {
          const bm = await createImageBitmap(await (await fetch(img)).blob());
          const c = new OffscreenCanvas(bm.width, bm.height);
          const g = c.getContext("2d");
          g.drawImage(bm, 0, 0);
          const d = g.getImageData(0, 0, bm.width, bm.height).data,
            w = bm.width,
            h = bm.height;
          const at = (x, y) => {
            const i = (y * w + x) * 4;
            return [d[i], d[i + 1], d[i + 2]];
          };
          const cx = Math.round(w / 2),
            cy = Math.round(h / 2);
          const bg = at(cx, 4);
          const off = (y) => {
            const p = at(cx, y);
            return Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 40;
          };
          let top = 0;
          while (top < h && !off(top)) top++;
          let bot = top;
          while (bot + 1 < h && off(bot + 1)) bot++;
          const band = (y0, y1) => {
            let s = 0,
              n = 0;
            for (let y = y0; y < y1; y++)
              for (let x = cx - 20; x <= cx + 20; x++) {
                const p = at(x, y);
                s += p[2] - p[1];
                n++;
              }
            return +(s / Math.max(1, n)).toFixed(1);
          };
          const third = Math.max(1, Math.round((bot - top) / 3));
          // Display luminance over the sphere's disc, inset from its edge.
          const sx = sphere ? sphere.x : cx,
            r = sphere ? sphere.r * 0.9 : (bot - top) / 2 - 6,
            my = sphere ? sphere.y : (top + bot) / 2;
          let ls = 0,
            ln = 0;
          for (let y = Math.max(0, Math.ceil(my - r)); y < Math.min(h, my + r); y++) {
            for (let x = Math.max(0, Math.ceil(sx - r)); x < Math.min(w, sx + r); x++) {
              if ((x - sx) ** 2 + (y - my) ** 2 > r * r) continue;
              const p = at(x, y);
              ls += 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
              ln++;
            }
          }
          return {
            top,
            bot,
            upper: band(top + 4, top + third),
            lower: band(bot - third, bot - 4),
            corner: at(cx + 300, cy + 250),
            lum: +(ls / Math.max(1, ln)).toFixed(1),
          };
        },
        [img, sphere],
      );

    const traced = async (name, sphere = null) => {
      await page.click('[data-view-mode="pathtraced"]');
      if (process.env.SC_DEBUG)
        console.log("  entered", JSON.stringify(await page.evaluate(() => window.viewport.traceStatus)));
      await page.waitForFunction(
        () => {
          const s = window.viewport.traceStatus;
          return s.state === "done" && s.samples >= 128 ? s : null;
        },
        null,
        { timeout: 240000, polling: 250 },
      );
      await settle();
      const m = await measure(await shot(name), sphere);
      await page.click('[data-view-mode="realtime"]');
      return m;
    };
    const near = (a, b) => Math.abs(a / b - 1) <= 0.15;

    await settle();
    const rtStudio = await measure(await shot("rt-studio.png"));
    console.log("  realtime studio", JSON.stringify(rtStudio));
    // A white plastic ball for the rooms: chrome mirrors the hemisphere the
    // traced room carries, which Realtime's hemisphere light never reflects.
    if (NATIVE) {
      await page.evaluate(() => window.store.setBodiesMaterial(["body1"], "m-plastic-white"));
      const sphere = await disc();
      for (const room of ["studio", "softbox", "warm", "dusk", "bright"]) {
        await prefs(`m.setRenderPref("environment", "${room}")`);
        await settle();
        const rt = await measure(await shot(`rt-${room}.png`), sphere);
        const pt = await traced(`pt-${room}.png`, sphere);
        check(
          `Path traced ${room} within 15 percent of Realtime`,
          near(pt.lum, rt.lum),
          `luminance ${pt.lum} against ${rt.lum}`,
        );
      }
      await prefs(`m.setRenderPref("environment", "studio")`);
      await page.evaluate(() => window.store.setBodiesMaterial(["body1"], "m-chrome"));
      await settle();
    }

    await page.setInputFiles("[data-env-file]", {
      name: "test-sky.hdr",
      mimeType: "image/vnd.radiance",
      buffer: panorama(1024, 512),
    });
    await page.waitForFunction(
      () => /^hdr:/.test(JSON.parse(localStorage.getItem("fundacad.render") || "{}").environment || ""),
      null,
      { timeout: 20000 },
    );
    await settle(2500);
    const rtHdr = await measure(await shot("rt-hdr.png"));
    console.log("  realtime hdr", JSON.stringify(rtHdr));
    check("the sphere is on screen", rtHdr.bot - rtHdr.top > 100, `${rtHdr.top}..${rtHdr.bot}`);
    check(
      "Realtime: the sky is reflected above, the ground below",
      rtHdr.upper > 20 && rtHdr.lower < -20,
      JSON.stringify(rtHdr),
    );
    const panel = await page.$(".rd-scroll:has([data-env-custom])");
    if (panel) fs.writeFileSync(path.join(OUT, "panel.png"), await panel.screenshot());
    check("the panel shows the imported tile", !!(await page.$('[data-environment="hdr"]')));

    await page.evaluate(() => {
      const el = document.querySelector("#rd-env-rotation");
      el.value = "90";
      el.dispatchEvent(new Event("change"));
    });
    await settle(2000);
    const rtTurn = await measure(await shot("rt-hdr-rot90.png"));
    check(
      "Realtime: a quarter turn keeps the sky on top",
      rtTurn.upper > 20 && rtTurn.lower < -20,
      JSON.stringify(rtTurn),
    );

    // Three draws a panorama background with a camera centred box, which an
    // orthographic camera cannot see, so this one is looked at in perspective.
    const projection = await page.evaluate(() => {
      const was = window.viewport.projection;
      window.viewport.setProjection("persp");
      return was;
    });
    await page.click("[data-env-behind]");
    await settle(2000);
    const rtBehind = await measure(await shot("rt-hdr-behind.png"));
    check(
      "Realtime: the panorama is drawn behind the model",
      JSON.stringify(rtBehind.corner) !== JSON.stringify(rtHdr.corner),
      `${rtHdr.corner} -> ${rtBehind.corner}`,
    );
    await page.click("[data-env-behind]");
    await page.evaluate((p) => window.viewport.setProjection(p), projection);

    await page.click("[data-env-save]");
    await page.fill("[data-env-name]", "Green field");
    await page.press("[data-env-name]", "Enter");
    await page.waitForSelector('[data-saved-environment="Green field"]', { timeout: 5000 });
    await page.click('[data-environment="softbox"]');
    await settle(1000);
    await page.click('[data-saved-environment="Green field"]');
    await settle(2000);
    const env = await prefs("return m.renderPrefs()");
    check(
      "a saved environment comes back by name, rotation and all",
      /^hdr:/.test(env.environment) && env.envRotation === 90,
      `${env.environment.slice(0, 12)} rot ${env.envRotation}`,
    );
    const docEnv = await page.evaluate(() => {
      const e = window.store.documentEnvironment;
      return e && { name: e.name, sha: e.hdr?.sha256?.slice(0, 8), kb: Math.round((e.hdr?.data.length ?? 0) / 1024) };
    });
    check(
      "the document carries the environment",
      docEnv?.name === "Green field" && !!docEnv.sha,
      JSON.stringify(docEnv),
    );

    const rtSaved = await measure(await shot("rt-hdr-saved.png"), await disc());
    const pt = await traced("pt-hdr.png", await disc());
    console.log("  path traced hdr", JSON.stringify(pt));
    check(
      "Path traced: the sky is reflected above, the ground below",
      pt.upper > 20 && pt.lower < -20,
      JSON.stringify(pt),
    );
    if (NATIVE)
      check(
        "Path traced HDR within 15 percent of Realtime",
        near(pt.lum, rtSaved.lum),
        `luminance ${pt.lum} against ${rtSaved.lum}`,
      );
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})();
