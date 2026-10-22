// The second half of bug fk5b5vx3 in a real browser against the real engine: a document is discarded while its import
// is still read, and nothing of it may reach the next document.
//
//   1. At New + Discard the busy line is idle and undo is free at once, and the engine is told the old document ended.
//   2. The new document's first build settles within 2 s, although the old import was held for 20 s.
//   3. After the hold and the read would have ended, the new document has only its own features and bodies and the
//      camera never moved.
//   4. A second New after it is clean too.
//
// Usage (repo root, vite on SC_VITE, engine `fundacad-engine --ws` on SC_PORT started with FUNDACAD_ENGINE_TEST_OPS=1
// and FUNDACAD_TEST_HOLD="import=20000"):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/doc_session_switch_e2e.cjs
const { chromium } = require("playwright-core");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const VITE = process.env.SC_VITE || "http://localhost:5197";
const PORT = process.env.SC_PORT || "8797";
// SC_FIXTURE runs it with a real file such as the SV08 STEP, read at its own pace instead of held.
const FIXTURE = (process.env.SC_FIXTURE || path.resolve(__dirname, "../tests/fixtures/asm_nested.step")).replace(
  /\\/g,
  "/",
);
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    await page.goto(`${VITE}/?engine=${PORT}&token=${TOKEN}`);
    await page.waitForFunction(() => !!window.store && !!window.geometry && window.geometry.connected, null, {
      timeout: 120000,
    });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) await modal.click();
    // Every request's op and document, read from its first bytes, never the multi megabyte rest.
    await page.evaluate(() => {
      const t = window.geometry.transport;
      const send = t.send.bind(t);
      window.__wire = [];
      t.send = (raw) => {
        const head = raw.slice(0, 200);
        window.__wire.push({
          op: /"op":"([^"]+)"/.exec(head)?.[1],
          doc: /"doc":"([^"]+)"/.exec(head)?.[1] ?? null,
          at: performance.now(),
        });
        return send(raw);
      };
    });
    const idle = (ms = 120000) =>
      page.waitForFunction(() => !window.store.buildState.building && !window.store.busyState.active, null, {
        timeout: ms,
        polling: 50,
      });
    const newDiscard = async () => {
      await page.evaluate(() => window.__fundacad.handleAction("new"));
      for (let i = 0; i < 40; i++) {
        const btn = await page.$("button:has-text('Discard')");
        if (btn) return btn.click();
        await page.waitForTimeout(50);
      }
    };
    const state = () =>
      page.evaluate(() => ({
        features: window.store.document.features.map((f) => f.type),
        vpBodies: window.viewport.model?.bodies?.length ?? 0,
        resultBodies: window.store.buildState.result?.bodies?.length ?? 0,
        busyOther: window.store.busyState.active && !window.store.busyState.rebuild,
        canUndo: window.store.canUndo,
        running: document.querySelectorAll(".timeline-node.running").length,
        camera: window.viewport.rig.active.position.toArray().map((v) => Math.round(v * 1000) / 1000),
      }));
    const sketch = () =>
      page.evaluate(() => {
        const s = window.store;
        s.addFeature({
          id: "s1",
          type: "sketch",
          plane: "XY",
          entities: [{ type: "circle", radius: 4, x: 20, y: 0 }],
        });
        s.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 6, operation: "new" });
        s.addFeature({ id: "p1", type: "patternCircular", features: ["e1"], count: 6, angle: 360, axis: "Z" });
      });

    for (const round of [1, 2]) {
      console.log(`round ${round}: a document with an import being read, then New + Discard`);
      const docA = await page.evaluate(async (file) => {
        window.store.addFeature({ id: "f1", type: "box", length: 60, width: 60, height: 10 });
        const files = await import("/src/io/files.ts");
        void files.importPath(window.store, window.geometry, file).catch(() => {});
        return window.store.session.id;
      }, FIXTURE);
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        for (const f of [...window.store.document.features].reverse()) window.store.removeFeature(f.id);
      });
      const t0 = Date.now();
      await newDiscard();
      await page.waitForFunction((a) => window.store.session.id !== a, docA, { timeout: 5000, polling: 20 });
      const swappedAt = await page.evaluate(() => performance.now());
      const atSwap = await state();
      const swapMs = Date.now() - t0;
      check(
        "at the swap the busy line is idle and undo is free",
        !atSwap.busyOther && atSwap.running === 0 && atSwap.features.length === 0,
        `${swapMs} ms, ${JSON.stringify(atSwap)}`,
      );
      const ends = await page.evaluate(
        (a) => window.__wire.filter((w) => w.op === "doc_end" && w.doc === a).length,
        docA,
      );
      check("the engine was told the old document ended, once", ends === 1, String(ends));

      await sketch();
      const t1 = Date.now();
      await idle(10000).catch(() => {});
      const firstBuild = Date.now() - t1;
      // New sends the camera home with an eased move, the reference is where it comes to rest.
      let built = await state();
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(250);
        const next = await state();
        if (JSON.stringify(next.camera) === JSON.stringify(built.camera)) break;
        built = next;
      }
      check(
        "the new document's first build settles within 2 s",
        firstBuild < 2000 && built.resultBodies > 0,
        `${firstBuild} ms, ${JSON.stringify(built)}`,
      );

      await page.waitForTimeout(Number(process.env.SC_LATE_MS || 25000));
      const later = await state();
      check(
        "after the old import's time nothing of it landed and the camera did not move",
        JSON.stringify(later.features) === '["sketch","extrude","patternCircular"]' &&
          later.vpBodies === built.vpBodies &&
          later.resultBodies === built.resultBodies &&
          JSON.stringify(later.camera) === JSON.stringify(built.camera),
        JSON.stringify(later),
      );
      const oldSent = await page.evaluate(
        ({ a, at }) => window.__wire.filter((w) => w.doc === a && w.op !== "doc_end" && w.at > at).length,
        { a: docA, at: swappedAt },
      );
      check("no request of the old document went out after the swap", oldSent === 0, String(oldSent));
      await newDiscard();
      await idle();
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})();
