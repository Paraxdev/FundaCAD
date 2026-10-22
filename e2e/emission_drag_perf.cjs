// Benchmark, not a CI check: drag Emission on a material worn by many bodies and
// print the time each step holds the main thread and the frame interval.
//
// Builds N cylinders, puts one material on K of them and steps its emission once
// per frame, the way the slider lands after its per-frame coalescing. Wants a GPU
// Chrome, the frame numbers are meaningless on a software rasteriser.
//
//   engine --ws, vite, then
//   SC_TOKEN=<engine token> node e2e/emission_drag_perf.cjs [N=1000] [K=300]
// SC_URL (default http://localhost:5173/) and SC_ENGINE_PORT (default 8765) pick the setup.
//
// Before the emitter cache a step on K=300 held the main thread 67 to 100 ms and
// the first glow froze for about 2 s; see the numbers printed for the current tree.

const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const APP = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const N = +(process.argv[2] || 1000);
const K = +(process.argv[3] || 300);
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
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) await modal.click();

    const res = await page.evaluate(
      async ({ N, K }) => {
        const s = window.store,
          v = window.viewport;
        const side = Math.ceil(Math.sqrt(N));
        const features = [];
        for (let i = 0; i < N; i++) {
          features.push({ id: `c${i}`, type: "cylinder", radius: 8, height: 20 });
          features.push({
            id: `m${i}`,
            type: "move",
            body: `body${i + 1}`,
            x: (i % side) * 25,
            y: Math.floor(i / side) * 25,
          });
        }
        s.load(JSON.stringify({ parameters: {}, features }));
        const t0 = performance.now();
        while (s.buildState.building || v.bodyMeshes.length < N) {
          if (performance.now() - t0 > 600000) throw new Error("build timed out");
          await new Promise((r) => setTimeout(r, 300));
        }
        const mid = s.addMaterial({ name: "probe", color: "#42e07a" });
        s.setBodiesMaterial(
          Array.from({ length: K }, (_, i) => `body${i + 1}`),
          mid,
        );
        await new Promise((r) => setTimeout(r, 2000));

        const { emissionProgress } = await import("/src/ui/emissionProgress.ts");
        const raf = () => new Promise((r) => requestAnimationFrame(r));
        const longtasks = [];
        const po = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) longtasks.push(Math.round(e.duration));
        });
        po.observe({ entryTypes: ["longtask"] });
        const sync = [],
          frames = [];
        const T0 = performance.now();
        let last = T0;
        for (let i = 1; i <= 30; i++) {
          const t = performance.now();
          s.updateMaterial(mid, { emissive: i * 0.01 });
          sync.push(Math.round(performance.now() - t));
          await raf();
          const n = performance.now();
          frames.push(Math.round(n - last));
          last = n;
        }
        let waited = 0;
        while (emissionProgress() !== null && waited++ < 600) await raf();
        const settledMs = Math.round(performance.now() - T0);
        po.disconnect();
        const g = v.scene.scene.getObjectByName("emitters");
        return {
          bodies: v.bodyMeshes.length,
          K,
          sync,
          frames,
          longtasks,
          settledMs,
          lights: g
            ? {
                area: g.children.filter((o) => o.isRectAreaLight).length,
                shadow: g.children.filter((o) => o.isPointLight).length,
              }
            : null,
        };
      },
      { N, K },
    );
    const sorted = (a) => [...a].sort((x, y) => x - y);
    const med = (a) => sorted(a)[a.length >> 1];
    console.log(JSON.stringify(res));
    console.log(`step sync: first ${res.sync[0]} ms, median ${med(res.sync)} ms, max ${Math.max(...res.sync)} ms`);
    console.log(
      `frame interval: first ${res.frames[0]} ms, median ${med(res.frames)} ms, max ${Math.max(...res.frames)} ms`,
    );
    console.log(`lights all in after ${res.settledMs} ms`);
  } finally {
    await browser.close();
  }
})();
