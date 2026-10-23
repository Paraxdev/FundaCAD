// Smart sketch dimensions, placed with the mouse in a real browser.
//
//   1. Two endpoints of a diagonal line: hovering beside them places a vertical
//      distance, above them a horizontal one, off a corner an aligned one.
//   2. A single line pick does the same; aligned stays a plain length.
//   3. Two lines: the cursor's wedge picks acute or obtuse, the reflex toggle the
//      outside, and a typed value solves into that wedge.
//   4. A radius placed outside its arc keeps its label there; an arc diameter
//      keeps its placement.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/smart_dims_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "smart_dims_shots");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
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
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({
      id: "s1",
      type: "sketch",
      plane: "XY",
      entities: [
        { type: "line", id: "d1", x1: 10, y1: 10, x2: 40, y2: 50 },
        { type: "line", id: "d2", x1: 50, y1: 10, x2: 80, y2: 50 },
        { type: "line", id: "d3", x1: 90, y1: 10, x2: 120, y2: 50 },
        { type: "line", id: "len", x1: 10, y1: -60, x2: 40, y2: -20 },
        { type: "line", id: "a1", x1: 60, y1: -40, x2: 90, y2: -40 },
        { type: "line", id: "a2", x1: 75, y1: -40 + 15 * Math.sqrt(3), x2: 60, y2: -40 },
        { type: "arc", id: "arc", x1: -20, y1: -40, x2: -40, y2: -40, mx: -30, my: -30 },
        { type: "arc", id: "arcd", x1: -20, y1: 20, x2: -40, y2: 20, mx: -30, my: 30 },
      ],
    });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.mouse.move(800, 450);
  for (let k = 0; k < 3; k++) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(600);
  const scr = (x, y) =>
    page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const click = async (x, y) => {
    const s = await scr(x, y);
    await page.mouse.move(s.x, s.y, { steps: 4 });
    await page.waitForTimeout(80);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(250);
  };
  const hover = async (x, y) => {
    const s = await scr(x, y);
    await page.mouse.move(s.x, s.y, { steps: 6 });
    await page.waitForTimeout(200);
  };
  const lastCon = () => page.evaluate(() => JSON.parse(JSON.stringify(window.sketch.constraints.at(-1))));
  const ent = (id) =>
    page.evaluate((id) => JSON.parse(JSON.stringify(window.sketch.entities.find((e) => e.id === id))), id);
  const boxValue = () =>
    page.evaluate(() => {
      const i = document.querySelector(".dim-input input, .dim-input-field input, [data-dim-field] input");
      return i ? i.value : null;
    });
  /** pick, hover where the label goes, place it (or leave it where the hover put it),
   *  then commit the typed value or the measurement */
  const place = async (picks, at, typed, clickToPlace = true) => {
    await page.evaluate(() => window.sketch.setTool("dimension"));
    await page.waitForTimeout(200);
    for (const p of picks) await click(...p);
    await hover(...at);
    const shown = await boxValue();
    if (clickToPlace) await click(...at);
    if (typed !== undefined) await page.keyboard.type(String(typed));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    return { c: await lastCon(), shown };
  };

  // 1. two endpoints
  let r = await place(
    [
      [10, 10],
      [40, 50],
    ],
    [70, 30],
  );
  check(
    "beside the pair places a vertical distance",
    r.c.type === "vDistance" && near(r.c.value, 40),
    JSON.stringify(r),
  );
  r = await place(
    [
      [50, 10],
      [80, 50],
    ],
    [65, 85],
  );
  check(
    "above the pair places a horizontal distance",
    r.c.type === "hDistance" && near(r.c.value, 30),
    JSON.stringify(r),
  );
  r = await place(
    [
      [90, 10],
      [120, 50],
    ],
    [135, 70],
  );
  check(
    "off a corner places an aligned distance",
    r.c.type === "p2pDistance" && near(r.c.value, 50),
    JSON.stringify(r),
  );
  await page.screenshot({ path: path.join(OUT, "sd-1-point-pairs.png") });

  // 2. a single line, horizontal with a typed value: only x of the free end moves
  r = await place([[25, -40]], [25, -8], 20);
  const len = await ent("len");
  check(
    "a line picked alone and placed above makes a horizontal distance",
    r.c.type === "hDistance" && r.c.e1 === "len" && r.c.e2 === "len",
    JSON.stringify(r.c),
  );
  check(
    "typing 20 solves the line to a 20 mm horizontal run",
    near(Math.abs(len.x2 - len.x1), 20, 1e-4),
    JSON.stringify(len),
  );

  // 3. angles: obtuse wedge, then reflex, with a typed value
  const polar = (r, deg) => [60 + r * Math.cos((deg * Math.PI) / 180), -40 + r * Math.sin((deg * Math.PI) / 180)];
  r = await place(
    [
      [78, -40],
      [70.5, -40 + 10.5 * Math.sqrt(3)],
    ],
    polar(12, 120),
  );
  check(
    "the cursor in the obtuse wedge places 120",
    r.c.type === "angle" && near(r.c.value, 120, 1e-3) && Array.isArray(r.c.rays),
    JSON.stringify(r.c),
  );
  await page.screenshot({ path: path.join(OUT, "sd-2-obtuse.png") });
  await page.evaluate(() => window.sketch.setTool("dimension"));
  await click(78, -40);
  await click(70.5, -40 + 10.5 * Math.sqrt(3));
  await page.evaluate(() => window.sketch.dimFlow.toggleReflex());
  await hover(...polar(18, 30));
  const reflexShown = await page.evaluate(() => window.sketch.dimFlow.plan.measure(window.sketch.dimFlow.modeOffset()));
  check("the reflex toggle measures 300 outside the 60 wedge", near(reflexShown, 300, 1e-3), String(reflexShown));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  r = await place(
    [
      [78, -40],
      [70.5, -40 + 10.5 * Math.sqrt(3)],
    ],
    polar(18, 30),
    45,
    false,
  );
  const a2 = await ent("a2");
  const dirs = [Math.atan2(a2.y2 - a2.y1, a2.x2 - a2.x1), Math.atan2(a2.y1 - a2.y2, a2.x1 - a2.x2)].map(
    (a) => ((a * 180) / Math.PI + 360) % 360,
  );
  const a1 = await ent("a1");
  const a1dir = ((Math.atan2(a1.y2 - a1.y1, a1.x2 - a1.x1) * 180) / Math.PI + 360) % 360;
  const between = dirs.map((d) => (((d - a1dir) % 360) + 360) % 360);
  check(
    "hovering the acute wedge and typing 45, without a placement click, solves to 45 there",
    r.c.type === "angle" && near(r.c.value, 45) && between.some((d) => near(d, 45, 1e-2)),
    JSON.stringify({ c: r.c, between }),
  );
  await page.screenshot({ path: path.join(OUT, "sd-3-angle-45.png") });

  // 4. radius outside an arc, arc diameter placement
  r = await place([[-30, -30]], [-30, -15]);
  const cd = await page.evaluate(() =>
    JSON.parse(JSON.stringify(window.sketch.cdims.map((d) => ({ i: d.cIndex, x: d.labelPos.x, y: d.labelPos.y })))),
  );
  const idx = await page.evaluate(() => window.sketch.constraints.length - 1);
  const lab = cd.find((d) => d.i === idx);
  check(
    "a radius placed outside the arc keeps its label outside",
    r.c.type === "radius" && lab && Math.hypot(lab.x + 30, lab.y + 40) > 10.5,
    JSON.stringify({ c: r.c, lab }),
  );
  await page.evaluate(() => window.sketch.setTool("dimension"));
  await click(-30, 30);
  await page.evaluate(() => window.sketch.setDimRoundPref("diameter"));
  await hover(-30, 5);
  await click(-30, 5);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  const dc = await lastCon();
  check(
    "an arc diameter keeps its placement",
    dc.type === "diameter" && !!dc.place && dc.place.oy < 0,
    JSON.stringify(dc),
  );
  await page.screenshot({ path: path.join(OUT, "sd-4-radius-diameter.png") });

  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
