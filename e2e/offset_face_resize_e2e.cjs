// Offset Face on a round face, in a real browser.
//
// Scene: the c1 reproduction with its three slot end press/pulls suppressed.
// The upper slot's +Y end is a half bore of radius 2 on y 7.125, z 20.
//
//   1. Offset Face on the slot end reads R 2.00, offers Tangent faces follow,
//      and draws the axis and the dashed size line.
//   2. With follow off, dragging the end out previews through the engine and
//      the handle rides on the face.
//   3. Dragging on, in past R 2, is refused in the value box and on the
//      handle, and the grown end stays on screen.
//   4. Letting go commits the grown end that was on screen.
//   5. A round hole reads as a diameter.
//
// Shots: 01_picked, 02_grown, 03_refused, 04_committed, 05_hole.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5976/ SC_ENGINE_PORT=8976 \
//     node e2e/offset_face_resize_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "offset_face_resize_shots");
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
  const volume = () => page.evaluate(() => window.viewport.bodyProperties(null)?.volume ?? null);
  const look = () => page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(60, -40, 40), new V(0, 6, 20));
    v.requestRender();
  });
  const tool = () => page.evaluate(() => {
    const t = window.__fundacad.faceOffset;
    const box = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none");
    const name = box?.querySelector(".dim-name");
    const toggle = box?.querySelector(".dim-toggle");
    const at = t.anchor.clone().addScaledVector(t.axis, t.value);
    const names = [];
    window.viewport.scene?.traverse?.((o) => { if (o.name) names.push(o.name); });
    return {
      active: t.active,
      value: t.value,
      label: name ? (name.title || name.textContent) : null,
      field: box?.querySelector("input")?.value ?? null,
      toggle: toggle ? { text: toggle.textContent, on: toggle.classList.contains("on"), shown: toggle.style.display !== "none" } : null,
      problem: box?.querySelector(".dim-problem")?.textContent ?? null,
      refused: t.refusalShown,
      shown: t.shownFeature ? { distance: t.shownFeature.distance, followTangent: t.shownFeature.followTangent } : null,
      rides: t.gizmo ? t.gizmo.position.distanceTo(at) : null,
      guides: !!t.guides?.axisLine && !!t.guides?.sizeLine,
      held: window.store.buildState.heldRefusal?.code ?? null,
      prompt: document.querySelector("#prompt")?.textContent ?? "",
    };
  });
  const select = async (point) => {
    await page.evaluate((p) => {
      const v = window.viewport;
      v.clearSelection?.();
      v.selectFaces([v.faceIdNear(p)]);
    }, point);
    await page.evaluate(() => window.__fundacad.handleAction("offset-face"));
    await page.waitForTimeout(300);
  };
  // Press the arrow, then walk the pointer along it until the value passes `until`.
  const grab = async () => {
    const g = await page.evaluate(() => {
      const t = window.__fundacad.faceOffset; const v = window.viewport;
      const at = t.anchor.clone().addScaledVector(t.axis, t.value);
      const k = v.pixelWorldSize(at);
      const s = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 25 * (t.value < 0 ? -1 : 1)));
      const ahead = v.projectToScreen(at.clone().addScaledVector(t.axis, k * 60));
      const s0 = v.projectToScreen(at);
      return { x: s.x, y: s.y, dx: ahead.x - s0.x, dy: ahead.y - s0.y, hit: t.hitGizmo(s.x, s.y) };
    });
    const len = Math.hypot(g.dx, g.dy) || 1;
    const pos = { x: g.x, y: g.y, ux: g.dx / len, uy: g.dy / len };
    await page.mouse.move(pos.x, pos.y);
    await page.mouse.down();
    return { hit: g.hit, pos };
  };
  const walk = async (pos, until) => {
    const sign = until > (await tool()).value ? 1 : -1;
    for (let i = 0; i < 300; i++) {
      pos.x += pos.ux * 2 * sign; pos.y += pos.uy * 2 * sign;
      await page.mouse.move(pos.x, pos.y);
      const v = (await tool()).value;
      if (sign > 0 ? v >= until : v <= until) break;
    }
  };

  await page.evaluate(async (json) => {
    window.store.load(json);
    await window.store.rebuildNow();
  }, JSON.stringify(base));
  await settle();
  const v0 = await volume();
  await look();
  await page.waitForTimeout(500);

  // --- 1. the slot end reads as a radius ----------------------------------------
  await select(SLOT_END);
  await page.waitForFunction(() => window.__fundacad.faceOffset.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  let t = await tool();
  check("Offset Face opens on the slot end", t.active, t);
  check("its field reads R 2.00", t.label === "R" && Math.abs(Number(t.field) - 2) < 0.005, t);
  check("Tangent faces follow is offered and on", !!t.toggle && t.toggle.shown && t.toggle.on && t.toggle.text === "Tangent faces follow", t.toggle);
  check("the axis and the dashed size line are drawn", t.guides, t);
  await shot("01_picked");

  await page.evaluate(() => [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none")
    .querySelector(".dim-toggle").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
  await page.waitForTimeout(200);
  t = await tool();
  check("the switch turns off", t.toggle && !t.toggle.on, t.toggle);

  // --- 2. dragging out previews and the handle rides --------------------------
  const g = await grab();
  check("the arrow is under the pointer where it is drawn", g.hit);
  await walk(g.pos, 0.6);
  await settle();
  await page.waitForFunction(() => window.__fundacad.faceOffset.shownFeature != null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("the drag grew the end", t.value >= 0.6 && t.value < 1.2, t.value);
  check("an engine preview of the bigger bore is on screen", t.shown && t.shown.distance < 0 && t.shown.followTangent === false && t.refused === null, t);
  check("the field reads the new radius", Math.abs(Number(t.field) - (2 + t.value)) < 0.005, t.field);
  check("the handle rides on the face", t.rides !== null && t.rides < 1e-6, t.rides);
  const vGrown = await volume();
  check("the preview took material away", vGrown < v0 - 1, { v0, vGrown });
  const grownTo = t.shown;
  await shot("02_grown");

  // --- 3. on in past R 2 is refused, the grown end held ------------------------
  await walk(g.pos, -0.2);
  await settle();
  await page.waitForFunction(() => window.__fundacad.faceOffset.refusalShown !== null, null, { timeout: 120000 }).catch(() => {});
  t = await tool();
  check("dragged in past R 2 it is refused", t.value <= -0.2 && t.refused !== null && t.held === "tangentLost", t);
  check("the refusal is in the box", !!t.problem && /Tangent faces follow/.test(t.problem), t.problem);
  check("the prompt says which size is kept", /keeping R/.test(t.prompt), t.prompt);
  check("the grown end is still on screen", t.shown && t.shown.distance === grownTo.distance, { shown: t.shown, grownTo });
  check("and its volume", Math.abs((await volume()) - vGrown) < 1e-6 * vGrown);
  await shot("03_refused");

  // --- 4. letting go commits what is on screen ---------------------------------
  await page.mouse.up();
  await settle();
  await page.waitForTimeout(800);
  await settle();
  const of = await page.evaluate(() => window.store.document.features.filter((f) => f.type === "offsetFace"));
  check("one offset face is committed, at the held size", of.length === 1 && of[0].distance === grownTo.distance && of[0].followTangent === false, of);
  const state = await page.evaluate(() => ({ active: window.__fundacad.faceOffset.active, err: window.store.buildState.errorFeatureId ?? null }));
  check("the tool closed and the model builds", !state.active && state.err === null, state);
  check("at the grown volume", Math.abs((await volume()) - vGrown) < 1e-3 * vGrown);
  await shot("04_committed");

  // --- 5. a round hole reads as a diameter -------------------------------------
  await select(HOLE_WALL);
  await page.waitForFunction(() => window.__fundacad.faceOffset.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  t = await tool();
  check("a round hole reads as a diameter", t.active && t.label === "Diameter" && Math.abs(Number(t.field) - 6.738) < 0.01, t);
  check("with no follow switch", !t.toggle || !t.toggle.shown, t.toggle);
  await shot("05_hole");
  await page.keyboard.press("Escape");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
