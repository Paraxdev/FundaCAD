// Text on Face in a real browser, against the real engine.
//
// Starts the tool on a cylinder, clicks the round wall, drags the anchor along
// it, types the text and commits. Checks the feature is stored by fingerprint
// and (u, v) fractions, that it embossed about area times depth, that Engrave
// cuts, and that a radius edit keeps the text on the wall.
//
// Usage (from the repo root, with vite and the engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] [SC_ENGINE_PORT=8765] \
//     node e2e/text_on_face_e2e.cjs [outdir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "text_on_face_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

const OFF = 100;
const DOC = { version: 10, parameters: { r: 20 }, features: [
  { id: "c", type: "cylinder", radius: "r", height: 40 },
  { id: "mv", type: "move", dx: OFF, dy: OFF, dz: OFF, rx: 0, ry: 0, rz: 0, bodies: ["body1"] },
] };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(([t, port]) => {
    const N = window.WebSocket;
    window.WebSocket = class extends N {
      constructor(u, p) {
        let s = String(u).replace(":8765", `:${port}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        if (!s.includes("token=")) s += (s.includes("?") ? "&" : "?") + "token=" + t;
        super(s, p);
      }
    };
  }, [TOKEN, PORT]);

  await page.goto(URL);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }

  await page.evaluate(async (d) => {
    window.store.load(JSON.stringify(d));
    await window.store.rebuildNow();
    window.viewport.setStandardView("iso");
    window.viewport.fitView();
  }, DOC);
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length === 1, null, { timeout: 120000 });

  // The kernel's volume from the inspect op, a mesh volume moves with the
  // tessellation of the wall by more than the letters add.
  const state = () => page.evaluate(async () => {
    const r = window.store.buildState.result;
    const doc = JSON.parse(JSON.stringify(window.store.document));
    const reply = await window.geometry.call("inspect", { document: doc, detail: false });
    return {
      vol: reply.ok ? reply.result.bodies[0]?.volume ?? null : null,
      errors: (r.featureErrors || []).map((e) => `${e.feature_id}: ${e.message}`),
      texts: window.store.document.features.filter((f) => f.type === "textOnFace"),
    };
  });
  const settle = async () => {
    await page.waitForTimeout(500);
    await page.evaluate(async () => { await window.store.rebuildNow(); });
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 300000 }).catch(() => {});
  };
  const screen = (p) => page.evaluate((q) => window.viewport.projectToScreen({ x: q[0], y: q[1], z: q[2] }), p);
  const live = () => page.evaluate(() => window.__fundacad.textOnFace.buildFeatures()?.[0] ?? null);

  await page.evaluate(async () => { window.store.setParam("r", 25); await window.store.rebuildNow(); });
  await settle();
  const base25 = await state();
  await page.evaluate(async () => { window.store.setParam("r", 20); await window.store.rebuildNow(); });
  await settle();
  const base = await state();
  check("the cylinder builds", base.vol > 0 && base25.vol > base.vol && base.errors.length === 0, JSON.stringify({ base, base25 }));

  // The ray through the axis at mid height leaves through the wall nearest the
  // camera in an iso view, so this click lands on the round face.
  const mid = await screen([OFF, OFF, OFF]);
  await page.evaluate(() => window.__fundacad.handleAction("text-on-face"));
  await page.waitForTimeout(300);
  check("the tool starts", await page.evaluate(() => window.__fundacad.textOnFace.active));
  await page.mouse.click(mid.x, mid.y);
  const opened = await page.waitForSelector("textarea", { timeout: 15000 }).then(() => true, () => false);
  check("clicking the wall opens the text panel", opened);
  const first = await live();
  check("a round face is anchored by fingerprint and (u, v) fractions",
    !!first && first.face.by === "match" && first.face.fp?.surface === "cylinder" && Array.isArray(first.at),
    JSON.stringify(first && { by: first.face.by, at: first.at }));

  // Drag the anchor sideways along the wall.
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 40, mid.y, { steps: 5 });
  await page.mouse.move(mid.x + 80, mid.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const dragged = await live();
  check("a drag moves the anchor round the wall",
    !!dragged && !!first && Math.abs(dragged.at[0] - first.at[0]) > 0.01 && Math.abs(dragged.at[1] - first.at[1]) < 0.2,
    JSON.stringify({ from: first?.at, to: dragged?.at }));

  await page.click("textarea");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("FUNDA");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "text_1_preview.png") });
  await page.keyboard.press("Control+Enter");
  await settle();
  let st = await state();
  const t = st.texts[0];
  check("commit writes one textOnFace with the typed text", st.texts.length === 1 && t.text === "FUNDA" && t.operation === "join" && t.height === 8 && t.depth === 1,
    JSON.stringify(t && { text: t.text, op: t.operation, h: t.height, d: t.depth }));
  const dv = st.vol - base.vol;
  // "FUNDA" at 8 mm in the default font is about 52 mm2, times 1 mm and 1 + d/2r.
  check("the letters stand up from the wall, about area times depth", st.errors.length === 0 && dv > 35 && dv < 80, `dV ${dv.toFixed(3)} ${st.errors.join("; ")}`);
  await page.screenshot({ path: path.join(OUT, "text_2_embossed.png") });

  if (t) {
    await page.evaluate((id) => window.store.updateFeature(id, { operation: "cut" }), t.id);
    await settle();
    st = await state();
    const cut = base.vol - st.vol;
    check("Engrave cuts about the same volume", st.errors.length === 0 && cut > 0.85 * dv && cut < dv, `embossed ${dv.toFixed(3)}, engraved ${cut.toFixed(3)}`);
    await page.evaluate((id) => window.store.updateFeature(id, { operation: "join" }), t.id);
    await settle();
  }

  await page.evaluate(async () => { window.store.setParam("r", 25); await window.store.rebuildNow(); });
  await settle();
  st = await state();
  const dv25 = st.vol - base25.vol;
  check("after r 20 to 25 the text is still on the wall at its size", st.errors.length === 0 && Math.abs(dv25 - dv * (1 + 1 / 50) / (1 + 1 / 40)) < 0.01 * dv,
    `dV ${dv25.toFixed(3)} vs ${(dv * (1 + 1 / 50) / (1 + 1 / 40)).toFixed(3)} ${st.errors.join("; ")}`);
  await page.screenshot({ path: path.join(OUT, "text_3_wider.png") });

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
