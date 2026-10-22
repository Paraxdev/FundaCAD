// An SVG logo dropped on the window, in a real browser against the real
// geometry engine: it becomes a sketch on XY that extrudes with its holes.
//
//   1. Dropping tests/fixtures/svg_letter_o.svg adds one sketch with fillRule
//      evenodd, in one undo step, and no import feature.
//   2. An extrude of the sketch with no regions builds one 20 x 20 x 2 ring,
//      not the solid disc: the O keeps its hole.
//   3. The areas the extrude tool preselects for a whole sketch skip the hole,
//      so an extrude of those builds the same ring.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_OUT=<dir>] node e2e/svg_import_e2e.cjs
// SC_URL and SC_ENGINE_PORT point it at a vite and an engine on other ports.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = process.env.SC_OUT || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

const RING = 2 * Math.PI * (100 - 25);
const DISC = 2 * Math.PI * 100;

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "..", "tests", "fixtures", "svg_letter_o.svg")).toString("base64");
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.addInitScript(
    ({ t, port }) => {
      const N = window.WebSocket;
      class P extends N {
        constructor(u, p) {
          const s = String(u)
            .replace(":8765", `:${port}`)
            .replace(/([?&])token=[^&]*/, `$1token=${t}`);
          super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
        }
      }
      window.WebSocket = P;
    },
    { t: TOKEN, port: ENGINE_PORT },
  );
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  const settle = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !window.store.buildState.building && !window.store.busy?.active, null, {
      timeout: 120000,
    });
  };

  console.log("1. drop an SVG");
  const before = await page.evaluate(() => window.store.document.features.length);
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "svg_letter_o.svg"));
    const el = document.querySelector("canvas") || document.body;
    const r = el.getBoundingClientRect();
    for (const type of ["dragenter", "drop"]) {
      el.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
        }),
      );
    }
  }, svg);
  await page.waitForFunction(
    () => window.store.document.features.some((f) => f.type === "sketch" && f.name === "svg_letter_o"),
    null,
    { timeout: 120000 },
  );
  await settle();
  const added = await page.evaluate(
    (n) =>
      window.store.document.features.slice(n).map((f) => ({
        id: f.id,
        type: f.type,
        plane: f.plane,
        fillRule: f.fillRule,
        count: (f.entities || []).length,
      })),
    before,
  );
  check(
    "one sketch on XY, even-odd, with the O's four arcs",
    added.length === 1 &&
      added[0].type === "sketch" &&
      added[0].plane === "XY" &&
      added[0].fillRule === "evenodd" &&
      added[0].count === 4,
    JSON.stringify(added),
  );
  await page.evaluate(() => window.store.undo());
  const undone = await page.evaluate(() => window.store.document.features.length);
  check("one undo removes the whole import", undone === before, `${undone} features after undo, ${before} before`);
  await page.evaluate(() => window.store.redo());
  await settle();
  const sketchId = added[0]?.id;

  const extrude = (regions) =>
    page.evaluate(
      async ({ id, regions }) => {
        const f = { id: window.store.nextId(), type: "extrude", sketch: id, distance: 2, operation: "new" };
        if (regions) f.regions = regions;
        window.store.addFeature(f);
        await window.store.rebuildNow();
        const r = window.store.buildState.result;
        const bodies = (r?.bodies || []).length;
        const volume = window.viewport.bodyProperties(null)?.volume ?? null;
        return { bodies, bbox: r?.bbox, volume, error: window.store.buildState.errorMessage || null, fid: f.id };
      },
      { id: sketchId, regions },
    );
  const ringChecks = (what, res) => {
    const size = res.bbox ? [0, 1, 2].map((i) => +(res.bbox.max[i] - res.bbox.min[i]).toFixed(3)) : null;
    check(
      `${what}: one body, no error`,
      res.bodies === 1 && !res.error,
      JSON.stringify({ bodies: res.bodies, error: res.error }),
    );
    // The box comes from the display mesh, whose chords sit inside the round edge.
    check(
      `${what}: 20 x 20 x 2`,
      !!size && [20, 20, 2].every((v, i) => Math.abs(size[i] - v) < 0.05),
      JSON.stringify(size),
    );
    check(
      `${what}: the volume is the ring's, so the hole is open`,
      res.volume !== null && Math.abs(res.volume - RING) < RING * 0.01,
      `${res.volume?.toFixed(2)} mm3, ring ${RING.toFixed(2)}, disc ${DISC.toFixed(2)}`,
    );
  };

  console.log("2. extrude the sketch with no regions");
  const whole = await extrude(null);
  await settle();
  ringChecks("no regions", whole);
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    await page.evaluate(() => window.viewport?.fitAll?.());
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, "svg-letter-o-extruded.png") });
  }
  await page.evaluate(
    (fid) => (window.store.removeFeature ? window.store.removeFeature(fid) : window.store.undo()),
    whole.fid,
  );
  await settle();

  console.log("3. extrude the areas the extrude tool preselects for the whole sketch");
  await page.evaluate(() => window.overlay.update(window.store.document));
  const points = await page.evaluate((id) => window.overlay.regionPointsForSketch(id), sketchId);
  check("the tool preselects the ring only, not the counter", points.length === 1, JSON.stringify(points));
  ringChecks("preselected areas", await extrude(points));
  await settle();

  await browser.close();
  console.log(failures ? `FAILED: ${failures}` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
