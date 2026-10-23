// Sketch constraints applied from the right-click menu, in a real browser:
// select with a click and Shift clicks, right click, pick the menu item, then
// read back the recorded constraint, the solved geometry and the glyph count.
//
//   1. On curve for a point and a line, a circle, an arc; Midpoint; Align
//      horizontally; Symmetric across an axis line.
//   2. A lone arc offers Fix centre and Radius, a lone circle Fix centre.
//   3. Three lines offer an Equal chain, three points a Coincident chain.
//   4. A rectangle side is a Parallel operand.
//   5. H with a line selected makes it horizontal, the tangent tool on two
//      lines says why it refuses.
//   6. Shift+P, Shift+L, Shift+C and I apply to the selection, the select tool
//      stays armed, I on two points is Coincident; a box selected rectangle is not read as a side clicked earlier.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/constraint_menu_e2e.cjs [outDir]
// SC_URL and SC_ENGINE_PORT point it at another vite and engine.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "constraint_menu_shots");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: (process.env.SC_CHROME_ARGS ?? "--use-angle=swiftshader --no-sandbox").split(" ").filter(Boolean),
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.addInitScript(
    ([t, port]) => {
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
    [TOKEN, ENGINE_PORT],
  );
  await page.goto(URL);
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
        { type: "line", id: "L", x1: 0, y1: 0, x2: 40, y2: 10 },
        { type: "point", id: "P", x: 20, y: 22 },
        { type: "circle", id: "C", x: 80, y: 0, radius: 10 },
        { type: "point", id: "P2", x: 100, y: 12 },
        { type: "arc", id: "A", x1: 90, y1: 40, x2: 70, y2: 40, mx: 80, my: 50 },
        { type: "point", id: "P3", x: 95, y: 60 },
        { type: "line", id: "N", x1: 40, y1: -20, x2: 70, y2: -20 },
        { type: "point", id: "M", x: 52, y: -8 },
        { type: "point", id: "H1", x: -60, y: 0 },
        { type: "point", id: "H2", x: -40, y: 7 },
        { type: "line", id: "S", x1: -50, y1: -40, x2: -50, y2: -15 },
        { type: "point", id: "U1", x: -62, y: -20 },
        { type: "point", id: "U2", x: -38, y: -48 },
        { type: "line", id: "T1", x1: 0, y1: 60, x2: 20, y2: 66 },
        { type: "line", id: "T2", x1: 30, y1: 60, x2: 45, y2: 72 },
        { type: "line", id: "T3", x1: 55, y1: 60, x2: 70, y2: 63 },
        { type: "point", id: "W1", x: 0, y: 90 },
        { type: "point", id: "W2", x: 15, y: 95 },
        { type: "point", id: "W3", x: 30, y: 88 },
        { type: "rectangle", id: "Q", x: 15, y: -50, width: 30, height: 20 },
        { type: "line", id: "B", x1: 0, y1: -80, x2: 30, y2: -74 },
        { type: "line", id: "K1", x1: -85, y1: 40, x2: -68, y2: 46 },
        { type: "line", id: "K2", x1: -85, y1: 55, x2: -68, y2: 65 },
        { type: "line", id: "K3", x1: 110, y1: -30, x2: 128, y2: -26 },
        { type: "line", id: "K4", x1: 110, y1: -50, x2: 128, y2: -40 },
        { type: "circle", id: "C1", x: 115, y: 30, radius: 5 },
        { type: "circle", id: "C2", x: 115, y: 55, radius: 6 },
        { type: "line", id: "L4", x1: -85, y1: -60, x2: -68, y2: -70 },
        { type: "point", id: "P4", x: -75, y: -80 },
        { type: "circle", id: "C3", x: 115, y: 85, radius: 6 },
        { type: "point", id: "P5", x: 125, y: 100 },
        { type: "point", id: "P6", x: 100, y: -70 },
        { type: "point", id: "P7", x: 115, y: -80 },
      ],
    });
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.evaluate(() => window.sketch.lookAt());
  await page.waitForTimeout(800);
  await page.mouse.move(700, 450);
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "cm-0-setup.png") });

  const scr = (x, y) =>
    page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const cons = () => page.evaluate(() => JSON.parse(JSON.stringify(window.sketch.constraints)));
  const ents = () =>
    page.evaluate(() => Object.fromEntries(window.sketch.entities.map((e) => [e.id, JSON.parse(JSON.stringify(e))])));
  const glyphs = () => page.evaluate(() => document.querySelectorAll(".sketch-glyphs > *").length);
  // Escape with nothing to cancel would leave the sketch, so clear by hand
  const clear = async () => {
    await page.evaluate(() => {
      window.sketch.selected.clear();
      window.sketch.refreshActive();
    });
    await page.waitForTimeout(150);
  };
  const pick = async (xy, shift = false) => {
    const s = await scr(...xy);
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.click(s.x, s.y);
    if (shift) await page.keyboard.up("Shift");
    await page.waitForTimeout(150);
  };
  const select = async (...pts) => {
    await clear();
    for (let i = 0; i < pts.length; i++) await pick(pts[i], i > 0);
  };
  const menu = async (xy) => {
    const s = await scr(...xy);
    await page.mouse.click(s.x, s.y, { button: "right" });
    await page.waitForTimeout(250);
    return page.evaluate(() =>
      [...document.querySelectorAll(".context-menu .ctx-item .ctx-label")].map((el) => el.textContent.trim()),
    );
  };
  const choose = async (label) => {
    const row = page
      .locator(".context-menu .ctx-item")
      .filter({ has: page.locator(".ctx-label", { hasText: new RegExp(`^${label}$`) }) })
      .first();
    await row.click();
    await page.waitForTimeout(400);
  };
  // select, right click, choose: returns the constraints the item added and the glyph growth
  const apply = async (pts, at, label) => {
    await select(...pts);
    const before = await cons(),
      g0 = await glyphs();
    const labels = await menu(at);
    if (!labels.includes(label)) {
      await page.keyboard.press("Escape");
      return { labels, added: [], grew: 0 };
    }
    await choose(label);
    return { labels, added: (await cons()).slice(before.length), grew: (await glyphs()) - g0 };
  };
  const types = (a) => JSON.stringify(a.map((c) => c.type));
  const len = (l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  const distToLine = (p, l) => Math.abs((l.x2 - l.x1) * (l.y1 - p.y) - (l.x1 - p.x) * (l.y2 - l.y1)) / len(l);

  // 1. two picks
  let r = await apply(
    [
      [20, 22],
      [30, 7.5],
    ],
    [30, 7.5],
    "On curve",
  );
  let e = await ents();
  check(
    "point and line: On curve recorded",
    types(r.added) === '["pointOnCurve"]' && r.added[0].curve === "L",
    JSON.stringify(r),
  );
  check(
    "the point sits on the line, with a glyph",
    distToLine(e.P, e.L) < 1e-6 && r.grew > 0,
    `d ${distToLine(e.P, e.L).toExponential(2)}, glyphs +${r.grew}`,
  );

  r = await apply(
    [
      [100, 12],
      [70, 0],
    ],
    [70, 0],
    "On curve",
  );
  e = await ents();
  check(
    "point and circle: On curve recorded",
    types(r.added) === '["pointOnCurve"]' && r.added[0].curve === "C",
    JSON.stringify(r.labels),
  );
  check(
    "the point sits on the circle",
    Math.abs(Math.hypot(e.P2.x - e.C.x, e.P2.y - e.C.y) - e.C.radius) < 1e-6,
    JSON.stringify(e.P2),
  );

  r = await apply(
    [
      [95, 60],
      [80, 50],
    ],
    [80, 50],
    "On curve",
  );
  e = await ents();
  check(
    "point and arc: On curve recorded",
    types(r.added) === '["pointOnCurve"]' && r.added[0].curve === "A",
    JSON.stringify(r.labels),
  );
  await page.screenshot({ path: path.join(OUT, "cm-1-on-curve.png") });

  r = await apply(
    [
      [52, -8],
      [62, -20],
    ],
    [62, -20],
    "Midpoint",
  );
  e = await ents();
  check("point and line: Midpoint recorded", types(r.added) === '["midpoint"]', JSON.stringify(r.labels));
  check(
    "the point sits at the middle of the line",
    Math.hypot(e.M.x - (e.N.x1 + e.N.x2) / 2, e.M.y - (e.N.y1 + e.N.y2) / 2) < 1e-6,
    JSON.stringify(e.M),
  );

  r = await apply(
    [
      [-60, 0],
      [-40, 7],
    ],
    [-40, 7],
    "Align horizontally",
  );
  e = await ents();
  check("two points: Align horizontally recorded", types(r.added) === '["horizontalPoints"]', JSON.stringify(r.labels));
  check("the two points share a height", Math.abs(e.H1.y - e.H2.y) < 1e-6, `${e.H1.y} ${e.H2.y}`);
  check("and Align vertically is offered beside it", r.labels.includes("Align vertically"), JSON.stringify(r.labels));

  r = await apply(
    [
      [-62, -20],
      [-38, -48],
      [-50, -35],
    ],
    [-50, -35],
    "Symmetric",
  );
  e = await ents();
  check("two points and an axis: Symmetric recorded", types(r.added) === '["symmetric"]', JSON.stringify(r.labels));
  const sd = { x: e.S.x2 - e.S.x1, y: e.S.y2 - e.S.y1 };
  const across = Math.abs((e.U2.x - e.U1.x) * sd.x + (e.U2.y - e.U1.y) * sd.y) / len(e.S);
  const off = distToLine({ x: (e.U1.x + e.U2.x) / 2, y: (e.U1.y + e.U2.y) / 2 }, e.S);
  check(
    "the points mirror across the axis",
    across < 1e-6 && off < 1e-6,
    `along ${across.toExponential(2)}, mid off ${off.toExponential(2)}`,
  );
  await page.screenshot({ path: path.join(OUT, "cm-2-symmetric.png") });

  // 2. lone rounds
  // the On curve solve above may have moved the arc and the circle
  const arcAt = [e.A.mx, e.A.my],
    rimAt = [e.C.x + e.C.radius, e.C.y];
  await select(arcAt);
  let labels = await menu(arcAt);
  check(
    "a lone arc offers Fix centre and Radius",
    labels.includes("Fix centre") && labels.includes("Radius"),
    JSON.stringify(labels),
  );
  let before = await cons();
  await choose("Radius");
  let added = (await cons()).slice(before.length);
  const A = e.A,
    la = Math.hypot(A.x2 - A.mx, A.y2 - A.my),
    lb = Math.hypot(A.x1 - A.mx, A.y1 - A.my),
    lc = Math.hypot(A.x2 - A.x1, A.y2 - A.y1);
  const arcR = (la * lb * lc) / (2 * Math.abs((A.x1 - A.mx) * (A.y2 - A.my) - (A.x2 - A.mx) * (A.y1 - A.my)));
  check(
    "Radius records the arc's radius",
    types(added) === '["radius"]' && Math.abs(added[0].value - arcR) < 1e-3,
    `${JSON.stringify(added)} vs ${arcR.toFixed(4)}`,
  );
  await select(rimAt);
  labels = await menu(rimAt);
  check(
    "a lone circle offers Fix centre and Radius",
    labels.includes("Fix centre") && labels.includes("Radius"),
    JSON.stringify(labels),
  );
  before = await cons();
  await choose("Fix centre");
  added = (await cons()).slice(before.length);
  check("Fix centre fixes the circle centre", types(added) === '["fix"]' && added[0].e === "C", JSON.stringify(added));

  // 3. chains
  r = await apply(
    [
      [10, 63],
      [37.5, 66],
      [62.5, 61.5],
    ],
    [62.5, 61.5],
    "Equal",
  );
  e = await ents();
  check("three lines: an Equal chain of two", types(r.added) === '["equal","equal"]', JSON.stringify(r.labels));
  check(
    "all three lines share a length",
    Math.abs(len(e.T1) - len(e.T2)) < 1e-6 && Math.abs(len(e.T1) - len(e.T3)) < 1e-6,
    [len(e.T1), len(e.T2), len(e.T3)].map((v) => v.toFixed(4)).join(" "),
  );
  check(
    "and Parallel and Collinear chains are offered",
    r.labels.includes("Parallel") && r.labels.includes("Collinear"),
    JSON.stringify(r.labels),
  );

  r = await apply(
    [
      [0, 90],
      [15, 95],
      [30, 88],
    ],
    [30, 88],
    "Coincident",
  );
  e = await ents();
  check(
    "three points: a Coincident chain of two",
    types(r.added) === '["coincident","coincident"]',
    JSON.stringify(r.labels),
  );
  check(
    "the three points meet",
    Math.hypot(e.W1.x - e.W2.x, e.W1.y - e.W2.y) < 1e-6 && Math.hypot(e.W1.x - e.W3.x, e.W1.y - e.W3.y) < 1e-6,
    JSON.stringify([e.W1, e.W2, e.W3]),
  );
  await page.screenshot({ path: path.join(OUT, "cm-3-chains.png") });

  // 4. a rectangle side as an operand
  r = await apply(
    [
      [15, -77],
      [10, -60],
    ],
    [10, -60],
    "Parallel",
  );
  e = await ents();
  check(
    "a line and a rectangle side: Parallel recorded on that side",
    types(r.added) === '["parallel"]' && /^Q~\d$/.test(r.added[0].l2),
    JSON.stringify(r),
  );
  check("the line turned level with the bottom side", Math.abs(e.B.y2 - e.B.y1) < 1e-6, JSON.stringify(e.B));

  // 5. keys and the tangent refusal
  const mid = async (id) => {
    const l = (await ents())[id];
    return [(l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2];
  };
  await select(await mid("T3"));
  before = await cons();
  await page.keyboard.press("h");
  await page.waitForTimeout(400);
  added = (await cons()).slice(before.length);
  check(
    "H with a line selected records horizontal",
    types(added) === '["horizontal"]' && added[0].line === "T3",
    JSON.stringify(added),
  );

  await clear();
  await page.evaluate(() => window.sketch.setTool("tangent"));
  before = await cons();
  await pick(await mid("T1"));
  await pick(await mid("T2"));
  await page.waitForTimeout(300);
  const said = await page.evaluate(() => document.body.innerText.includes("Two lines cannot be tangent"));
  check(
    "tangent on two lines adds nothing and says why",
    (await cons()).length === before.length && said,
    `toast ${said}`,
  );
  await page.screenshot({ path: path.join(OUT, "cm-4-tangent-refusal.png") });

  // 6. modifier keys apply to the selection
  const at = (id, t) =>
    ents().then((m) => {
      const l = m[id];
      return [l.x1 + (l.x2 - l.x1) * t, l.y1 + (l.y2 - l.y1) * t];
    });
  const rim = (id) => ents().then((m) => [m[id].x + m[id].radius, m[id].y]);
  const key = async (pts, combo) => {
    await select(...pts);
    const b = await cons();
    const picked = await page.evaluate(() => [...window.sketch.selected]);
    await page.keyboard.press(combo);
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => ({
      tool: window.sketch.tool,
      sel: window.sketch.selected.size,
      input: document.activeElement?.tagName === "INPUT",
    }));
    return { picked, added: (await cons()).slice(b.length), ...st };
  };
  await page.evaluate(() => window.sketch.setTool("select"));
  let k = await key([await at("K1", 0.8), await at("K2", 0.8)], "Shift+P");
  check(
    "Shift+P on two lines records parallel and keeps the select tool",
    types(k.added) === '["parallel"]' && k.tool === "select" && k.sel === 2,
    JSON.stringify(k),
  );
  k = await key([await at("K3", 0.8), await at("K4", 0.8)], "Shift+L");
  check(
    "Shift+L on two lines records collinear",
    types(k.added) === '["collinear"]' && k.tool === "select",
    JSON.stringify(k),
  );
  k = await key([await rim("C1"), await rim("C2")], "Shift+C");
  check(
    "Shift+C on two circles records concentric",
    types(k.added) === '["concentric"]' && k.tool === "select",
    JSON.stringify(k),
  );
  k = await key([[-75, -80], await at("L4", 0.8)], "i");
  check(
    "I on a point and a line records On curve",
    types(k.added) === '["pointOnCurve"]' && k.added[0].curve === "L4" && !k.input,
    JSON.stringify(k),
  );
  k = await key([[125, 100], await rim("C3")], "i");
  check(
    "I on a point and a circle puts the point on the rim",
    types(k.added) === '["pointOnCurve"]' && k.added[0].curve === "C3",
    JSON.stringify(k),
  );
  e = await ents();
  check(
    "the point sits on the circle C3",
    Math.abs(Math.hypot(e.P5.x - e.C3.x, e.P5.y - e.C3.y) - e.C3.radius) < 1e-6,
    JSON.stringify(e.P5),
  );

  k = await key(
    [
      [100, -70],
      [115, -80],
    ],
    "i",
  );
  check("I on two points records Coincident", types(k.added) === '["coincident"]' && !k.input, JSON.stringify(k));
  e = await ents();
  check("the two points meet", Math.hypot(e.P6.x - e.P7.x, e.P6.y - e.P7.y) < 1e-6, JSON.stringify([e.P6, e.P7]));

  await select([e.Q.x, e.Q.y + e.Q.height / 2]);
  await clear();
  const s0 = await scr(e.Q.x - e.Q.width / 2 - 6, -88),
    s1 = await scr(e.Q.x + e.Q.width / 2 + 6, e.Q.y + e.Q.height / 2 + 5);
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down();
  await page.mouse.move((s0.x + s1.x) / 2, (s0.y + s1.y) / 2, { steps: 4 });
  await page.mouse.move(s1.x, s1.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const boxed = await page.evaluate(() => [...window.sketch.selected].sort());
  labels = await menu(await at("B", 0.9));
  check(
    "a box selected rectangle offers no side constraint from an old click",
    boxed.includes("Q") && boxed.includes("B") && !labels.includes("Parallel"),
    `${JSON.stringify(boxed)} ${JSON.stringify(labels)}`,
  );
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(OUT, "cm-5-keys.png") });

  await browser.close();
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
