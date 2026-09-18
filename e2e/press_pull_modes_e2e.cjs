// Press/pull as a boolean, in a real browser.
//
//   1. The operation button on the input box steps Auto -> Join, and a pull of
//      one box's side face with Join merges it into the box 10mm away.
//   2. In Auto, pushing a boss's top face past the plate under it cuts through.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/press_pull_modes_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "press_pull_modes_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }
  const settle = async () => {
    await page.waitForTimeout(400);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
    await page.waitForTimeout(400);
  };
  const bodies = () => page.evaluate(() => (window.store.buildState.result?.bodies ?? []).map((b) => b.id));
  const screen = (x, y, z) => page.evaluate(([x, y, z]) => {
    const v = window.viewport; const V = v.camera.position.constructor;
    return v.projectToScreen(new V(x, y, z));
  }, [x, y, z]);
  const reset = async (features) => {
    await page.evaluate(async (fs) => {
      window.store.loadDocument({ parameters: {}, features: fs });
      await window.store.rebuildNow();
    }, features);
    await settle();
    await page.evaluate(() => { window.__fundacad.handleAction("iso"); });
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.__fundacad.handleAction("fit"); });
    await page.waitForTimeout(1000);
  };
  const rect = (id, w, h, x = 0, y = 0) => ({ id, type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: w, height: h, x, y }] });

  // --- 1. Join into the neighbouring box ---------------------------------------
  await reset([
    rect("a", 20, 20), { id: "ea", type: "extrude", sketch: "a", distance: 20, operation: "new" },
    rect("b", 20, 20, 30), { id: "eb", type: "extrude", sketch: "b", distance: 20, operation: "new" },
  ]);
  check("two boxes to start", (await bodies()).length === 2, await bodies());
  let at = await screen(10, -3, 12);
  await page.evaluate(() => window.__fundacad.handleAction("presspull"));
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(500);
  await page.keyboard.type("15");
  await page.waitForTimeout(300);
  const toggle = await page.$(".dim-input .dim-toggle");
  check("the input box has an operation button", !!toggle);
  const label0 = toggle ? await toggle.textContent() : null;
  if (toggle) await toggle.dispatchEvent("pointerdown");
  await page.waitForTimeout(300);
  const label1 = toggle ? await toggle.textContent() : null;
  check("it starts on Auto and steps to Join", label0 === "Auto" && label1 === "Join", [label0, label1]);
  await settle();
  await page.screenshot({ path: path.join(OUT, "01_join_preview.png") });
  await page.keyboard.press("Enter");
  await settle();
  await page.waitForTimeout(800);
  await settle();
  const pp = await page.evaluate(() => window.store.document.features.filter((f) => f.type === "press-pull").map((f) => ({ mode: f.mode, distance: f.distance })));
  check("it commits a Join press/pull", pp.length === 1 && pp[0].mode === "join" && pp[0].distance === 15, pp);
  check("which merges the two boxes into one body", (await bodies()).length === 1, await bodies());
  await page.screenshot({ path: path.join(OUT, "02_joined.png") });

  // --- 2. Auto pushes through ---------------------------------------------------
  await reset([
    rect("s1", 40, 40), { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" },
    { id: "s2", type: "sketch", plane: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] }, entities: [{ type: "rectangle", width: 10, height: 10, x: 0, y: 0 }] },
    { id: "e2", type: "extrude", sketch: "s2", distance: 5, operation: "join" },
  ]);
  at = await screen(0, 0, 15);
  await page.evaluate(() => window.__fundacad.handleAction("presspull"));
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(500);
  await page.keyboard.type("-25");
  await page.keyboard.press("Enter");
  await settle();
  await page.waitForTimeout(800);
  await settle();
  const err = await page.evaluate(() => window.store.buildState.errorFeatureId ?? null);
  check("a push past the plate builds", err === null, err);
  const feats = await page.evaluate(() => window.store.document.features.filter((f) => f.type === "press-pull").map((f) => f.distance));
  check("and keeps the full -25, not a clamped push", feats.length === 1 && feats[0] === -25, feats);
  await page.evaluate(() => window.__fundacad.handleAction("top"));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, "03_through.png") });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
