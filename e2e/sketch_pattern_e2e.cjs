// Dragging a sketch pattern, in a real browser.
//
//   0. Choosing the circular pattern with a selection starts it at once, centred
//      on that selection, and its centre dot drags and snaps onto the origin.
//   1. A circular pattern takes its total angle from the DRAG. Before this it
//      could only be typed, the cursor did nothing.
//   2. The sweep keeps climbing past half a turn instead of flipping sign, and
//      coming round to a full turn snaps to exactly 360.
//   3. A rect pattern carries a direction, so one row of copies marches along
//      the drag at any heading rather than only along X.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/sketch_pattern_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "sketch_pattern_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript((t) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, TOKEN);
  await page.goto("http://localhost:5173/");
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

  const scr = (x, y) => page.evaluate(([x, y]) => {
    const s = window.sketch;
    return window.viewport.projectToScreen(s.plane.to3D(x, y));
  }, [x, y]);
  const pats = () => page.evaluate(() => JSON.parse(JSON.stringify(window.sketch.patterns || [])));

  // select the source circle
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.waitForTimeout(300);
  {
    const p = await scr(35, 0); // on the circle's rim
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => [...window.sketch.selected]);
    check("the source circle is selected", s.join() === "c1", JSON.stringify(s));
  }

  // --- circular: starts on the selection, drag its centre dot, then sweep ---
  await page.evaluate(() => window.sketch.setTool("patternCircular"));
  await page.waitForTimeout(300);
  {
    const centre = () => page.evaluate(() => {
      const f = window.sketch.patternFlow;
      return f && f.pending ? { cx: f.pending.cx, cy: f.pending.cy } : null;
    });
    let at = await centre();
    check("choosing the tool starts the pattern centred on the selection", !!at && near(at.cx, 30, 0.001) && near(at.cy, 0, 0.001), JSON.stringify(at));
    await page.screenshot({ path: path.join(OUT, "00_started_on_selection.png") });

    const from = await scr(30, 0);
    const c = await scr(0, 0);
    await page.mouse.move(from.x + 3, from.y + 2);
    await page.mouse.down();
    await page.mouse.move(c.x + 20, c.y - 10, { steps: 10 });
    await page.mouse.move(c.x + 2, c.y + 1, { steps: 3 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, "00b_dragging_centre.png") });
    await page.mouse.up();
    await page.waitForTimeout(300);
    at = await centre();
    check("dragging the centre dot snaps it onto the origin", !!at && near(at.cx, 0, 1e-6) && near(at.cy, 0, 1e-6), JSON.stringify(at));
    const still = await page.evaluate(() => {
      const f = window.sketch.patternFlow;
      return !!(f && f.pending) && window.sketch.patterns.length === 0;
    });
    check("the centre drag does not commit the pattern", still);

    const sweepTo = async (deg) => {
      const r = 30;
      const a = (deg * Math.PI) / 180;
      const p = await scr(r * Math.cos(a), r * Math.sin(a));
      await page.mouse.move(p.x, p.y, { steps: 3 });
      await page.waitForTimeout(60);
    };
    // walk round in small steps so the sweep can accumulate continuously
    for (let d = 15; d <= 90; d += 15) await sweepTo(d);
    let ang = await page.evaluate(() => {
      const f = window.sketch.patternFlow;
      const p = f && f.pending ? f.pending : null;
      return p && typeof p.angle === "number" ? p.angle : null;
    });
    check("a quarter turn drag reads about 90 degrees", near(ang, 90, 16), `angle ${ang}`);
    await page.screenshot({ path: path.join(OUT, "01_sweep_90.png") });

    for (let d = 105; d <= 270; d += 15) await sweepTo(d);
    ang = await page.evaluate(() => {
      const f = window.sketch.patternFlow;
      return f && f.pending ? f.pending.angle : null;
    });
    check("past half a turn it keeps climbing, it does not flip sign", ang > 180, `angle ${ang}`);
    await page.screenshot({ path: path.join(OUT, "02_sweep_270.png") });

    for (let d = 285; d <= 359; d += 12) await sweepTo(d);
    ang = await page.evaluate(() => {
      const f = window.sketch.patternFlow;
      return f && f.pending ? f.pending.angle : null;
    });
    check("coming round to a full turn snaps to 360", near(ang, 360, 0.001), `angle ${ang}`);
    await page.screenshot({ path: path.join(OUT, "03_sweep_full.png") });

    const c2 = await scr(30, -1);
    await page.mouse.move(c2.x, c2.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(500);
    const list = await pats();
    const circ = list.find((p) => p.type === "patternCircular");
    check("the circular pattern committed", !!circ, JSON.stringify(list.map((p) => p.type)));
    await page.screenshot({ path: path.join(OUT, "04_committed.png") });
  }

  // --- rect: one row marches along the drag, at any heading ---
  await page.evaluate(() => window.sketch.undoEdit());
  await page.waitForTimeout(600);
  {
    const left = await pats();
    check("undo takes the committed pattern back off", left.length === 0, JSON.stringify(left.map((p) => p.type)));
  }
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.waitForTimeout(300);
  {
    const p = await scr(35, 0);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => [...window.sketch.selected]);
    check("the source is selectable again after the undo", s.join() === "c1", JSON.stringify(s));
  }
  await page.evaluate(() => window.sketch.setTool("patternRect"));
  await page.waitForTimeout(300);
  {
    const kept = await page.evaluate(() => [...window.sketch.selected]);
    check("choosing the pattern tool keeps the selection it needs", kept.join() === "c1", JSON.stringify(kept));

    const c = await scr(30, 0);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
    const a = (45 * Math.PI) / 180;
    const to = await scr(30 + 20 * Math.cos(a), 20 * Math.sin(a));
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.waitForTimeout(200);
    const pend = await page.evaluate(() => {
      const f = window.sketch.patternFlow;
      return f && f.pending ? { angle: f.pending.angle, sx: f.pending.spacingX, cy: f.pending.countY } : null;
    });
    check("a row dragged at 45 degrees carries that direction", pend && near(pend.angle, 45, 0.001), JSON.stringify(pend));
    check("its pitch is the drag length, not just the X part", pend && near(pend.sx, 20, 1.5), JSON.stringify(pend));
    await page.screenshot({ path: path.join(OUT, "05_row_45.png") });
  }

  console.log(`\n${failures === 0 ? "all checks passed" : failures + " check(s) failed"}`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})();
