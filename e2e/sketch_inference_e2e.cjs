// Sketch inference while drawing, in a real browser: each relation shows as a
// glyph beside the cursor before the click and is recorded by the click.
//
//   1. A chain: horizontal, vertical, then parallel to a slanted line.
//   2. A line leaving an arc end along its tangent, one ending on a midpoint,
//      one ending on a circle; Ctrl+Z takes the last relation with its line.
//   3. A sketch fillet records two tangencies; a tangent arc records one.
//   4. With Snap off a midpoint end records nothing.
//   5. Escape and a tool switch take the glyph away, Ctrl places without a
//      guess, and only the line and arc tools snap onto a curve.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/sketch_inference_e2e.cjs [outDir]
// SC_URL and SC_ENGINE_PORT point it at another vite and engine.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "sketch_inference_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: (process.env.SC_CHROME_ARGS ?? "--use-angle=swiftshader --no-sandbox").split(" ").filter(Boolean) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(([t, port]) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        const s = String(u).replace(":8765", `:${port}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, [TOKEN, ENGINE_PORT]);
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  const k = { x: 90 + 10 * Math.cos(Math.PI / 4), y: 10 * Math.sin(Math.PI / 4) };
  await page.evaluate(async (k) => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [
      { type: "line", id: "R", x1: 0, y1: 60, x2: 34.641, y2: 80 },
      { type: "arc", id: "K", x1: 100, y1: 0, x2: k.x, y2: k.y, mx: 90 + 10 * Math.cos(Math.PI / 8), my: 10 * Math.sin(Math.PI / 8) },
      { type: "line", id: "M", x1: 0, y1: -40, x2: 40, y2: -40 },
      { type: "circle", id: "C", x: 70, y: -60, radius: 10 },
    ] });
    await window.store.rebuildNow();
  }, k);
  await page.evaluate(() => window.__fundacad.editFeature("s1"));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.sketch.setTool("select"));
  await page.mouse.move(800, 450);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }
  await page.waitForTimeout(600);

  const scr = (x, y) => page.evaluate(([x, y]) => window.viewport.projectToScreen(window.sketch.plane.to3D(x, y)), [x, y]);
  const hover = async (x, y, dy = 0) => { const s = await scr(x, y); await page.mouse.move(s.x, s.y + dy, { steps: 6 }); await page.waitForTimeout(200); return { x: s.x, y: s.y + dy }; };
  const click = async (x, y, dy = 0) => { const s = await hover(x, y, dy); await page.mouse.click(s.x, s.y); await page.waitForTimeout(250); };
  const tag = () => page.evaluate(() => {
    const el = document.querySelector('[data-testid="infer-tag"]');
    return el && !el.hidden ? el.dataset.relations : "";
  });
  const cons = () => page.evaluate(() => JSON.parse(JSON.stringify(window.sketch.constraints)));
  const ents = () => page.evaluate(() => JSON.parse(JSON.stringify(window.sketch.entities)));
  const newCons = async (before) => (await cons()).slice(before.length);
  const tool = (t) => page.evaluate((t) => window.sketch.setTool(t), t);
  const polar = (o, len, deg) => [o[0] + len * Math.cos((deg * Math.PI) / 180), o[1] + len * Math.sin((deg * Math.PI) / 180)];

  // 1. chain
  await tool("line");
  let before = await cons();
  await click(0, 0);
  await hover(40, 0.6);
  check("a nearly level line shows the horizontal glyph before the click", (await tag()) === "horizontal", await tag());
  await click(40, 0.6);
  await hover(40.6, 30);
  check("then a nearly upright one shows vertical", (await tag()) === "vertical", await tag());
  await click(40.6, 30);
  const par = polar([40, 30], 25, 31.5);
  await hover(...par);
  check("a line 1.5 degrees off the slanted line shows parallel", (await tag()) === "parallel", await tag());
  await page.screenshot({ path: path.join(OUT, "si-1-parallel-glyph.png") });
  await click(...par);
  // the first click landed on the Origin, which pins a fixed point there
  let added = (await newCons(before)).filter((c) => c.type !== "fix");
  const joins = added.filter((c) => c.type === "coincident");
  added = added.filter((c) => c.type !== "coincident");
  check("the chain recorded horizontal, vertical, parallel", JSON.stringify(added.map((c) => c.type)) === '["horizontal","vertical","parallel"]', JSON.stringify(added));
  check("and a coincident on each of its two joins", joins.length === 2 && joins.every((c) => c.p1 === 0 && c.p2 === 1), JSON.stringify(joins));
  const all = await ents();
  const l3 = all[all.length - 1];
  const ang = (Math.atan2(l3.y2 - l3.y1, l3.x2 - l3.x1) * 180) / Math.PI;
  const rAng = (Math.atan2(20, 34.641) * 180) / Math.PI;
  check("the parallel line was committed exactly parallel, as previewed", Math.abs(ang - rAng) < 1e-6, `${ang} vs ${rAng}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // 2. tangent off an arc, midpoint, on curve, undo
  before = await cons();
  await click(k.x, k.y);
  const tan = polar([k.x, k.y], 20, 136.5);
  await hover(...tan);
  check("leaving the arc end along it shows tangent", (await tag()) === "tangent2", await tag());
  await click(...tan);
  await page.keyboard.press("Escape");
  await click(10, -10);
  await hover(20, -40);
  check("ending on a line's midpoint shows midpoint", (await tag()) === "midpoint", await tag());
  await click(20, -40);
  await page.keyboard.press("Escape");
  await click(95, -30);
  await hover(70, -50, -3); // 3 px off the circle's top
  check("ending just off a circle shows on curve", (await tag()) === "pointOnCurve", await tag());
  await page.screenshot({ path: path.join(OUT, "si-2-on-curve-glyph.png") });
  await click(70, -50, -3);
  await page.keyboard.press("Escape");
  added = await newCons(before);
  check("the arc end join, tangent2, midpoint and pointOnCurve were recorded", JSON.stringify(added.map((c) => c.type)) === '["coincident","tangent2","midpoint","pointOnCurve"]', JSON.stringify(added));
  const onEnd = (await ents()).at(-1);
  check("the on-curve end sits on the circle", Math.abs(Math.hypot(onEnd.x2 - 70, onEnd.y2 + 60) - 10) < 1e-6, JSON.stringify(onEnd));
  const nBefore = (await ents()).length, cBefore = (await cons()).length;
  await page.evaluate(() => window.sketch.undoEdit());
  await page.waitForTimeout(400);
  check("one undo takes the last line and its pointOnCurve together",
    (await ents()).length === nBefore - 1 && (await cons()).length === cBefore - 1 && (await cons()).at(-1).type === "midpoint");

  // 3. fillet and tangent arc
  before = await cons();
  await tool("fillet");
  await click(20, 0);
  await click(40, 15);
  await page.keyboard.type("5");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  // the fillet pulls the corner apart, so its recorded join goes and the list is not just appended to
  const had = new Set(before.map((c) => JSON.stringify(c)));
  const now = await cons();
  added = now.filter((c) => !had.has(JSON.stringify(c)));
  const gone = before.filter((c) => !now.some((d) => JSON.stringify(d) === JSON.stringify(c)));
  check("a sketch fillet records its two tangencies", added.length === 2 && added.every((c) => c.type === "tangent2"), JSON.stringify(added));
  check("and drops the corner join it pulled apart", gone.length === 1 && gone[0].type === "coincident", JSON.stringify(gone));
  before = await cons();
  await tool("arc");
  await page.keyboard.press("a");
  await click(l3.x2, l3.y2);
  await hover(l3.x2 + 5, l3.y2 + 20);
  check("the tangent arc shows tangent before its click", (await tag()) === "tangent2", await tag());
  await page.screenshot({ path: path.join(OUT, "si-3-tangent-arc.png") });
  await click(l3.x2 + 5, l3.y2 + 20);
  added = await newCons(before);
  check("the tangent arc records its join and tangent2 to the parallel line",
    added.length === 2 && added[0].type === "coincident" && added[0].e2 === l3.id && added[1].type === "tangent2" && added[1].b === l3.id, JSON.stringify(added));
  await page.keyboard.press("a");

  // 4. snap off
  await page.evaluate(() => window.sketch.setGridSnap(false));
  await tool("line");
  before = await cons();
  await click(-10, -20);
  await click(20, -40);
  await page.keyboard.press("Escape");
  added = await newCons(before);
  check("with Snap off a midpoint end records nothing", !added.some((c) => c.type === "midpoint"), JSON.stringify(added));
  await page.evaluate(() => window.sketch.setGridSnap(true));

  // 5. glyph lifetime, Ctrl, curve snap per tool
  await tool("line");
  await click(0, 120);
  await hover(40, 120.6);
  const shown = await tag();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("Escape takes the glyph away", shown === "horizontal" && (await tag()) === "", `${shown} then ${await tag()}`);
  await click(0, 120);
  await hover(40, 120.6);
  await tool("select");
  await page.waitForTimeout(150);
  check("a tool switch takes the glyph away", (await tag()) === "", await tag());
  await tool("line");
  before = await cons();
  await click(0, 100);
  const freeEnd = polar([0, 100], 25, 31.5);
  await hover(...freeEnd);
  const plainTag = await tag();
  await page.keyboard.down("Control");
  await hover(...freeEnd, 1);
  await hover(...freeEnd);
  const ctrlTag = await tag();
  await click(...freeEnd);
  await page.keyboard.up("Control");
  await page.keyboard.press("Escape");
  added = await newCons(before);
  check("with Ctrl held a line 1.5 degrees off parallel guesses nothing", plainTag === "parallel" && ctrlTag === "" && !added.some((c) => c.type === "parallel"), `${plainTag} ${ctrlTag} ${JSON.stringify(added)}`);
  await tool("circle");
  await hover(70, -50, -3);
  const circleKind = await page.evaluate(() => window.sketch.lastHit?.kind);
  check("the circle tool does not snap onto a curve", circleKind !== "curve", circleKind);
  await tool("select");

  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
