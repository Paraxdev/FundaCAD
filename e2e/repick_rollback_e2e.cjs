// Re-pick of an ambiguous fillet edge is taken on the model rolled back to the
// fillet, in a real browser.
//
// A 20 mm box, a fillet whose saved edge point sits at the middle of the top face
// (four edges tie for nearest), then a move of the body by dx 100. The build
// refuses to guess, the notice offers the re-pick, and the edge clicked is the
// top edge on +y. The point written into the fillet has to lie on the box where
// the fillet sees it (x within -10..10), not where the move put it (x near 100),
// and the fillet then builds on that edge.
//
// Usage (from the repo root, with vite + a engine (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/repick_rollback_e2e.cjs [outDir]
// SC_APP overrides the page URL, SC_ENGINE_PORT points the page at another engine.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const APP = process.env.SC_APP || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "repick_rollback_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const DOC = {
  parameters: {},
  features: [
    { id: "f1", type: "box", length: 20, width: 20, height: 20, operation: "new" },
    { id: "f2", type: "fillet", radius: 2, edges: [{ kind: "edge", by: "nearest", point: [0, 0, 10] }] },
    { id: "f3", type: "move", dx: 100, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0, bodies: ["body1"] },
  ],
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(([t, port]) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace("127.0.0.1:8765", `127.0.0.1:${port}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, [TOKEN, ENGINE_PORT]);

  await page.goto(APP);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }

  const settle = () => page.evaluate(async () => {
    const s = window.store;
    for (let i = 0; i < 600; i++) {
      if (!s.rebuildTimer && !s.rebuilding && !s.buildState.building) {
        await new Promise((r) => setTimeout(r, 300));
        if (!s.rebuildTimer && !s.rebuilding && !s.buildState.building) return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("never settled");
  });
  const model = () => page.evaluate(() => {
    const r = window.store.buildState.result;
    const p = r?.mesh.positions ?? [];
    const idx = r?.mesh.indices ?? [];
    let minX = Infinity, maxX = -Infinity, vol = 0;
    for (let i = 0; i < p.length; i += 3) { minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]); }
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]);
      vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    return {
      minX, maxX, vol,
      errors: (r?.featureErrors ?? []).map((e) => e.feature_id),
      diag: (r?.diagnostics ?? []).filter((d) => d.feature_id === "f2").map((d) => ({ code: d.code, kind: d.kind, at: d.at })),
    };
  });

  await page.evaluate((json) => window.store.load(json), JSON.stringify(DOC));
  await settle();
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(500);
  const before = await model();
  console.log("before", JSON.stringify(before));
  check("the tied edge is reported for re-pick", before.diag.length > 0, before.diag);
  check("the full model shows the moved box", before.minX > 85, before.minX);

  const notice = await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].find((b) => /^\s*Re-pick edge\s*$/.test(b.textContent ?? "")) ?? null, null, { timeout: 10000 }).catch(() => null);
  check("the notice offers the re-pick", !!notice);
  if (!notice) { await browser.close(); process.exit(1); }
  await page.screenshot({ path: path.join(OUT, "1_notice.png") });
  console.log("button:", await notice.evaluate((b) => b.textContent));
  await notice.asElement().click();

  await page.waitForFunction(() => /Pick the edge/.test(document.body.innerText), null, { timeout: 30000 });
  await settle();
  const shown = await model();
  console.log("while picking", JSON.stringify(shown));
  // Frame what is shown now, whichever model that is, so the edge is on screen.
  const cx = (shown.minX + shown.maxX) / 2;
  await page.evaluate(([x]) => {
    const v = window.viewport;
    v.rig.moveTo(new v.projScratch.constructor(x, 0, 0), false);
  }, [cx]);
  await page.waitForTimeout(500);
  const at = await page.evaluate(([x]) => {
    const T = window.viewport.projScratch.constructor;
    return window.viewport.projectToScreen(new T(x, 10, 10));
  }, [cx]);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "2_picking.png") });
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  await settle();
  await page.waitForTimeout(300);
  await settle();

  const stored = await page.evaluate(() => window.store.document.features.find((f) => f.id === "f2").edges[0]);
  console.log("stored", JSON.stringify(stored));
  const after = await model();
  console.log("after", JSON.stringify(after));
  await page.screenshot({ path: path.join(OUT, "3_after.png") });
  check("the stored point lies on the unmoved box", Math.abs(stored.point[0]) <= 10 + 1e-6, stored.point);
  check("the stored point is the top edge on +y", Math.abs(stored.point[1] - 10) < 0.5 && Math.abs(stored.point[2] - 10) < 0.5, stored.point);
  check("the fillet builds", !after.errors.includes("f2") && after.diag.length === 0, after);
  check("the fillet rounds one edge", Math.abs(after.vol - (8000 - 4 * (1 - Math.PI / 4) * 20)) < 1.5, after.vol);
  check("the finished model is back", after.minX > 85, after.minX);
  const busy = await page.evaluate(() => ({ planePick: window.__fundacad.busyWhy().planePick, edit: window.store.editPreviewId }));
  check("nothing is left open", !busy.planePick && busy.edit === null, busy);

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})();
