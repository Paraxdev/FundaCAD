// Shell a selected face by dragging its wall, in a real browser.
//
//   1. Shell with a face selected opens straight on that face with a thickness
//      handle, no second pick.
//   2. Dragging the wall thicker than the body can take is refused: the handle
//      turns red, the prompt says why, and letting go adds nothing.
//   3. Dragging back to a wall that builds and letting go commits one shell of
//      that thickness on that face.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/shell_from_selection_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "shell_from_selection_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  const idle = () => page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  const prompt = () => page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "");
  const shells = () => page.evaluate(() => window.store.document.features.filter((f) => f.type === "shell").map((f) => ({ thickness: f.thickness, faces: f.faces })));
  const busy = () => page.evaluate(() => window.__fundacad.busyWhy().faceOffset);

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "circle", id: "c1", x: 0, y: 0, radius: 25 }] });
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 30, operation: "new" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(1200);

  await page.evaluate(() => {
    const top = window.viewport.faceIdNear([0, 0, 30]);
    window.viewport.selectFaces([top]);
  });
  await page.evaluate(() => window.__fundacad.handleAction("shell"));
  await page.waitForTimeout(500);
  const p0 = await prompt();
  check("Shell opens on the selected face", (await busy()) === true && !/click a face/i.test(p0), JSON.stringify(p0));
  await page.screenshot({ path: path.join(OUT, "01_opened.png") });

  // Aim at the tool's own handle: its anchor, and a point a little way along its axis.
  const aim = await page.evaluate(() => {
    const t = window.__fundacad.faceOffset;
    const k = window.viewport.pixelWorldSize(t.anchor);
    const s0 = window.viewport.projectToScreen(t.anchor.clone());
    const s1 = window.viewport.projectToScreen(t.anchor.clone().addScaledVector(t.axis, k * 20));
    return { x: s0.x + (s1.x - s0.x) * 0.6, y: s0.y + (s1.y - s0.y) * 0.6, dx: s1.x - s0.x, dy: s1.y - s0.y, k };
  });
  const len = Math.hypot(aim.dx, aim.dy) || 1;
  const ux = aim.dx / len, uy = aim.dy / len;
  // Screen pixels per mm along the axis, so drags can aim at a wall.
  const perMm = len / (aim.k * 20);
  const grabAt = aim;

  const dragTo = async (mm) => {
    await page.mouse.move(grabAt.x + ux * mm * perMm, grabAt.y + uy * mm * perMm, { steps: 8 });
    await page.waitForTimeout(200);
    await idle();
    await page.waitForTimeout(300);
  };
  await page.mouse.move(grabAt.x, grabAt.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await dragTo(40);
  const refused = await prompt();
  check("a wall thicker than the body is refused on screen", /refused/i.test(refused), JSON.stringify(refused));
  await page.screenshot({ path: path.join(OUT, "02_refused.png") });
  await page.mouse.up();
  await page.waitForTimeout(800);
  await idle();
  check("letting go on a refused wall adds no shell", (await shells()).length === 0, JSON.stringify(await shells()));
  check("and the tool stays open to drag back", (await busy()) === true);

  await page.mouse.move(grabAt.x, grabAt.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await dragTo(-36);
  await page.waitForTimeout(300);
  const back = await prompt();
  check("dragging back clears the refusal", !/refused/i.test(back), JSON.stringify(back));
  await page.mouse.up();
  await page.waitForTimeout(1000);
  await idle();
  const got = await shells();
  check("letting go on a wall that builds commits one shell", got.length === 1 && got[0].thickness > 0 && got[0].thickness < 25, JSON.stringify(got));
  const err = await page.evaluate(() => window.store.buildState.errorMessage ?? null);
  check("and the model builds", err === null, String(err));
  check("the tool is done", (await busy()) === false);
  await page.screenshot({ path: path.join(OUT, "03_committed.png") });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
