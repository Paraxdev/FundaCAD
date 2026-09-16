// Sketch, click the profile, pull, pull again, in a real browser.
//
//   1. A plain click on a closed profile inside a sketch, with no curves picked,
//      finishes the sketch and leaves that profile selected with its extrude
//      handle offered. With a curve picked, the same click only swaps the
//      selection to the profile and the sketch stays open.
//   2. Pulling that handle and letting go commits an extrude, and the handle
//      stays on the far face. Pulling it again edits the SAME extrude rather
//      than stacking a second one.
//   3. A click on empty space puts the lingering handle away.
//   4. Finishing selects the sketch, and double-clicking a visible profile
//      reopens its sketch.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/sketch_click_pull_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "sketch_click_pull_shots");
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
  await page.waitForFunction(() => !!window.store && !!window.sketch && !!window.viewport, null, { timeout: 60000 });

  const idle = () => page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  const inSketch = (x, y) => page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const extrudes = () => page.evaluate(() => window.store.document.features.filter((f) => f.type === "extrude").map((f) => ({ id: f.id, distance: f.distance })));
  const offered = () => page.evaluate(() => !!window.__fundacad.nudge.want);

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [
      { type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 40 },
    ] });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.waitForTimeout(200);

  // --- 1a. with a curve picked the click only swaps to the profile ---------
  {
    const rim = await inSketch(20, 5);
    await page.mouse.click(rim.x, rim.y);
    await page.waitForTimeout(300);
    const picked = await page.evaluate(() => window.sketch.selected.size);
    check("clicking the rectangle's side picks it", picked > 0, `${picked} picked`);
    const inside = await inSketch(5, 5);
    await page.mouse.click(inside.x, inside.y);
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => ({ active: window.sketch.active, picked: window.sketch.selected.size }));
    check("CONTROL: with a curve picked, a profile click keeps the sketch open and drops the curve", s.active && s.picked === 0, JSON.stringify(s));
  }

  // --- 1b. nothing picked: the click finishes and offers the handle ----------
  {
    const inside = await inSketch(-5, -5);
    await page.mouse.click(inside.x, inside.y);
    await page.waitForTimeout(800);
    await idle();
    const s = await page.evaluate(() => ({
      active: window.sketch.active,
      regions: window.overlay.selectedRegions().length,
    }));
    check("a profile click with nothing picked finishes the sketch", s.active === false, JSON.stringify(s));
    check("and leaves that profile selected", s.regions === 1, JSON.stringify(s));
    check("with the extrude handle offered on it", await offered());
    const picked = await page.evaluate(() => window.__fundacad.selectedFeature());
    check("and the finished sketch is the selected feature", picked === "s1", JSON.stringify(picked));
    await page.screenshot({ path: path.join(OUT, "01_profile_clicked.png") });
  }

  // --- 2. pull, release, handle stays, pull again edits the same feature ------
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(1200);
  const drag = async (from, dy) => {
    await page.mouse.move(from.x, from.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y - dy / 2, { steps: 6 });
    await page.mouse.move(from.x, from.y - dy, { steps: 6 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    await idle();
    await page.waitForTimeout(300);
  };
  {
    const a = await page.evaluate(() => {
      const r = window.overlay.selectedRegions()[0];
      return window.viewport.projectToScreen(r.interior3D.clone());
    });
    await drag(a, 80);
    const ex = await extrudes();
    check("pulling the profile handle commits one extrude", ex.length === 1 && ex[0].distance > 0, JSON.stringify(ex));
    check("the handle stays up on the committed extrude", await offered());
    await page.screenshot({ path: path.join(OUT, "02_first_pull.png") });

    const top = await page.evaluate(() => {
      const last = window.extrude.lastCommit;
      return last ? window.viewport.projectToScreen(last.top.clone()) : null;
    });
    check("the lingering handle stands on the far face", !!top, JSON.stringify(top));
    if (top) {
      await drag(top, 60);
      const ex2 = await extrudes();
      check("pulling it again edits the same extrude, no second one", ex2.length === 1 && ex2[0].id === ex[0]?.id, JSON.stringify(ex2));
      check("and the depth grew", ex2.length === 1 && ex2[0].distance > (ex[0]?.distance ?? Infinity), JSON.stringify({ before: ex[0]?.distance, after: ex2[0]?.distance }));
      await page.screenshot({ path: path.join(OUT, "03_second_pull.png") });
    }
  }

  // --- 3. a click elsewhere puts it away --------------------------------------
  {
    await page.mouse.click(1000, 760);
    await page.waitForTimeout(500);
    check("a click on empty space puts the handle away", !(await offered()));
  }

  // --- 4. double-clicking a visible profile reopens its sketch --------------------
  {
    await page.evaluate(async () => {
      window.store.addFeature({ id: "s2", type: "sketch", plane: "XY", entities: [
        { type: "rectangle", id: "r2", x: 50, y: 0, width: 30, height: 30 },
      ] });
      await window.store.rebuildNow();
    });
    await idle();
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(1200);
    const p = await page.evaluate(() => {
      const r = window.overlay.regions.find((w) => w.sketchId === "s2");
      return r ? window.viewport.projectToScreen(r.interior3D.clone()) : null;
    });
    check("the second sketch shows a profile", !!p, JSON.stringify(p));
    if (p) {
      await page.mouse.dblclick(p.x, p.y);
      await page.waitForTimeout(1500);
      const s = await page.evaluate(() => ({ active: window.sketch.active, id: window.sketch.editingSketchId }));
      check("double-clicking the profile reopens its sketch", s.active && s.id === "s2", JSON.stringify(s));
      await page.screenshot({ path: path.join(OUT, "04_dblclick_profile.png") });
    }
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
