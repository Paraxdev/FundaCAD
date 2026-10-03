// Press/pull's size field on a round face: what it reads and what typing picks.
//
// Scene: the c1 reproduction with its three slot end press/pulls suppressed. The
// upper slot's +Y end is a half cylinder of radius 2 on y 7.125, z 20.
//
//   1. The slot end reads R 2 and its name is a menu of Radius, Diameter, Offset.
//   2. Picking Diameter shows 4 and Offset shows 0, the same size in other terms.
//   3. d5 switches to Diameter and grows the end to R 2.5.
//   4. -0.5 switches to Offset and narrows the slot, the walls following.
//   5. r2.6 switches back to R; Enter commits, and the resized face is selected
//      again, so the press/pull reopens on it reading R 2.6.
//   6. A round hole reads its diameter at display precision, and +0.5 offsets it.
//
// Shots: 01_picked, 02_menu, 03_d5, 04_offset, 05_committed, 06_reopened, 07_hole.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5974/ SC_ENGINE_PORT=8974 \
//     node e2e/press_pull_quantity_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "press_pull_quantity_shots");
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
  await page.evaluate(async (json) => {
    window.store.load(json);
    await window.store.rebuildNow();
  }, JSON.stringify(base));
  await settle();
  await page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(60, -40, 40), new V(0, 6, 20));
    v.requestRender();
  });
  await page.waitForTimeout(500);

  const tool = () => page.evaluate(() => {
    const t = window.pressPull;
    const b = [...document.querySelectorAll(".dim-input")].find((x) => x.style.display !== "none");
    const name = b?.querySelector(".dim-name");
    return {
      active: t.active,
      value: t.value,
      quantity: t.quantity,
      tag: name ? name.tagName : null,
      caret: !!name?.querySelector("[data-icon='caretDown']"),
      label: name ? (name.title || name.textContent) : null,
      field: b?.querySelector("input")?.value ?? null,
      problem: b?.querySelector(".dim-problem")?.textContent ?? null,
      shown: t.outcomes.shownFeature ? { distance: t.outcomes.shownFeature.distance, followTangent: t.outcomes.shownFeature.followTangent } : null,
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
    await page.waitForTimeout(300);
    await page.waitForFunction(() => window.pressPull.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(300);
  };
  const typeValue = async (text) => {
    await page.evaluate(() => {
      const i = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none").querySelector("input");
      i.focus();
      i.select();
    });
    await page.keyboard.type(text);
  };
  const openMenu = () => page.evaluate(() => {
    const b = [...document.querySelectorAll(".dim-input")].find((x) => x.style.display !== "none");
    b.querySelector(".dim-name").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    return [...document.querySelectorAll(".dim-unit-menu .dim-unit-item")].map((r) => ({ text: r.textContent, active: r.classList.contains("active") }));
  });
  const pick = (word) => page.evaluate((w) => {
    const row = [...document.querySelectorAll(".dim-unit-menu .dim-unit-item")].find((r) => r.textContent === w);
    row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  }, word);
  const waitShown = (distance) => page.waitForFunction(
    (d) => window.pressPull.outcomes.shownFeature?.distance === d, distance, { timeout: 120000 }).catch(() => {});

  // --- 1. the slot end reads R and its name is a menu ---------------------------
  await select(SLOT_END);
  let t = await tool();
  check("the slot end reads R 2", t.active && t.label === "R" && t.field === "2", t);
  check("its name is a button with a caret", t.tag === "BUTTON" && t.caret, t);
  await shot("01_picked");

  // --- 2. the menu shows the same size in other terms ----------------------------
  const rows = await openMenu();
  await page.waitForTimeout(200);
  check("the menu offers Radius, Diameter and Offset, Radius marked", JSON.stringify(rows) === JSON.stringify([
    { text: "Radius", active: true }, { text: "Diameter", active: false }, { text: "Offset", active: false },
  ]), rows);
  await shot("02_menu");
  await pick("Diameter");
  t = await tool();
  check("Diameter reads 4", t.label === "Diameter" && t.field === "4" && t.quantity === "diameter", t);
  await openMenu();
  await pick("Offset");
  t = await tool();
  check("Offset reads 0", t.label === "Offset" && t.field === "0", t);
  await openMenu();
  await pick("Radius");

  // --- 3. d5 grows the end to R 2.5 ------------------------------------------------
  await typeValue("d5");
  await page.waitForTimeout(300);
  await waitShown(-0.5);
  await settle();
  t = await tool();
  check("d5 switches to Diameter", t.label === "Diameter" && t.quantity === "diameter", t);
  check("and previews the bore grown by 0.5", t.shown && t.shown.distance === -0.5 && t.problem === null, t);
  await shot("03_d5");

  // --- 4. -0.5 is an offset, and narrows the slot ----------------------------------
  await typeValue("-0.5");
  await page.waitForTimeout(300);
  await waitShown(0.5);
  await settle();
  t = await tool();
  check("-0.5 switches to Offset", t.label === "Offset" && t.quantity === "offset", t);
  check("and previews the end shrunk by 0.5 with the walls following", t.shown && t.shown.distance === 0.5 && t.shown.followTangent === true && t.problem === null, t);
  check("with no complaint about a negative", !/negative/.test(t.problem ?? ""), t.problem);
  await shot("04_offset");

  // --- 5. r2.6 commits, and the face stays selected ---------------------------------
  await typeValue("r2.6");
  await page.waitForTimeout(300);
  await waitShown(-0.6);
  t = await tool();
  check("r2.6 switches back to R", t.label === "R" && t.quantity === "radius", t);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await settle();
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const v = window.viewport;
    const pp = window.store.document.features.filter((f) => f.type === "press-pull" && !["f6", "f7", "f8"].includes(f.id));
    return {
      active: window.pressPull.active,
      pp: pp.map((f) => f.distance),
      selected: v.getSelectedFaceIds(),
      endFace: v.faceIdNear([0, 7.125 + 2.6, 20]),
      err: window.store.buildState.errorFeatureId ?? null,
    };
  });
  check("one press/pull is committed at 0.6 out", !after.active && after.pp.length === 1 && after.pp[0] === -0.6 && after.err === null, after);
  check("and the resized end is selected again", after.selected.length === 1 && after.selected[0] === after.endFace, after);
  await shot("05_committed");

  // --- 6. it reopens on the resized face -----------------------------------------
  await page.evaluate(() => window.__fundacad.handleAction("presspull"));
  await page.waitForTimeout(300);
  await page.waitForFunction(() => window.pressPull.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  t = await tool();
  check("press/pull reopens on it, reading R 2.6", t.active && t.label === "R" && t.field === "2.6", t);
  await shot("06_reopened");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // --- 7. a hole reads at display precision, and + offsets it ----------------------
  await select(HOLE_WALL);
  t = await tool();
  check("a round hole reads its diameter at two places", t.active && t.label === "Diameter" && t.field === "6.74", t);
  await typeValue("+0.5");
  await page.waitForTimeout(300);
  await waitShown(-0.5);
  t = await tool();
  check("+0.5 switches to Offset and grows the hole", t.label === "Offset" && t.shown && t.shown.distance === -0.5, t);
  await shot("07_hole");
  await page.keyboard.press("Escape");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
