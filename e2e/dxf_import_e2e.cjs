// A DXF drawing dropped on the window, in a real browser against the real
// geometry engine: it becomes one sketch per layer on XY, and a layer's sketch
// extrudes into a body like a sketch drawn by hand.
//
//   1. Dropping tests/fixtures/dxf_shapes.dxf adds sketches named after its
//      layers, in one undo step, and no import feature.
//   2. Extruding the Plate sketch 5 mm builds one 100 x 60 x 5 body.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_OUT=<dir>] node e2e/dxf_import_e2e.cjs
// SC_URL and SC_ENGINE_PORT point it at a vite and an engine on other ports.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = process.env.SC_OUT || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

const LAYERS = ["Plate", "Cam", "Mirror", "Curves", "Spline", "Knots", "Double", "Open", "Half"];

(async () => {
  const dxf = fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "dxf_shapes.dxf")).toString("base64");
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(({ t, port }) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(":8765", `:${port}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, { t: TOKEN, port: ENGINE_PORT });
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  const settle = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !window.store.buildState.building && !window.store.busy?.active, null, { timeout: 120000 });
  };

  console.log("1. drop a DXF");
  const before = await page.evaluate(() => window.store.document.features.length);
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "dxf_shapes.dxf"));
    const el = document.querySelector("canvas") || document.body;
    const r = el.getBoundingClientRect();
    for (const type of ["dragenter", "drop"]) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    }
  }, dxf);
  await page.waitForFunction(() => window.store.document.features.some((f) => f.type === "sketch" && f.name === "Plate"), null, { timeout: 120000 });
  await settle();
  const added = await page.evaluate((n) => window.store.document.features.slice(n).map((f) => ({ type: f.type, name: f.name, plane: f.plane, count: (f.entities || []).length })), before);
  check("one sketch per layer, in drawing order", JSON.stringify(added.map((f) => f.name)) === JSON.stringify(LAYERS), JSON.stringify(added.map((f) => f.name)));
  check("all sketches on XY and none empty", added.every((f) => f.type === "sketch" && f.plane === "XY" && f.count > 0));
  check("the Plate sketch holds its outline, hole and two block circles", added[0]?.count === 11, String(added[0]?.count));
  await page.evaluate(() => window.store.undo());
  const undone = await page.evaluate(() => window.store.document.features.length);
  check("one undo removes the whole import", undone === before, `${undone} features after undo, ${before} before`);
  await page.evaluate(() => window.store.redo());
  await settle();

  console.log("2. extrude the Plate layer");
  const result = await page.evaluate(async () => {
    const plate = window.store.document.features.find((f) => f.type === "sketch" && f.name === "Plate");
    window.store.addFeature({ id: window.store.nextId(), type: "extrude", sketch: plate.id, distance: 5, operation: "new" });
    await window.store.rebuildNow();
    const r = window.store.buildState.result;
    return { bodies: (r?.bodies || []).length, bbox: r?.bbox, error: window.store.buildState.errorMessage || null };
  });
  await settle();
  const size = result.bbox ? [0, 1, 2].map((i) => +(result.bbox.max[i] - result.bbox.min[i]).toFixed(4)) : null;
  check("the extrude builds one body", result.bodies === 1 && !result.error, JSON.stringify(result));
  check("the body is 100 x 60 x 5", JSON.stringify(size) === "[100,60,5]", JSON.stringify(size));
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    await page.evaluate(() => window.viewport?.fitAll?.());
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, "dxf-plate-extruded.png") });
  }

  await browser.close();
  console.log(failures ? `FAILED: ${failures}` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
