// Dragging a box over the model, in a real browser with a real renderer.
//
// Three things only exist once there is a pointer being dragged across a canvas,
// and none of them can be reached from a unit test: that the box shows what it
// will take WHILE it is being dragged rather than announcing it afterwards, that
// the chip on the box says which filter is running, and that Tab changes both of
// those mid-drag.
//
// Driven with real mouse and key events, not by calling selectInBox: the thing
// being tested is the gesture, and the gesture is spread across pointerdown,
// pointermove, keydown and pointerup.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> node e2e/area_select_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "area_select_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
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
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  // Three boxes in a row, so a box drawn across them has something to include
  // and something to leave out.
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      const id = window.store.nextId();
      window.store.addFeature({ id, type: "box", length: 20, width: 20, height: 20 });
      window.store.addFeature({
        id: window.store.nextId(), type: "move", body: `body${i + 1}`,
        dx: (i - 1) * 40, dy: 0, dz: 0,
      });
    }
    await window.store.rebuildNow();
  });
  await page.evaluate(() => window.__fundacad.handleAction("top"));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1200);

  const box = await page.$eval("canvas", (c) => {
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  const state = () => page.evaluate(() => ({
    chip: document.querySelector(".areachip")?.dataset.filter ?? null,
    chipText: document.querySelector(".areachip")?.textContent?.trim() ?? null,
    band: !!document.querySelector(".areabox"),
    faces: window.viewport.getSelectedFaceIds().length,
    edges: window.viewport.selectedEdgeLines().length,
    bodies: window.viewport.getSelectedBodies().length,
    mode: window.viewport.selecting,
    takes: window.viewport.areaTakes,
    gizmo: window.__fundacad.move.active,
  }));

  // ---- 1. the box shows what it will take, mid-drag -------------------------
  console.log("\n1. what the box takes, while it is being dragged");
  await page.evaluate(() => window.viewport.setSelectionMode("faces"));
  await page.mouse.move(cx - 380, cy - 200);
  await page.mouse.down();
  await page.mouse.move(cx + 380, cy + 200, { steps: 12 });
  await page.waitForTimeout(120);
  const mid = await state();
  check("the band is drawn", mid.band);
  check("something is already selected before the release",
    mid.faces > 0, `${mid.faces} faces, ${mid.edges} edges`);
  check("and nothing has been announced yet: no gizmo, no mode change",
    mid.gizmo === false && mid.mode === "faces", JSON.stringify({ gizmo: mid.gizmo, mode: mid.mode }));
  await page.screenshot({ path: path.join(OUT, "1-preview.png") });

  // ---- 2. the chip says which filter, and Tab changes it --------------------
  console.log("\n2. the chip on the box, and Tab");
  check("the chip is on the box", mid.chip === "all", `${mid.chip}: ${mid.chipText}`);
  const cycled = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(90);
    cycled.push(await state());
  }
  check("Tab walks every filter and comes back",
    JSON.stringify(cycled.map((s) => s.chip)) === JSON.stringify(["faces", "edges", "bodies", "all"]),
    cycled.map((s) => s.chip).join(" -> "));
  check("the chip says what the filter takes",
    cycled[1].chipText.includes("Edges"), cycled[1].chipText);

  // ---- 3. the preview follows the filter ------------------------------------
  console.log("\n3. the preview follows the filter");
  const onEdges = cycled[1];
  check("edges only takes edges", onEdges.edges > 0 && onEdges.faces === 0,
    `${onEdges.faces} faces, ${onEdges.edges} edges`);
  const onFaces = cycled[0];
  check("faces only takes faces", onFaces.faces > 0 && onFaces.edges === 0,
    `${onFaces.faces} faces, ${onFaces.edges} edges`);
  const onBodies = cycled[2];
  check("bodies takes bodies, from a viewport that is picking FACES",
    onBodies.bodies === 3 && onBodies.mode === "faces",
    `${onBodies.bodies} bodies while picking ${onBodies.mode}`);

  // ---- 4. and the release is what announces ---------------------------------
  console.log("\n4. the release");
  await page.keyboard.press("Tab"); // back to faces
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab"); // bodies
  await page.waitForTimeout(90);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const done = await state();
  check("the band is gone", !done.band && done.chip === null);
  check("the bodies the box took are still selected", done.bodies === 3, `${done.bodies}`);
  check("and NOW the viewport is picking bodies", done.mode === "bodies", done.mode);
  check("which raised the move gizmo, as picking a body always does", done.gizmo === true);
  await page.screenshot({ path: path.join(OUT, "2-taken.png") });

  // ---- 5. a window takes whole bodies only (control) ------------------------
  console.log("\n5. window against crossing, on bodies");
  // Straight after section 4, so a body is selected and the Move gizmo is up.
  // That is on purpose: it is the state the app is in after ANY box over
  // bodies, and until canAreaSelect stopped asking toolBusy it was a state in
  // which no second box could be drawn at all.
  check("a second box can be drawn with the gizmo still up",
    (await state()).gizmo === true, "gizmo up before the sweep");
  // The bodies are 20mm cubes at x = -40, 0, +40. PROJECTED rather than guessed
  // in pixels: what "fit" chose is not known here, and a box sized by guesswork
  // would pass or fail on the zoom.
  const span = await page.evaluate(async () => {
    const THREE = await import("/node_modules/three/build/three.module.js");
    const at = (x, y) => window.viewport.projectToScreen(new THREE.Vector3(x, y, 0));
    // Wide enough to CLIP the neighbours (they start at |x| = 30) without
    // containing them, which is the only span on which the two verdicts differ
    // and therefore the only one worth sweeping.
    const a = at(-35, -30);
    const b = at(35, 30);
    return {
      x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x),
      y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y),
    };
  });
  // Drag RIGHTWARD across only the middle body: a window takes it and leaves the
  // two it does not reach. Dragging LEFTWARD over the SAME ground is a crossing,
  // which reaches out to whatever it touches.
  const sweep = async (leftward) => {
    const x0 = leftward ? span.x1 : span.x0;
    const x1 = leftward ? span.x0 : span.x1;
    await page.mouse.move(x0, span.y0);
    await page.mouse.down();
    await page.mouse.move(x1, span.y1, { steps: 10 });
    await page.waitForTimeout(120);
    const s = await state();
    await page.mouse.up();
    await page.waitForTimeout(150);
    return s;
  };
  const window0 = await sweep(false);
  check("a window takes only the body wholly inside it",
    window0.bodies === 1, `${window0.bodies} bodies`);
  const crossing0 = await sweep(true);
  // CONTROL on the line above: the same rectangle, drawn the other way, must
  // take MORE. If both took one, the window test above would be passing because
  // the box only ever reached one body, not because a window is stricter.
  check("a crossing over the same ground takes more (control)",
    crossing0.bodies > window0.bodies, `${crossing0.bodies} against ${window0.bodies}`);

  // ---- 6. the projection is taken once per drag ----------------------------
  //
  // The load-bearing property of the whole preview: the camera cannot move
  // while the left button is drawing a box, so the model is projected to the
  // screen ONCE and every frame after that is 2D arithmetic on the result. If
  // this ever becomes one per frame the preview goes from free to a matrix
  // multiply per vertex per frame, and nothing else here would notice.
  console.log("\n6. what a drag costs");
  await page.evaluate(() => {
    const vp = window.viewport;
    const orig = vp.projectForArea.bind(vp);
    window.__projections = 0;
    vp.projectForArea = () => { window.__projections++; return orig(); };
  });
  await page.mouse.move(span.x0, span.y0);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(span.x0 + ((span.x1 - span.x0) * i) / 12, span.y0 + ((span.y1 - span.y0) * i) / 12);
  }
  await page.keyboard.press("Tab"); // and a filter change must not rebuild it either
  await page.mouse.move(span.x1, span.y1);
  const projections = await page.evaluate(() => window.__projections);
  await page.mouse.up();
  await page.waitForTimeout(200);
  check("the model is projected once for the whole drag, not once a frame",
    projections === 1, `${projections} projections over 14 frames`);

  console.log(`\nshots in ${OUT}`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall area select checks passed");
  process.exit(failures ? 1 : 0);
})();
