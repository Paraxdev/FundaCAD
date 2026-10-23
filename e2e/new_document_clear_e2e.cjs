// Load a many body document, press New, and check the old bodies leave the view
// in the first frame after Discard, no pick hits one, and no frame stalls.
//
//   engine --ws, vite, then
//   SC_TOKEN=<engine token> node e2e/new_document_clear_e2e.cjs [N=1000] [mode=idle|building|render] [view]
// SC_URL (default http://localhost:5173/) and SC_ENGINE_PORT (default 8765) pick the setup.
// mode=building presses New while a full rebuild of the shown document is in flight,
// mode=render puts materials on the bodies and opens the Render workspace first
// (a third argument, realtime or pathtraced, picks its view mode).
// mode=tool (N is ignored) arms Extrude on a 60 x 60 profile, presses New or Open,
// once with the depth arrow held through it, and checks nothing is left drawn or armed.

const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const APP = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const N = +(process.argv[2] || 1000);
const MODE = process.argv[3] || "idle";
const VIEW = process.argv[4] || "";
const RENDER_WAIT = +(process.env.RENDER_WAIT || 4000);
const MAX_FRAME_MS = +(process.env.MAX_FRAME_MS || 50);
const MAX_FIRST_FRAME_MS = +(process.env.MAX_FIRST_FRAME_MS || 150);
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.CHROME_CHANNEL || "chrome",
    headless: false,
    args: ["--no-sandbox", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
  try {
    if (MODE === "tool") return await toolRun(browser);
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
    await page.addInitScript((ws) => {
      const W = window.WebSocket;
      window.WebSocket = class extends W {
        constructor(u, p) {
          super(String(u).replace(":8765", `:${ws}`), p);
          // The wire, for the timeline: what was asked of the engine and when it answered.
          window.__wsLog = window.__wsLog || [];
          this.addEventListener("message", (m) => {
            const d = typeof m.data === "string" ? m.data.slice(0, 90) : `<bin ${m.data.byteLength ?? m.data.size}>`;
            window.__wsLog.push(["in", performance.now(), d]);
          });
        }
        send(d) {
          window.__wsLog?.push([
            "out",
            performance.now(),
            typeof d === "string" ? d.slice(0, 90) : `<bin ${d.byteLength ?? d.size}>`,
          ]);
          return super.send(d);
        }
      };
    }, ENGINE_PORT);
    await page.goto(`${APP}?token=${TOKEN}`);
    await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, {
      timeout: 60000,
    });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) await modal.click();

    const res = await page.evaluate(
      async ({ N, MODE, VIEW, RENDER_WAIT }) => {
        const s = window.store,
          v = window.viewport,
          F = window.__fundacad;
        const side = Math.ceil(Math.sqrt(N));
        // A fresh radius each run, or the engine's disk cache answers the build at once.
        const R = 8 + Math.round(Math.random() * 1000) / 1000;
        const features = [];
        for (let i = 0; i < N; i++) {
          features.push({ id: `c${i}`, type: "cylinder", radius: R, height: 20 });
          features.push({
            id: `m${i}`,
            type: "move",
            body: `body${i + 1}`,
            x: (i % side) * 25,
            y: Math.floor(i / side) * 25,
          });
        }
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        const tl0 = performance.now();
        s.load(JSON.stringify({ parameters: {}, features }));
        while (v.bodyMeshes.length < N || s.buildState.building) {
          if (performance.now() - tl0 > 600000) throw new Error("build timed out");
          await sleep(200);
        }
        const loadMs = Math.round(performance.now() - tl0);
        v.fitView();
        await sleep(1500);
        if (MODE === "building") {
          // Every body changes, so the engine rebuilds from the first feature while
          // the old model stays on screen; New lands in the middle of it.
          const R2 = R + 0.5;
          s.load(
            JSON.stringify({
              parameters: {},
              features: features.map((f) => (f.type === "cylinder" ? { ...f, radius: R2 } : f)),
            }),
            { replace: true },
          );
          await sleep(3000);
        }
        if (MODE === "render") {
          // The user's path: materials on many bodies, then the Render workspace.
          const glow = s.addMaterial({ name: "glow", color: "#42e07a", emissive: 1 });
          const red = s.addMaterial({ name: "red", color: "#e04242" });
          s.setBodiesMaterial(
            Array.from({ length: Math.floor(N / 3) }, (_, i) => `body${i + 1}`),
            glow,
          );
          s.setBodiesMaterial(
            Array.from({ length: Math.floor(N / 3) }, (_, i) => `body${i + 1 + Math.floor(N / 3)}`),
            red,
          );
          F.handleAction("materials");
          if (VIEW) F.setRenderPref("viewModeRender", VIEW);
          await sleep(RENDER_WAIT);
        }
        const canvas = document.querySelector("canvas");
        const r = canvas.getBoundingClientRect();
        const pts = [];
        for (let i = 1; i <= 3; i++)
          for (let j = 1; j <= 3; j++) pts.push([r.left + (r.width * i) / 4, r.top + (r.height * j) / 4]);
        const oldIds = new Set(v.bodyMeshes.map((b) => b.id));
        const traceBefore = v.traceStatus;
        const hitsBefore = pts.filter(([x, y]) => v.bodyIdAt(x, y)).length;

        const longtasks = [];
        const po = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) longtasks.push(Math.round(e.duration));
        });
        po.observe({ entryTypes: ["longtask"] });
        // Long animation frames name the scripts that ran in them, for a stall to be traced.
        const loaf = [];
        const pl = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            loaf.push({
              ms: Math.round(e.duration),
              at: Math.round(e.startTime - t0),
              render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0),
              style: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
              scripts: e.scripts.map((x) => [
                Math.round(x.duration),
                x.invoker,
                x.sourceFunctionName || "",
                (x.sourceURL || "").split("/").pop(),
              ]),
            });
          }
        });
        try {
          pl.observe({ type: "long-animation-frame" });
        } catch {
          /* not in this browser */
        }
        const ev = [];
        const tE = () => Math.round(performance.now() - t0);
        let t0 = performance.now();
        s.onOpen(() => ev.push(["open", tE()]));
        s.onDocChange((d) => ev.push(["doc", tE(), d.features.length]));
        s.onBuild((b) => ev.push(["build", tE(), b.building ? 1 : 0, b.result ? (b.result.bodies ?? []).length : -1]));
        s.onBusy((b) => ev.push(["busy", tE(), b.active ? 1 : 0, b.label ?? ""]));
        ev.length = 0;
        const before = { bodies: v.bodyMeshes.length, building: s.buildState.building };
        // Where the Discard frame goes: the view's own teardown against the whole New.
        const spent = { clearModel: 0, newDocument: 0 };
        for (const [o, k] of [
          [v, "clearModel"],
          [s, "newDocument"],
        ]) {
          const fn = o[k].bind(o);
          o[k] = (...a) => {
            const t = performance.now();
            try {
              return fn(...a);
            } finally {
              spent[k] += performance.now() - t;
            }
          };
        }
        // The loaded document is dirty, so New asks first; the clock starts at Discard.
        F.handleAction("new");
        let discard = null;
        for (let i = 0; i < 200 && !discard; i++) {
          await sleep(25);
          discard = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Discard"));
        }
        if (!discard) throw new Error("no Discard button");
        window.__wsLog.length = 0;
        t0 = performance.now();
        discard.click();
        const syncMs = Math.round(performance.now() - t0);
        const samples = [];
        let emptyAt = null,
          emptyFrame = null,
          staleHitFrames = 0,
          staleHits = 0,
          frames = 0,
          worstFrame = 0,
          firstFrame = 0,
          last = t0;
        while (performance.now() - t0 < 60000) {
          await raf();
          const now = performance.now();
          // The Discard frame also unmounts the old document's rows in the panels, so it is held to its own cap.
          if (frames === 0) firstFrame = now - last;
          else worstFrame = Math.max(worstFrame, now - last);
          last = now;
          frames++;
          const n = v.bodyMeshes.length;
          let hits = 0;
          for (const [x, y] of pts) {
            const id = v.bodyIdAt(x, y);
            if (id && oldIds.has(id)) hits++;
          }
          if (hits) {
            staleHitFrames++;
            staleHits += hits;
          }
          const tr = v.traceStatus;
          if (samples.length < 400)
            samples.push([
              Math.round(now - t0),
              n,
              hits,
              s.buildState.building ? 1 : 0,
              s.busyState.active ? 1 : 0,
              tr.shown ? tr.samples : -1,
            ]);
          if (n === 0 && !hits && emptyAt === null) {
            emptyAt = Math.round(now - t0);
            emptyFrame = frames;
          }
          if (emptyAt !== null && now - t0 > emptyAt + 500) break;
        }
        po.disconnect();
        pl.disconnect();
        return {
          N,
          MODE,
          VIEW,
          traceBefore,
          loadMs,
          before,
          spent: { clearModel: Math.round(spent.clearModel), newDocument: Math.round(spent.newDocument) },
          hitsBefore,
          syncMs,
          emptyAt,
          emptyFrame,
          staleHitFrames,
          staleHits,
          frames,
          firstFrame: Math.round(firstFrame),
          worstFrame: Math.round(worstFrame),
          longtasks,
          loaf: loaf.filter((x) => x.at > -5),
          ev: ev.slice(0, 60),
          ws: window.__wsLog.slice(0, 40).map(([d, t, x]) => [d, Math.round(t - t0), x]),
          timeline: samples.filter(
            (x, i, a) =>
              i === 0 ||
              i === a.length - 1 ||
              x[1] !== a[i - 1][1] ||
              x[2] !== a[i - 1][2] ||
              x[3] !== a[i - 1][3] ||
              x[5] >= 0 !== a[i - 1][5] >= 0,
          ),
        };
      },
      { N, MODE, VIEW, RENDER_WAIT },
    );
    console.log(JSON.stringify(res));
    const fails = [];
    if (res.emptyFrame !== 1)
      fails.push(`the view emptied in frame ${res.emptyFrame} (${res.emptyAt} ms), not the first after Discard`);
    if (res.staleHitFrames > 0) fails.push(`${res.staleHitFrames} frames picked an old body`);
    if (res.firstFrame > MAX_FIRST_FRAME_MS)
      fails.push(`Discard frame ${res.firstFrame} ms, over ${MAX_FIRST_FRAME_MS}`);
    if (res.worstFrame > MAX_FRAME_MS) fails.push(`worst frame ${res.worstFrame} ms, over ${MAX_FRAME_MS}`);
    if (fails.length) {
      console.error(`FAIL ${MODE}: ${fails.join("; ")}`);
      process.exitCode = 1;
    } else
      console.error(
        `PASS ${MODE}: empty in ${res.emptyAt} ms, Discard frame ${res.firstFrame} ms, worst frame after ${res.worstFrame} ms`,
      );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openApp(browser) {
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
  await page.goto(`${APP}?token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, {
    timeout: 60000,
  });
  await sleep(1500);
  const modal = await page.$(".modal-close");
  if (modal) await modal.click();
  await sleep(500);
  return page;
}

/** Pixels in the middle of the view, clear of the side panels, that differ by more than 40 levels. */
async function changedPixels(browser, a, b) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ([a, b]) => {
        const load = (src) =>
          new Promise((r) => {
            const i = new Image();
            i.onload = () => r(i);
            i.src = src;
          });
        const read = (img) => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          return g.getImageData(300, 140, 730, 600).data;
        };
        const [pa, pb] = [read(await load(a)), read(await load(b))];
        let n = 0;
        for (let i = 0; i < pa.length; i += 4) {
          const d = (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])) / 3;
          if (d > 40) n++;
        }
        return n;
      },
      [a, b].map((x) => `data:image/png;base64,${x.toString("base64")}`),
    );
  } finally {
    await page.close();
  }
}

async function toolRun(browser) {
  const fails = [];
  for (const how of ["new", "drag", "open"]) {
    const page = await openApp(browser);
    try {
      const empty = await page.screenshot();
      await page.evaluate(() => {
        window.store.addFeature({
          id: "s1",
          type: "sketch",
          plane: "XY",
          entities: [{ type: "rectangle", id: "r1", x: -30, y: -30, width: 60, height: 60 }],
        });
      });
      await page.waitForFunction(() => window.__fundacad.overlay.regions.length > 0, null, { timeout: 30000 });
      await page.evaluate(() => window.viewport.fitView?.());
      await sleep(800);
      const toScreen = (p) =>
        page.evaluate((p) => {
          const v = window.__fundacad;
          const w =
            p === "region"
              ? v.overlay.regions[0]?.interior3D.clone()
              : (() => {
                  const g = v.extrude.depthHandle?.group;
                  if (!g) return null;
                  const q = new g.position.constructor();
                  g.getWorldPosition(q);
                  return q;
                })();
          if (!w) return null;
          const s = w.project(window.viewport.camera);
          const r = window.viewport.domElement.getBoundingClientRect();
          return [r.left + ((s.x + 1) / 2) * r.width, r.top + ((1 - s.y) / 2) * r.height];
        }, p);
      const c = await toScreen("region");
      if (!c) throw new Error("no profile on screen");
      await page.mouse.move(c[0], c[1]);
      await page.mouse.click(c[0] + 8, c[1] + 8);
      await sleep(800);
      await page.keyboard.press("e");
      await page.waitForFunction(() => window.__fundacad.extrude.active, null, { timeout: 10000 });
      await sleep(1000);
      if (how === "drag") {
        const h = await toScreen("handle");
        if (!h) throw new Error("no depth arrow on screen");
        await page.mouse.move(h[0], h[1]);
        await page.mouse.down();
        await page.mouse.move(h[0], h[1] - 60, { steps: 6 });
        await sleep(800);
      }
      const armed = await page.evaluate(() => ({
        extrude: window.__fundacad.extrude.active,
        preview: window.store.hasPreview,
      }));
      if (how === "open") {
        await page.evaluate(() => window.store.load(JSON.stringify({ parameters: {}, features: [] })));
      } else {
        await page.evaluate(() => window.__fundacad.handleAction("new"));
        // A DOM click, so the held arrow sees no pointer event until the release below.
        await page.waitForFunction(
          () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim().startsWith("Discard")),
          null,
          { timeout: 5000 },
        );
        await page.evaluate(() =>
          [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Discard")).click(),
        );
      }
      await sleep(400);
      if (how === "drag") await page.mouse.up();
      await sleep(2500);
      const after = await page.evaluate(() => ({
        toolBusy: window.__fundacad.toolBusy(),
        extrude: window.__fundacad.extrude.active,
        preview: window.store.hasPreview,
        features: window.store.document.features.length,
        bodies: window.viewport.bodyMeshes.length,
        dirty: window.store.isDirty,
      }));
      const changed = await changedPixels(browser, empty, await page.screenshot());
      console.log(JSON.stringify({ how, armed, after, changed }));
      const why = [];
      if (!armed.extrude) why.push("Extrude never armed");
      if (after.toolBusy || after.extrude) why.push("a tool is still armed");
      if (after.preview) why.push("the store still holds a preview");
      if (after.features || after.bodies)
        why.push(`${after.features} features, ${after.bodies} bodies in the new document`);
      if (changed) why.push(`${changed} px still drawn where the profile was`);
      if (why.length) fails.push(`${how}: ${why.join(", ")}`);
    } finally {
      await page.close();
    }
  }
  if (fails.length) {
    console.error(`FAIL tool: ${fails.join("; ")}`);
    process.exitCode = 1;
  } else console.error("PASS tool: New, Open and a held drag leave nothing drawn or armed");
}
