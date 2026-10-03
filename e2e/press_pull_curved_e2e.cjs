// Press/pull on a sphere, a cone and a torus, in a real browser.
//
// Scenes, each a 40x40x20 block centred on the origin (top face at z 10):
//   A. a sphere dimple: a ball of radius 6 centred at z 14 cut from the top.
//   B. a countersink: a 90 degree cone from r 5 at the top down to a r 2 bore.
//   C. a torus fillet: a r 6 boss on the top, its root filleted at r 2.
//
//   1. The dimple reads R 6 with the arrow pointing away from its centre and a
//      dashed line out from the centre; dragging grows it through the engine
//      and Enter commits it. Picked again it reads its new radius; R 3 makes
//      the face disappear, so the refusal is in the box and R 8 stays on screen.
//   2. The countersink reads an Offset along the normal where it was picked,
//      with no Angle field, no mode switch and no up to; dragging it in cuts.
//   3. The torus fillet reads an Offset too; typing -0.5 previews and commits.
//
// Shots: 01_dimple, 02_dimple_grown, 03_dimple_refused, 04_dimple_committed,
//        05_countersink, 06_countersink_cut, 07_torus, 08_torus_offset.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5974/ SC_ENGINE_PORT=8974 \
//     node e2e/press_pull_curved_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "press_pull_curved_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const line = (id, a, b) => ({ type: "line", id, x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
const polygon = (pts) => pts.map((p, i) => line(`l${i}`, p, pts[(i + 1) % pts.length]));
const block = { id: "block", type: "box", length: 40, width: 40, height: 20 };
const revolve = (id, entities, operation) => [
  { id: `${id}_sk`, type: "sketch", plane: "XZ", entities },
  { id, type: "revolve", sketch: `${id}_sk`, axis: "Z", angle: 360, operation, targets: ["body1"] },
];
const S45 = 6 * Math.SQRT1_2;

const DIMPLE = [block, ...revolve("dimple", [
  { type: "arc", id: "a", x1: 0, y1: 8, x2: 6, y2: 14, mx: S45, my: 14 - S45 },
  line("t", [6, 14], [0, 14]),
  line("s", [0, 14], [0, 8]),
], "cut")];
const COUNTERSINK = [block, ...revolve("cs", polygon([[0, -11], [2, -11], [2, 7], [5, 10], [5, 11], [0, 11]]), "cut")];
const TORUS = [
  block,
  ...revolve("boss", polygon([[0, 9], [6, 9], [6, 15], [0, 15]]), "join"),
  { id: "root", type: "fillet", edges: { kind: "edge", by: "nearest", point: [6, 0, 10] }, radius: 2 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript((port) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) { super(String(u).replace(":8765", `:${port}`), p); }
    }
    window.WebSocket = P;
  }, ENGINE_PORT);
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const settle = async () => {
    await page.waitForTimeout(500);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 180000 });
    await page.waitForTimeout(400);
  };
  const load = async (features) => {
    await page.evaluate(async (fs) => {
      window.store.loadDocument({ parameters: {}, features: fs });
      await window.store.rebuildNow();
    }, features);
    await settle();
    const err = await page.evaluate(() => window.store.buildState.errorMessage ?? null);
    check("the scene builds", err === null, err);
  };
  const volume = () => page.evaluate(() => window.viewport.bodyProperties(null)?.volume ?? null);
  const look = (eye, at) => page.evaluate(([e, a]) => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(...e), new V(...a));
    v.requestRender();
  }, [eye, at]);
  const tool = () => page.evaluate(() => {
    const t = window.pressPull;
    const box = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none");
    const labels = [...(box?.querySelectorAll("label.dim-field") ?? [])].filter((l) => l.style.display !== "none")
      .map((l) => { const n = l.querySelector(".dim-name"); return n ? (n.title || n.textContent) : null; });
    const toggle = box?.querySelector(".dim-toggle");
    const dirBtn = box?.querySelector(".dim-direction");
    const r = (v) => [v.x, v.y, v.z].map((c) => Math.round(c * 1000) / 1000);
    return {
      active: t.active,
      value: t.value,
      kind: t.curve?.kind ?? null,
      centre: t.round?.centre ?? null,
      labels,
      field: box?.querySelector("input")?.value ?? null,
      toggle: toggle && toggle.style.display !== "none" ? toggle.textContent : null,
      direction: dirBtn && dirBtn.style.display !== "none" ? dirBtn.textContent : null,
      axis: r(t.axis),
      anchor: r(t.anchor),
      problem: box?.querySelector(".dim-problem")?.textContent ?? null,
      refused: t.outcomes.refusal,
      shown: t.outcomes.shownFeature ? { type: t.outcomes.shownFeature.type, distance: t.outcomes.shownFeature.distance } : null,
      previewError: window.store.previewError,
      held: window.store.buildState.heldRefusal?.code ?? null,
      sizeLine: !!t.guides?.sizeLine,
      prompt: document.querySelector("#prompt")?.textContent ?? "",
    };
  });
  const select = async (point) => {
    await page.evaluate((p) => {
      const v = window.viewport;
      v.clearSelection?.();
      v.selectFaces([v.faceIdNear(p)]);
    }, point);
    await page.evaluate(() => window.__fundacad.handleAction("presspull"));
    await page.waitForFunction(() => window.pressPull.curve != null, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(300);
  };
  const drag = async (until, { release = true } = {}) => {
    const grip = await page.evaluate(() => {
      const t = window.pressPull; const v = window.viewport;
      const at = t.anchor.clone().addScaledVector(t.axis, t.value);
      const k = v.pixelWorldSize(at);
      const s = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 25 * (t.value < 0 ? -1 : 1)));
      const ahead = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 60));
      const s0 = v.projectToScreen(at);
      return { x: s.x, y: s.y, dx: ahead.x - s0.x, dy: ahead.y - s0.y, hit: t.hitGizmo(s.x, s.y) };
    });
    const len = Math.hypot(grip.dx, grip.dy) || 1;
    const [ux, uy] = [grip.dx / len, grip.dy / len];
    const sign = until > (await tool()).value ? 1 : -1;
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    let x = grip.x, y = grip.y;
    for (let i = 0; i < 300; i++) {
      x += ux * 2 * sign; y += uy * 2 * sign;
      await page.mouse.move(x, y);
      const v = (await tool()).value;
      if (sign > 0 ? v >= until : v <= until) break;
    }
    if (release) await page.mouse.up();
    return grip.hit;
  };
  const typeValue = async (text) => {
    await page.evaluate(() => {
      const i = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none").querySelector("input");
      i.focus();
      i.select();
    });
    await page.keyboard.type(text);
  };
  const lastPush = () => page.evaluate(() => window.store.document.features.filter((f) => f.type === "press-pull").at(-1) ?? null);
  const built = () => page.evaluate(() => ({ active: window.pressPull.active, err: window.store.buildState.errorFeatureId ?? null }));
  const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((c) => c / n); };

  // --- 1. the sphere dimple ------------------------------------------------------
  await load(DIMPLE);
  const vDimple = await volume();
  await look([30, -30, 34], [0, 0, 8]);
  await page.waitForTimeout(400);
  // The bare selection, before any tool or answer from the engine.
  const bare = await page.evaluate((p) => {
    const v = window.viewport;
    v.clearSelection?.();
    v.selectFaces([v.faceIdNear(p)]);
    const f = v.selectedFacesForPressPull();
    return f && { normal: f.normal.toArray(), anchor: f.anchor.toArray() };
  }, [0, 0, 8]);
  const bareAway = bare && unit([bare.anchor[0], bare.anchor[1], bare.anchor[2] - 14]);
  check("the selection handle already points away from the centre", !!bare &&
    bare.normal.every((c, i) => Math.abs(c - bareAway[i]) < 1e-2), bare);
  await select([0, 0, 8]);
  let t = await tool();
  check("the dimple reads as a sphere", t.active && t.kind === "sphere", t);
  check("its field reads R 6 with no angle and no mode", t.labels.join() === "R" && Math.abs(Number(t.field) - 6) < 0.005 && t.toggle === null, t);
  const away = unit([t.anchor[0], t.anchor[1], t.anchor[2] - 14]);
  check("the arrow points away from the centre", t.centre && Math.hypot(...t.centre.map((c, i) => c - [0, 0, 14][i])) < 1e-3 &&
    t.axis.every((c, i) => Math.abs(c - away[i]) < 1e-2), { axis: t.axis, away, centre: t.centre });
  check("a dashed size line runs out from the centre", t.sizeLine, t);
  check("the prompt asks for a radius", /type a radius/.test(t.prompt), t.prompt);
  await shot("01_dimple");

  const hit = await drag(1, { release: false });
  check("the arrow is under the pointer where it is drawn", hit);
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.shownFeature != null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("dragging out grows it, a cut through the engine", t.value >= 1 && t.shown && t.shown.distance < 0 && t.previewError === null && t.refused === null, t);
  check("the field reads the new radius", Math.abs(Number(t.field) - (6 + t.value)) < 0.005, t);
  const vGrown = await volume();
  check("the preview took material away", vGrown < vDimple - 1, { vDimple, vGrown });
  await shot("02_dimple_grown");
  const grownTo = t.shown.distance;
  await page.mouse.up();
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await settle();
  let pp = await lastPush();
  check("the release committed the grown dimple", pp && pp.distance === grownTo && !("mode" in pp) && !("taper" in pp), pp);
  const vCommitted = await volume();
  check("and it builds", (await built()).err === null && Math.abs(vCommitted - vGrown) < 1e-6 * vGrown, { vCommitted, vGrown });
  await shot("04_dimple_committed");

  await select([0, 0, 8 + grownTo]);
  t = await tool();
  check("picked again it reads its new radius", t.kind === "sphere" && Math.abs(Number(t.field) - (6 - grownTo)) < 0.01, t);
  await typeValue("8");
  await page.waitForTimeout(300);
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.shownFeature != null, null, { timeout: 120000 }).catch(() => {});
  const vEight = await volume();
  await typeValue("3");
  await page.waitForTimeout(300);
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.refusal !== null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("R 3 is refused in the box", !!t.problem && t.refused !== null && t.held !== null, t);
  check("and R 8 is held on screen", Math.abs((await volume()) - vEight) < 1e-6 * vEight && t.shown && Math.abs(t.shown.distance + (8 - (6 - grownTo))) < 1e-6, { v: await volume(), vEight, shown: t.shown });
  await shot("03_dimple_refused");
  await page.keyboard.press("Escape");
  await settle();

  // --- 2. the countersink ----------------------------------------------------------
  await load(COUNTERSINK);
  const vCs = await volume();
  await look([24, -30, 34], [0, 0, 6]);
  await page.waitForTimeout(400);
  const csAt = [-3.5 * Math.SQRT1_2, 3.5 * Math.SQRT1_2, 8.5];
  await select(csAt);
  t = await tool();
  check("the countersink reads as a cone", t.active && t.kind === "cone", t);
  check("its field reads an Offset with no angle, mode or direction", t.labels.join() === "Offset" && Number(t.field) === 0 && t.toggle === null && t.direction === null, t);
  // The cone's outward normal where the arrow stands: toward the axis and up, square to its 45 degree slope.
  const csNormal = unit([-t.anchor[0], -t.anchor[1], Math.hypot(t.anchor[0], t.anchor[1])]);
  check("the arrow is the normal where it was picked, not along the axis", t.axis.every((c, i) => Math.abs(c - csNormal[i]) < 0.08), { axis: t.axis, csNormal });
  check("the prompt asks how far it moves", /how far it moves, negative cuts/.test(t.prompt), t.prompt);
  await shot("05_countersink");
  await drag(-0.5, { release: false });
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.shownFeature != null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("dragging in cuts the countersink wider", t.value <= -0.5 && t.shown && t.shown.distance < 0 && t.previewError === null, t);
  check("the field reads the signed offset", Number(t.field) < 0, t.field);
  const vCut = await volume();
  check("the preview took material away", vCut < vCs - 1, { vCs, vCut });
  await shot("06_countersink_cut");
  await page.mouse.up();
  await page.keyboard.press("Enter");
  await settle();
  pp = await lastPush();
  check("Enter commits a plain offset", pp && pp.distance < 0 && ["mode", "taper", "upTo", "direction", "followTangent"].every((k) => !(k in pp)), pp);
  check("and it builds", (await built()).err === null);

  // --- 3. the torus fillet -----------------------------------------------------------
  await load(TORUS);
  const vT = await volume();
  await look([30, -36, 30], [0, 0, 11]);
  await page.waitForTimeout(400);
  const fil = [-(8 - 2 * Math.SQRT1_2) * Math.SQRT1_2, -(8 - 2 * Math.SQRT1_2) * Math.SQRT1_2, 12 - 2 * Math.SQRT1_2];
  await select(fil);
  t = await tool();
  check("the fillet reads as a torus", t.active && t.kind === "torus", t);
  check("its field reads an Offset with no angle or mode", t.labels.join() === "Offset" && t.toggle === null, t);
  await shot("07_torus");
  await typeValue("-0.5");
  await page.waitForTimeout(300);
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.shownFeature != null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("-0.5 previews through the engine", t.shown && t.shown.distance === -0.5 && t.previewError === null && t.refused === null, t);
  const vTo = await volume();
  check("pushing the concave fillet in takes material away", vTo < vT - 0.1, { vT, vTo });
  await shot("08_torus_offset");
  await page.keyboard.press("Enter");
  await settle();
  pp = await lastPush();
  check("Enter commits it", pp && pp.distance === -0.5 && !("mode" in pp), pp);
  check("and it builds", (await built()).err === null);

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
