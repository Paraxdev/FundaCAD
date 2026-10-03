// Where the press/pull handle stands on curved faces, in a real browser.
//
//   1. Clicking the c1 slot end (f6..f8 suppressed) stands the selection
//      handle on the crown of the arc, on the surface, pointing straight out
//      along the radius; grabbing it arms the tool on the same spot and
//      direction, and the engine's answer does not move it.
//   2. The whole slot loop selected face by face reads R 2.00 like the lone
//      end, and dragging it out widens the slot through the engine.
//   3. A pointed cone picked at its apex offsets along its axis.
//   4. A sphere dimple shows its cap ghost the moment it is dragged, before
//      the engine's preview lands.
//
// Shots: 01_end_handle, 02_end_grabbed, 03_run_r, 04_run_grown, 05_cone_apex,
//        06_dimple_ghost.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5974/ SC_ENGINE_PORT=8974 \
//     node e2e/press_pull_handle_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "press_pull_handle_shots");
const C1 = path.join(__dirname, "../crates/fundacad-geom/tests/press_pull/c1_slot_end.json");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const SLOT_LOOP = { endPlus: [0, 9.125, 20], endMinus: [0, -16.875, 20], wallLow: [0, -3.875, 18], wallHigh: [0, -3.875, 22] };
const line = (id, a, b) => ({ type: "line", id, x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
const polygon = (pts) => pts.map((p, i) => line(`l${i}`, p, pts[(i + 1) % pts.length]));
const block = { id: "block", type: "box", length: 40, width: 40, height: 20 };
const revolve = (id, entities, operation) => [
  { id: `${id}_sk`, type: "sketch", plane: "XZ", entities },
  { id, type: "revolve", sketch: `${id}_sk`, axis: "Z", angle: 360, operation, targets: ["body1"] },
];
const S45 = 6 * Math.SQRT1_2;
const TIP = [block, ...revolve("tip", polygon([[0, 9], [6, 9], [6, 10], [0, 18]]), "join")];
const DIMPLE = [block, ...revolve("dimple", [
  { type: "arc", id: "a", x1: 0, y1: 8, x2: 6, y2: 14, mx: S45, my: 14 - S45 },
  line("t", [6, 14], [0, 14]),
  line("s", [0, 14], [0, 8]),
], "cut")];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c1 = JSON.parse(fs.readFileSync(C1, "utf8"));
  const base = { ...c1, suppressed: ["f6", "f7", "f8"] };

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
  const loadDoc = async (doc) => {
    await page.evaluate(async (json) => {
      window.store.load(json);
      await window.store.rebuildNow();
    }, JSON.stringify(doc));
    await settle();
  };
  const loadFeatures = async (features) => {
    await page.evaluate(async (fs) => {
      window.store.loadDocument({ parameters: {}, features: fs });
      await window.store.rebuildNow();
    }, features);
    await settle();
  };
  const view = (eye, at) => page.evaluate(([e, a]) => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(...e), new V(...a));
    v.requestRender();
  }, [eye, at]);
  const r3 = (v) => v && [v.x, v.y, v.z].map((c) => Math.round(c * 1000) / 1000);
  const nudge = () => page.evaluate(() => {
    const w = window.__fundacad.nudge?.want;
    if (!w) return null;
    const r = (v) => [v.x, v.y, v.z].map((c) => Math.round(c * 1000) / 1000);
    return { anchor: r(w.anchor), axis: r(w.axis(window.viewport)) };
  });
  const tool = () => page.evaluate(() => {
    const t = window.pressPull;
    const box = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none");
    const name = box?.querySelector(".dim-name");
    const r = (v) => [v.x, v.y, v.z].map((c) => Math.round(c * 1000) / 1000);
    return {
      active: t.active,
      value: t.value,
      anchor: r(t.anchor),
      axis: r(t.axis),
      round: !!t.round,
      kind: t.curve?.kind ?? null,
      label: name ? (name.title || name.textContent) : null,
      field: box?.querySelector("input")?.value ?? null,
      shown: t.outcomes.shownFeature ? { distance: t.outcomes.shownFeature.distance, faces: Array.isArray(t.outcomes.shownFeature.face) ? t.outcomes.shownFeature.face.length : 1 } : null,
      previewError: window.store.previewError,
      ghost: !!window.viewport.ghosts.ppGhost,
      prompt: document.querySelector("#prompt")?.textContent ?? "",
    };
  });
  // A screen point whose pick lands on the face nearest `target`.
  const screenOn = (target, along) => page.evaluate(([t, pts]) => {
    const v = window.viewport; const V = v.camera.position.constructor;
    const want = v.faceIdNear(t);
    for (const p of pts) {
      const s = v.projectToScreen(new V(...p));
      const hit = v.pickEntity(s.x, s.y);
      if (hit?.kind === "face" && hit.faceId === want) return { x: s.x, y: s.y, faceId: want };
    }
    return null;
  }, [target, along]);
  const grabNudge = async () => {
    const h = await page.evaluate(() => {
      const w = window.__fundacad.nudge.want;
      const k = window.viewport.pixelWorldSize(w.anchor);
      return window.viewport.projectToScreen(w.anchor.clone().addScaledVector(w.axis(window.viewport), k * 20));
    });
    await page.mouse.move(h.x, h.y);
    await page.waitForTimeout(200);
    await page.mouse.down();
    return h;
  };
  const drag = async (until) => {
    const grip = await page.evaluate(() => {
      const t = window.pressPull; const v = window.viewport;
      const at = t.anchor.clone().addScaledVector(t.axis, t.value);
      const k = v.pixelWorldSize(at);
      const s = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 25 * (t.value < 0 ? -1 : 1)));
      const ahead = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 60));
      const s0 = v.projectToScreen(at);
      return { x: s.x, y: s.y, dx: ahead.x - s0.x, dy: ahead.y - s0.y };
    });
    const len = Math.hypot(grip.dx, grip.dy) || 1;
    const [ux, uy] = [grip.dx / len, grip.dy / len];
    const sign = until > (await tool()).value ? 1 : -1;
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    let x = grip.x, y = grip.y;
    for (let i = 0; i < 200; i++) {
      x += ux * 2 * sign; y += uy * 2 * sign;
      await page.mouse.move(x, y);
      const v = (await tool()).value;
      if (sign > 0 ? v >= until : v <= until) break;
    }
  };
  const near = (a, b, tol = 0.01) => !!a && !!b && a.every((c, i) => Math.abs(c - b[i]) <= tol);

  // --- 1. the slot end's handle stands on its crown ----------------------------
  await loadDoc(base);
  await view([43, 1, 25], [25, 6, 20]);
  await page.waitForTimeout(500);
  const endPoints = [];
  for (let x = 24; x >= 14; x -= 2) for (const a of [60, 120, 50, 130]) {
    const r = (a * Math.PI) / 180;
    endPoints.push([x, 7.125 + 2 * Math.sin(r), 20 + 2 * Math.cos(r)]);
  }
  const end = await screenOn(SLOT_LOOP.endPlus, endPoints);
  check("the slot end is under a screen point", end !== null, end);
  // A first click takes the whole body, the second the face under it.
  for (let i = 0; i < 2; i++) {
    await page.mouse.click(end.x, end.y);
    await page.waitForTimeout(400);
  }
  const picked = await page.evaluate(() => window.viewport.highlighter.getSelectedFaces());
  check("the click selected the slot end", picked.length === 1 && picked[0] === end.faceId, picked);
  const n0 = await nudge();
  check("the handle stands on the crown of the arc, on the surface", !!n0 && Math.abs(n0.anchor[1] - 9.125) < 0.01 && Math.abs(n0.anchor[2] - 20) < 0.01, n0);
  check("and points straight out along the radius", near(n0?.axis, [0, 1, 0], 0.002), n0);
  await page.mouse.move(end.x - 80, end.y + 120);
  await page.waitForTimeout(600);
  await shot("01_end_handle");
  await grabNudge();
  await page.waitForTimeout(50);
  const t0 = await tool();
  check("grabbing it arms the tool on the same spot and direction", t0.active && near(t0.anchor, n0.anchor) && near(t0.axis, n0.axis, 0.002), { t0, n0 });
  await page.waitForFunction(() => window.pressPull.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  const t1 = await tool();
  check("the engine's answer does not move it", near(t1.anchor, t0.anchor) && near(t1.axis, t0.axis, 1e-6), { t0, t1 });
  await shot("02_end_grabbed");
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // --- 2. the whole slot reads its ends' radius ---------------------------------
  await page.evaluate((loop) => {
    const v = window.viewport;
    const first = v.faceIdNear(loop.endPlus);
    const others = [loop.wallHigh, loop.endMinus, loop.wallLow].map((p) => v.faceIdNear(p));
    v.selectOnlyFace(first);
    v.selectFaces(others);
    v.onSelectionChange?.();
  }, SLOT_LOOP);
  await page.waitForTimeout(300);
  const nRun = await nudge();
  check("the run's handle points out of its first end", near(nRun?.axis, [0, 1, 0], 0.002), nRun);
  await page.evaluate(() => window.__fundacad.handleAction("presspull"));
  await page.waitForFunction(() => window.pressPull.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  let t = await tool();
  check("the four faces read R 2.00", t.active && t.round && t.label === "R" && Math.abs(Number(t.field) - 2) < 0.005, t);
  await view([55, -30, 26], [22, -4, 20]);
  await page.waitForTimeout(400);
  await shot("03_run_r");
  await drag(0.5);
  await page.mouse.up();
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.shownFeature != null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("dragging out previews all four faces as one widening, with no refusal",
    t.shown && t.shown.faces === 4 && t.shown.distance < 0 && t.previewError === null, t);
  await shot("04_run_grown");
  await page.keyboard.press("Escape");
  await settle();

  // --- 3. a pointed cone picked at its apex --------------------------------------
  await loadFeatures(TIP);
  await view([40, -40, 35], [0, 0, 12]);
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.viewport.clearSelection?.(); window.__fundacad.handleAction("presspull"); });
  await page.waitForTimeout(200);
  const tip = await page.evaluate(() => window.viewport.projectToScreen(new window.viewport.camera.position.constructor(0, 0, 17.95)));
  await page.mouse.click(tip.x, tip.y);
  await page.waitForFunction(() => window.pressPull.curve != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  t = await tool();
  check("the apex reads as a cone offset", t.active && t.kind === "cone" && t.label === "Offset", t);
  check("and offsets along the cone's axis", near(t.axis, [0, 0, 1], 0.01), t.axis);
  await shot("05_cone_apex");
  await page.keyboard.press("Escape");
  await settle();

  // --- 4. a sphere dimple answers at once ----------------------------------------
  await loadFeatures(DIMPLE);
  await view([30, -30, 40], [0, 0, 8]);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const v = window.viewport;
    v.clearSelection?.();
    v.selectFaces([v.faceIdNear([0, 0, 8])]);
    window.__fundacad.handleAction("presspull");
  });
  await page.waitForFunction(() => window.pressPull.curve != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  t = await tool();
  check("the dimple reads R 6", t.kind === "sphere" && t.label === "R" && Math.abs(Number(t.field) - 6) < 0.005, t);
  await drag(1);
  t = await tool();
  check("its cap ghost is up while the engine works", t.ghost && t.shown === null, t);
  await shot("06_dimple_ghost");
  await page.mouse.up();
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.shownFeature != null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("the engine's preview replaces it", !t.ghost && t.shown !== null && t.previewError === null, t);
  await page.keyboard.press("Escape");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
