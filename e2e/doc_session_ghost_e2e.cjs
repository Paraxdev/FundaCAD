// The first half of bug fk5b5vx3 in a real browser against the real engine: an import is started from Home while a
// filleted model rebuilds, then the body and every History entry are deleted while the import is still being read.
//
//   1. The running import has its own History row from the moment it starts.
//   2. After the last delete the viewport is empty at once, nothing is pickable where the body was, no build chip.
//   3. When the read ends the import lands in this document as its only feature and builds.
//   4. A New after it starts empty.
//
// Usage (repo root, vite on SC_VITE, engine `fundacad-engine --ws` on SC_PORT started with FUNDACAD_ENGINE_TEST_OPS=1
// and FUNDACAD_TEST_HOLD="import=20000" so the read is long on any machine):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/doc_session_ghost_e2e.cjs
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
    const idle = (ms = 120000) =>
      page.waitForFunction(() => !window.store.buildState.building && !window.store.busyState.active, null, {
        timeout: ms,
        polling: 100,
      });
    const view = () =>
      page.evaluate(() => ({
        features: window.store.document.features.map((f) => f.type),
        vpBodies: window.viewport.model?.bodies?.length ?? 0,
        resultBodies: window.store.buildState.result?.bodies?.length ?? 0,
        chip: document.querySelector(".timeline-node.building .t-build")?.textContent ?? null,
        running: [...document.querySelectorAll(".timeline-node.running")].map((n) => n.textContent.trim()),
      }));

    console.log("1. a filleted plate rebuilds, then Open from Home starts an import");
    await page.evaluate(() => {
      const s = window.store;
      s.addFeature({ id: "f1", type: "box", length: 200, width: 200, height: 20 });
      s.addFeature({ id: "f2", type: "cylinder", radius: 5, height: 40, operation: "cut", targets: ["body1"] });
      s.addFeature({
        id: "f3",
        type: "patternRect",
        countX: 8,
        countY: 8,
        spacingX: 22,
        spacingY: 22,
        features: ["f2"],
      });
    });
    await idle();
    const where = await page.evaluate(() => {
      const vp = window.viewport;
      const c = vp.model.box.getCenter(new vp.model.box.min.constructor());
      const p = c.clone().project(vp.rig.active);
      const r = document.querySelector("canvas").getBoundingClientRect();
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    });
    await page.evaluate(() =>
      window.store.addFeature({
        id: "f4",
        type: "fillet",
        edges: { kind: "edge", by: "all", body: "body1" },
        radius: 3,
      }),
    );
    await page.evaluate(async (file) => {
      const { useHomeStore } = await import("/src/stores/home.ts");
      useHomeStore().visible = true;
      (await import("/src/ui/home.ts")).closeHome();
      const files = await import("/src/io/files.ts");
      window.__importDone = null;
      files.importPath(window.store, window.geometry, file).then(
        () => (window.__importDone = "resolved"),
        (e) => (window.__importDone = "threw " + e.message),
      );
    }, FIXTURE);
    await page.waitForTimeout(700);
    const started = await view();
    check(
      "the running import has its own History row",
      started.running.some((t) => t.includes(path.basename(FIXTURE, ".step"))),
      JSON.stringify(started.running),
    );

    console.log("2. Remove body, then every History entry, while the import is read");
    await page.evaluate(() => window.store.removeBody("body1"));
    await page.waitForTimeout(300);
    for (let i = 0; i < 10; i++) {
      const last = await page.evaluate(() => window.store.document.features.at(-1)?.id ?? null);
      if (!last) break;
      await page.evaluate((id) => window.store.removeFeature(id), last);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1000);
    const emptied = await view();
    const picked = await page.evaluate(({ x, y }) => window.viewport.selectBodyAt(x, y), where);
    check(
      "within 1 s the viewport and the result are empty and no build chip shows",
      emptied.features.length === 0 && emptied.vpBodies === 0 && emptied.resultBodies === 0 && emptied.chip === null,
      JSON.stringify(emptied),
    );
    check("nothing is pickable where the body was", !picked, JSON.stringify(picked));
    check("the import is still running", (await page.evaluate(() => window.__importDone)) === null);

    console.log("3. the read ends and the import lands in this document");
    await page.waitForFunction(() => window.__importDone !== null, null, { timeout: 900000, polling: 250 });
    await idle(900000);
    const landed = await view();
    check(
      "the import is the only feature and it built",
      JSON.stringify(landed.features) === '["import"]' &&
        landed.resultBodies > 0 &&
        landed.vpBodies === landed.resultBodies,
      JSON.stringify(landed),
    );

    console.log("4. New starts an empty document");
    await page.evaluate(() => window.__fundacad.handleAction("new"));
    for (let i = 0; i < 20; i++) {
      const btn = await page.$("button:has-text('Discard')");
      if (btn) {
        // Playwright's click waits for the frame to settle, which under SwiftShader with 1097 bodies times out.
        await btn.evaluate((b) => b.click());
        break;
      }
      await page.waitForTimeout(100);
    }
    await idle();
    await page.waitForTimeout(500);
    const fresh = await view();
    check(
      "the new document is empty",
      fresh.features.length === 0 && fresh.vpBodies === 0 && fresh.running.length === 0,
      JSON.stringify(fresh),
    );
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})();
