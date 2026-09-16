// Circular pattern chosen with nothing selected, then the badge that reopens it.
//
//   1. With nothing selected, a click inside a circle's profile picks that circle
//      as the source instead of refusing.
//   2. The next click places the centre, a move sweeps, a click commits.
//   3. The committed pattern shows a badge; clicking it reopens the pattern for
//      editing, and a new sweep replaces the old angle.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/pattern_pick_and_badge_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "pattern_pick_and_badge_shots");
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

  await page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [
      { type: "circle", id: "c1", x: 30, y: 0, radius: 5 },
    ] });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(3000);
  const scr = (x, y) => page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const pats = () => page.evaluate(() => JSON.parse(JSON.stringify(window.sketch.patterns || [])));

  await page.evaluate(() => { window.sketch.selected.clear(); window.sketch.setTool("patternCircular"); });
  await page.waitForTimeout(300);
  check("nothing selected, nothing pending", await page.evaluate(() => window.sketch.selected.size === 0 && !window.sketch.patternFlow.hasPending()));

  {
    const inside = await scr(31, 1);
    await page.mouse.click(inside.x, inside.y);
    await page.waitForTimeout(400);
    const sel = await page.evaluate(() => [...window.sketch.selected]);
    check("a click inside the circle picks it as the source", sel.join() === "c1", JSON.stringify(sel));
    check("and does not start the pattern yet", !(await page.evaluate(() => window.sketch.patternFlow.hasPending())));
  }
  {
    const o = await scr(0, 0);
    await page.mouse.click(o.x, o.y);
    await page.waitForTimeout(300);
    check("the next click places the centre", await page.evaluate(() => window.sketch.patternFlow.hasPending()));
    const a = await scr(0, 30);
    await page.mouse.move(a.x, a.y, { steps: 10 });
    const b = await scr(-30, 0);
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, "01_sweeping.png") });
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(500);
    const ps = await pats();
    check("a click commits one circular pattern of that circle about the origin",
      ps.length === 1 && ps[0].type === "patternCircular" && ps[0].sources.join() === "c1" && Math.hypot(ps[0].cx, ps[0].cy) < 1.5,
      JSON.stringify(ps));
  }

  await page.evaluate(() => window.sketch.setTool("select"));
  await page.waitForTimeout(500);
  const badge = await page.$(".sketch-glyph.pattern");
  check("the pattern shows a badge", !!badge);
  await page.screenshot({ path: path.join(OUT, "02_badge.png") });
  if (badge) {
    const before = (await pats())[0].angle;
    await badge.click();
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => ({ pending: window.sketch.patternFlow.hasPending(), tool: window.sketch.tool }));
    check("clicking the badge reopens the pattern", st.pending && st.tool === "patternCircular", JSON.stringify(st));
    const c = await scr(0, -30);
    const d = await scr(21, -21);
    await page.mouse.move(c.x, c.y, { steps: 6 });
    await page.mouse.move(d.x, d.y, { steps: 6 });
    await page.waitForTimeout(200);
    await page.mouse.click(d.x, d.y);
    await page.waitForTimeout(500);
    const ps = await pats();
    check("a new sweep replaces the old one, still one pattern", ps.length === 1 && ps[0].angle !== before, `${before} -> ${JSON.stringify(ps.map((p) => p.angle))}`);
    await page.screenshot({ path: path.join(OUT, "03_edited.png") });
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
