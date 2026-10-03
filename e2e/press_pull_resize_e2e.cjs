// Press/pull resizing a round face, in a real browser.
//
// Scene: the c1 reproduction (a block with round holes and two slots cut
// through it) with its three slot end press/pulls suppressed. The upper slot
// runs along X, its +Y end is a half cylinder of radius 2 on y 7.125, z 20,
// tangent to flat walls at z 18 and z 22.
//
//   1. The slot end reads R 2.00, with Tangent faces follow offered and on.
//   2. Dragging it out previews through the engine with no refusal, and the
//      bigger end leaves no radial wall where it meets the walls.
//   3. Typing 1.5 narrows the whole slot, and says it moves the run.
//   4. Turning Tangent faces follow off refuses 1.5 in the value box, paints
//      the handle refused and holds the narrowed slot on screen; Enter on the
//      typed value keeps the tool open.
//   5. Dragging grows it back to a size that builds and on into a refused one;
//      confirming commits the size held on screen.
//   6. A round hole reads as a diameter, with no follow switch.
//
// Shots: 01_picked, 02_grown, 03_narrowed, 04_refused, 05_held, 06_committed, 07_hole.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5971/ SC_ENGINE_PORT=8971 \
//     node e2e/press_pull_resize_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "press_pull_resize_shots");
const C1 = path.join(__dirname, "../crates/fundacad-geom/tests/press_pull/c1_slot_end.json");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const SLOT_END = [0, 9.125, 20];
const HOLE_WALL = [0, 7.125 + 3.3690784184224394, 13.015];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c1 = JSON.parse(fs.readFileSync(C1, "utf8"));
  const base = { ...c1, suppressed: ["f6", "f7", "f8"] };
  const narrow = structuredClone(base);
  narrow.features.find((f) => f.id === "f4").entities.find((e) => e.id === "e4").width = 3;

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
  const load = async (doc) => {
    await page.evaluate(async (json) => {
      window.store.load(json);
      await window.store.rebuildNow();
    }, JSON.stringify(doc));
    await settle();
  };
  const volume = () => page.evaluate(() => window.viewport.bodyProperties(null)?.volume ?? null);
  const look = () => page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(60, -40, 40), new V(0, 6, 20));
    v.requestRender();
  });
  const lookAtEnd = () => page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    // Into the slot's mouth on the +X face, where its outline shows the end.
    v.rig.setLookAt(new V(43, 1, 25), new V(25, 6, 20));
    v.requestRender();
  });
  // Faces of plane y = 7.125 inside the slot's height: the radial step a resize
  // used to leave where the end met its walls.
  const radialWalls = () => page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    let n = 0;
    for (const b of v.model.bodies) {
      const pos = b.mesh.geometry.getAttribute("position");
      const idx = b.mesh.geometry.getIndex();
      const mw = b.mesh.matrixWorld;
      const a = new V(), p = new V(), q = new V();
      for (let t = 0; t < idx.count / 3; t++) {
        a.fromBufferAttribute(pos, idx.getX(3 * t)).applyMatrix4(mw);
        p.fromBufferAttribute(pos, idx.getX(3 * t + 1)).applyMatrix4(mw);
        q.fromBufferAttribute(pos, idx.getX(3 * t + 2)).applyMatrix4(mw);
        const c = a.clone().add(p).add(q).multiplyScalar(1 / 3);
        const nrm = p.clone().sub(a).cross(q.clone().sub(a)).normalize();
        if (Math.abs(nrm.y) > 0.99 && Math.abs(c.y - 7.125) < 0.05 && c.z > 17 && c.z < 23) n++;
      }
    }
    return n;
  });
  const tool = () => page.evaluate(() => {
    const t = window.pressPull;
    const box = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none");
    const name = box?.querySelector(".dim-name");
    const toggle = box?.querySelector(".dim-toggle");
    return {
      active: t.active,
      value: t.value,
      label: name ? (name.title || name.textContent) : null,
      field: box?.querySelector("input")?.value ?? null,
      toggle: toggle ? { text: toggle.textContent, on: toggle.classList.contains("on"), shown: toggle.style.display !== "none" } : null,
      problem: box?.querySelector(".dim-problem")?.textContent ?? null,
      refused: t.outcomes.refusal,
      shown: t.outcomes.shownFeature ? { distance: t.outcomes.shownFeature.distance, followTangent: t.outcomes.shownFeature.followTangent } : null,
      previewError: window.store.previewError,
      held: window.store.buildState.heldRefusal?.code ?? null,
      prompt: document.querySelector("#prompt")?.textContent ?? "",
    };
  });
  const select = async (point) => {
    await page.evaluate((p) => {
      const v = window.viewport;
      v.clearSelection?.();
      const id = v.faceIdNear(p);
      v.selectFaces([id]);
    }, point);
    await page.evaluate(() => window.__fundacad.handleAction("presspull"));
    await page.waitForTimeout(300);
  };
  // Grab the arrow and pull it along itself until the value passes `until`.
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
    for (let i = 0; i < 200; i++) {
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

  // --- references -------------------------------------------------------------
  await load(narrow);
  const vNarrow = await volume();
  await load(base);
  const v0 = await volume();
  check("the slot drawn 3 wide holds more material than the 4 wide one", vNarrow > v0 + 100, { v0, vNarrow });
  check("the scene starts with no radial wall in the slot", (await radialWalls()) === 0);
  await look();
  await page.waitForTimeout(500);

  // --- 1. the slot end reads as a radius ----------------------------------------
  await select(SLOT_END);
  await page.waitForFunction(() => window.pressPull.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  let t = await tool();
  check("the tool opens on the slot end", t.active, t);
  check("its field reads R 2.00", t.label === "R" && Math.abs(Number(t.field) - 2) < 0.005, t);
  check("Tangent faces follow is offered and on", !!t.toggle && t.toggle.shown && t.toggle.on && t.toggle.text === "Tangent faces follow", t.toggle);
  await shot("01_picked");

  // --- 2. dragging out previews through the engine -----------------------------
  const hit = await drag(0.6);
  check("the arrow is under the pointer where it is drawn", hit);
  await settle();
  t = await tool();
  check("the drag grew the end", t.value >= 0.6 && t.value < 1.2, t.value);
  check("an engine preview is on screen, with no refusal", t.shown !== null && t.previewError === null && t.held === null && t.refused === null, t);
  check("which grows the bore, a negative push", t.shown && t.shown.distance < 0, t.shown);
  const vGrown = await volume();
  check("the preview took material away", vGrown < v0 - 1, { v0, vGrown });
  check("and left no radial wall", (await radialWalls()) === 0, await radialWalls());
  await lookAtEnd();
  await page.waitForTimeout(500);
  await shot("02_grown");
  await look();

  // --- 3. typing 1.5 narrows the whole slot ------------------------------------
  await typeValue("1.5");
  await page.waitForTimeout(300);
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.shownFeature?.distance === 0.5, null, { timeout: 120000 }).catch(() => {});
  await settle();
  t = await tool();
  check("typing 1.5 previews a shrink of 0.5 with the run following", t.shown && t.shown.distance === 0.5 && t.shown.followTangent === true && t.previewError === null, t);
  const vNarrowed = await volume();
  check("the whole slot narrows to 3 wide", Math.abs(vNarrowed - vNarrow) < 0.002 * vNarrow, { vNarrowed, vNarrow });
  check("the prompt says the run moves with it", /Moves the \d+ faces that run smoothly into it/.test(t.prompt), t.prompt);
  check("and no radial wall", (await radialWalls()) === 0);
  await shot("03_narrowed");

  // --- 4. follow off refuses, and the narrowed slot is held --------------------
  await page.evaluate(() => [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none")
    .querySelector(".dim-toggle").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
  await page.waitForTimeout(300);
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.refusal !== null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("the switch reads off", t.toggle && !t.toggle.on, t.toggle);
  check("the refusal is in the box", !!t.problem && /Tangent faces follow/.test(t.problem) && /2 flat faces/.test(t.problem), t.problem);
  check("and painted on the handle", t.refused !== null && t.held === "tangentLost", t);
  const vHeld = await volume();
  check("the narrowed slot stays on screen", Math.abs(vHeld - vNarrowed) < 1e-6 * vNarrowed, { vHeld, vNarrowed });
  await shot("04_refused");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  t = await tool();
  const committedEarly = await page.evaluate(() => window.store.document.features.filter((f) => f.type === "press-pull").length);
  check("Enter on the refused typed value keeps the tool open", t.active && committedEarly === 3, { active: t.active, committedEarly });

  // --- 5. a refused drag commits the size held on screen -----------------------
  await drag(0.3, { release: false });
  await page.waitForTimeout(300);
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.shownFeature?.followTangent === false, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  const grownTo = t.shown;
  check("dragged out, the end grows with follow off", grownTo && grownTo.followTangent === false && grownTo.distance < 0 && t.refused === null, t);
  await page.mouse.up();
  await drag(-0.2);
  await settle();
  await page.waitForFunction(() => window.pressPull.outcomes.refusal !== null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("dragged in past R 2 it is refused", t.value <= -0.2 && t.refused !== null && t.held === "tangentLost", t);
  check("the prompt says which size is kept", /keeping R/.test(t.prompt), t.prompt);
  check("the grown end is still on screen", t.shown && t.shown.distance === grownTo.distance, { shown: t.shown, grownTo });
  await shot("05_held");
  await page.keyboard.press("Enter");
  await settle();
  await page.waitForTimeout(800);
  await settle();
  const pp = await page.evaluate(() => window.store.document.features.filter((f) => f.type === "press-pull" && !["f6", "f7", "f8"].includes(f.id)));
  check("one press/pull is committed, at the held size", pp.length === 1 && pp[0].distance === grownTo.distance && pp[0].followTangent === false, pp);
  const state = await page.evaluate(() => ({ active: window.pressPull.active, err: window.store.buildState.errorFeatureId ?? null }));
  check("the tool closed and the model builds", !state.active && state.err === null, state);
  check("with no radial wall", (await radialWalls()) === 0);
  await shot("06_committed");

  // --- 6. a round hole reads as a diameter -------------------------------------
  await select(HOLE_WALL);
  await page.waitForFunction(() => window.pressPull.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  t = await tool();
  check("a round hole reads as a diameter", t.active && t.label === "Diameter" && Math.abs(Number(t.field) - 6.738) < 0.01, t);
  check("with no follow switch", !t.toggle || !t.toggle.shown, t.toggle);
  await shot("07_hole");
  await page.keyboard.press("Escape");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
