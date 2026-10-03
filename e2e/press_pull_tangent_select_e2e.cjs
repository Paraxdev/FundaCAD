// "Select tangent faces" on the viewport's face menu, in a real browser.
//
// Scene: the c1 reproduction with its three slot end press/pulls suppressed.
// The upper slot runs along Y from its -Y end round y -14.875 to its +Y end
// round y 7.125, both of radius 2 about X at z 20, between flat walls at
// z 18 and z 22, and it is cut through the block along X.
//
//   1. Right-clicking the slot end offers Select tangent faces, right after
//      Select coplanar faces, once the engine has answered.
//   2. Choosing it selects the four faces of the slot loop, both ends and both
//      walls, and the selection prompt counts four faces.
//   3. A flat slot wall and a round hole with no tangent run do not offer it.
//
// Shots: 01_menu, 02_selected, 03_wall_menu, 04_hole_menu.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5976/ SC_ENGINE_PORT=8976 \
//     node e2e/press_pull_tangent_select_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "press_pull_tangent_select_shots");
const C1 = path.join(__dirname, "../crates/fundacad-geom/tests/press_pull/c1_slot_end.json");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const SLOT_LOOP = { endPlus: [0, 9.125, 20], endMinus: [0, -16.875, 20], wallLow: [0, -3.875, 18], wallHigh: [0, -3.875, 22] };
const HOLE_WALL = [0, 7.125 + 3.3690784184224394, 13.015];
const ITEM = "Select tangent faces";

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
  await page.evaluate(async (json) => {
    window.store.load(json);
    await window.store.rebuildNow();
  }, JSON.stringify(base));
  await settle();

  const view = (eye, at) => page.evaluate(([e, a]) => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(...e), new V(...a));
    v.requestRender();
  }, [eye, at]);
  // A screen point whose pick lands on the face nearest `target`, tried at
  // each of `along` (world points on that face).
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
  const menuLabels = () => page.evaluate(() =>
    [...document.querySelectorAll(".context-menu .ctx-item .ctx-label")].map((n) => n.textContent.trim()));
  // A first click takes the whole body; resting on it is what offers its faces.
  const rightClick = async (at) => {
    await page.mouse.move(at.x - 3, at.y);
    for (let i = 0; i < 6; i++) {
      await page.mouse.move(at.x + (i % 2 ? 1 : -1), at.y);
      await page.waitForTimeout(250);
    }
    await page.mouse.move(at.x, at.y);
    await page.mouse.click(at.x, at.y, { button: "right" });
    await page.waitForSelector(".context-menu .ctx-item", { timeout: 5000 }).catch(() => {});
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  };

  // --- 1. the slot end offers it -------------------------------------------------
  await view([43, 1, 25], [25, 6, 20]);
  await page.waitForTimeout(500);
  const endPoints = [];
  for (let x = 24; x >= 14; x -= 2) for (const a of [90, 70, 110, 50, 130]) {
    const r = (a * Math.PI) / 180;
    endPoints.push([x, 7.125 + 2 * Math.sin(r), 20 + 2 * Math.cos(r)]);
  }
  const end = await screenOn(SLOT_LOOP.endPlus, endPoints);
  check("the slot end is under a screen point", end !== null, end);
  await rightClick(end);
  await page.waitForFunction((item) =>
    [...document.querySelectorAll(".context-menu .ctx-item .ctx-label")].some((n) => n.textContent.trim() === item),
  ITEM, { timeout: 30000 }).catch(() => {});
  let labels = await menuLabels();
  check("the slot end's menu offers Select tangent faces", labels.includes(ITEM), labels);
  check("right after Select coplanar faces", labels.indexOf(ITEM) === labels.indexOf("Select coplanar faces") + 1, labels);
  await shot("01_menu");

  // --- 2. choosing it selects the slot loop ---------------------------------------
  await page.click(`.context-menu .ctx-item:has(.ctx-label:text-is('${ITEM}'))`, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  const sel = await page.evaluate((loop) => {
    const v = window.viewport;
    const got = v.highlighter.getSelectedFaces();
    const want = Object.values(loop).map((p) => v.faceIdNear(p));
    return { got, want, prompt: document.querySelector("#prompt")?.textContent ?? "" };
  }, SLOT_LOOP);
  check("four faces are selected", sel.got.length === 4, sel);
  check("they are both slot ends and both walls", sel.want.every((id) => sel.got.includes(id)) && new Set(sel.want).size === 4, sel);
  check("the clicked end is the first", sel.got[0] === end.faceId, sel);
  check("the selection prompt counts four faces", /4 faces selected/.test(sel.prompt), sel.prompt);
  await view([70, -4, 34], [25, -4, 20]);
  await page.waitForTimeout(500);
  await shot("02_selected");

  // --- 3. a flat wall and a round hole do not offer it -----------------------------
  await view([43, 1, 25], [25, 6, 20]);
  await page.waitForTimeout(400);
  const wallPoints = [];
  for (let x = 24; x >= 12; x -= 2) for (const y of [7.125, 6.5, 7.75, 6]) wallPoints.push([x, y, 18]);
  const wall = await screenOn(SLOT_LOOP.wallLow, wallPoints);
  check("a slot wall is under a screen point", wall !== null, wall);
  if (wall) {
    await rightClick(wall);
    await page.waitForTimeout(1500);
    labels = await menuLabels();
    check("a flat slot wall offers Select coplanar faces only", labels.includes("Select coplanar faces") && !labels.includes(ITEM), labels);
    await shot("03_wall_menu");
    await closeMenu();
  }

  const holeAxis = [7.125, 13.015];
  const holeR = 3.3690784184224394;
  await view([45, holeAxis[0] - 2, holeAxis[1] + 1], [25, holeAxis[0], holeAxis[1]]);
  await page.waitForTimeout(400);
  const holePoints = [];
  for (let x = 24; x >= 14; x -= 2) for (const a of [90, 70, 110, 45, 135]) {
    const r = (a * Math.PI) / 180;
    holePoints.push([x, holeAxis[0] + holeR * Math.sin(r), holeAxis[1] + holeR * Math.cos(r)]);
  }
  const hole = await screenOn(HOLE_WALL, holePoints);
  check("the round hole is under a screen point", hole !== null, hole);
  if (hole) {
    await rightClick(hole);
    await page.waitForTimeout(2500);
    labels = await menuLabels();
    check("a round hole with no tangent run does not offer it", labels.includes("Select coplanar faces") && !labels.includes(ITEM), labels);
    await shot("04_hole_menu");
    await closeMenu();
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
