// Nothing piles up across documents, in a real browser.
//
// Opens a part with a text sketch, opens and closes that sketch, then replaces
// the document with a new one, over and over. The renderer's live geometry and
// texture counts must come back to the same numbers every cycle, and the JS heap
// must stay flat. A text redraw once left its glyph lines on the GPU and grew the
// geometry count by ten every cycle, which nothing else would have noticed.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/memory_e2e.cjs
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const CYCLES = Number(process.env.CYCLES || 6);
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

const DOC = {
  parameters: {},
  features: [
    { id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 60, height: 30 }] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new", regions: [[0, 0, 0]] },
    { id: "s2", type: "sketch", plane: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] },
      entities: [{ type: "text", id: "t1", text: "LEAK", x: -20, y: -5, height: 10 }] },
  ],
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript((t) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, TOKEN);
  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  const cdp = await page.context().newCDPSession(page);
  const settle = () => page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 90000 });

  const sample = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = await cdp.send("Runtime.getHeapUsage");
    const gpu = await page.evaluate(() => {
      const m = window.viewport.scene.renderer.info.memory;
      return { geometries: m.geometries, textures: m.textures };
    });
    return { heapMb: usedSize / 1048576, ...gpu };
  };

  const cycle = async () => {
    await page.evaluate(async (doc) => { window.store.loadDocument(doc); await window.store.rebuildNow(); }, DOC);
    await settle();
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__fundacad.editFeature("s2"));
    await page.waitForTimeout(1500);
    await page.mouse.move(600, 400);
    await page.mouse.move(640, 420);
    await page.evaluate(() => window.sketch.cancel());
    await page.waitForTimeout(400);
    await page.evaluate(() => window.store.newDocument());
    await settle();
    await page.waitForTimeout(600);
  };

  await cycle();
  await cycle();
  const base = await sample();
  for (let i = 2; i < CYCLES; i++) await cycle();
  const end = await sample();
  console.log(`  after 2 cycles ${JSON.stringify(base)}`);
  console.log(`  after ${CYCLES} cycles ${JSON.stringify(end)}`);
  check("geometry count comes back to the same number", end.geometries <= base.geometries, `${base.geometries} -> ${end.geometries}`);
  check("texture count comes back to the same number", end.textures <= base.textures, `${base.textures} -> ${end.textures}`);
  check("the heap stays flat", end.heapMb - base.heapMb < 3, `${base.heapMb.toFixed(1)} -> ${end.heapMb.toFixed(1)} MB`);

  console.log(failures ? `\n  ${failures} FAILED\n` : "\n  all passed\n");
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
