// Round face resize prompts, the History badge and the value box, in a real browser.
//
// Scene: the c1 reproduction with its three slot end press/pulls suppressed
// (see press_pull_resize_e2e.cjs). The +Y end of the upper slot is a half
// cylinder of radius 2, a hole beside it is a full round of diameter 6.74.
//
//   1. Selecting the slot end reads R 2 in the prompt and the readout, with no
//      removal offered; the hole reads its diameter and offers removal.
//   2. Press/pull on the slot end with Tangent faces follow off, typed 1.5: the
//      refusal is in the value box only, the History badge stays clear, and the
//      box stays narrow and right past the arrow tip.
//   3. The same refusal in Offset Face keeps the badge clear too.
//   4. Press/pull on the hole dragged to removal, then r-2 typed: the prompt
//      says why instead of offering removal. The offset prompt reads "below".
//   5. A committed feature that fails still lights the badge.
//
// Shots: 01_slot_selected, 02_hole_selected, 03_pp_refused, 04_offset_refused,
// 05_negative_typed, 06_committed_failure.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5974/ SC_ENGINE_PORT=8974 \
//     node e2e/resize_prompts_badge_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "resize_prompts_badge_shots");
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
  const load = async (doc) => {
    await page.evaluate(async (json) => {
      window.store.load(json);
      await window.store.rebuildNow();
    }, JSON.stringify(doc));
    await settle();
  };
  const look = () => page.evaluate(() => {
    const v = window.viewport; const V = v.camera.position.constructor;
    v.rig.setLookAt(new V(60, -40, 40), new V(0, 6, 20));
    v.requestRender();
  });
  // Both History badges: the card's own and the switch that opens it.
  const badges = () => page.evaluate(() => {
    const card = document.querySelector(".timeline-errbadge");
    const sw = [...document.querySelectorAll(".icon-btn-badge")].map((b) => b.textContent.trim());
    return { card: card && !card.classList.contains("hidden") ? card.textContent.trim() : null, switch: sw.length ? sw : null };
  });
  const prompt = () => page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "");
  const readout = async () => {
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup"))); // the readout wakes on release
    await page.waitForTimeout(300);
    return page.evaluate(() => document.querySelector("[data-testid=selection-readout]")?.textContent?.trim() ?? "");
  };
  // The value box against the arrow: its size, and how far its nearest edge is from the tip.
  const boxVsTip = (which) => page.evaluate((which) => {
    const t = which === "offset" ? window.__fundacad.faceOffset : window.pressPull;
    const v = window.viewport; const V = v.camera.position.constructor;
    const box = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none");
    if (!box || !t.gizmo) return null;
    const g = t.gizmo;
    const tipW = g.position.clone().add(new V(0, 1, 0).applyQuaternion(g.quaternion).multiplyScalar(45 * g.scale.x));
    const tip = v.projectToScreen(tipW);
    const r = box.getBoundingClientRect();
    const p = box.querySelector(".dim-problem")?.getBoundingClientRect() ?? null;
    const tx = tip.x, ty = tip.y;
    const dx = Math.max(r.left - tx, 0, tx - r.right);
    const dy = Math.max(r.top - ty, 0, ty - r.bottom);
    return { w: Math.round(r.width), h: Math.round(r.height), problemW: p ? Math.round(p.width) : null, gap: Math.round(Math.hypot(dx, dy)) };
  }, which);
  const pickFace = async (point) => {
    await page.evaluate((p) => {
      const v = window.viewport;
      v.clearSelection?.();
      v.selectOnlyFace(v.faceIdNear(p));
    }, point);
    await page.waitForTimeout(1500);
  };
  const typeValue = async (text) => {
    await page.evaluate(() => {
      const i = [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none").querySelector("input");
      i.focus();
      i.select();
    });
    await page.keyboard.type(text);
  };
  const followOff = () => page.evaluate(() => [...document.querySelectorAll(".dim-input")].find((b) => b.style.display !== "none")
    .querySelector(".dim-toggle").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));

  await load(base);
  await look();
  await page.waitForTimeout(500);
  check("the scene starts with no badge", (await badges()).card === null && (await badges()).switch === null, await badges());

  // --- 1. selection prompts -------------------------------------------------------
  await pickFace(SLOT_END);
  let p = await prompt();
  check("the slot end prompt reads R 2", /Round face selected \(R2 mm\)/.test(p), p);
  check("and offers no removal", !/remove/.test(p), p);
  const ro = await readout();
  check("the readout reads R 2", /R2 mm/.test(ro) && !/⌀/.test(ro), ro);
  await shot("01_slot_selected");
  await pickFace(HOLE_WALL);
  p = await prompt();
  check("the hole prompt reads its diameter and offers removal", /Round face selected \(⌀6\.74 mm\)/.test(p) && /remove it/.test(p), p);
  await shot("02_hole_selected");
  await page.keyboard.press("Escape");

  // --- 2. press/pull refusal: box only, no badge ----------------------------------
  await pickFace(SLOT_END);
  await page.evaluate(() => window.__fundacad.handleAction("presspull"));
  await page.waitForFunction(() => window.pressPull.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  const before = await boxVsTip("pp");
  await followOff();
  await page.waitForTimeout(200);
  await typeValue("1.5");
  await settle();
  await page.waitForFunction(() => window.pressPull.refusalShown !== null, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(300);
  const refused = await page.evaluate(() => ({
    refused: window.pressPull.refusalShown,
    held: window.store.buildState.heldRefusal?.code ?? null,
    problem: document.querySelector(".dim-input .dim-problem")?.textContent ?? null,
  }));
  check("press/pull refuses 1.5 with follow off, in the box", refused.held === "tangentLost" && !!refused.problem, refused);
  let b = await badges();
  check("and the History badge stays clear", b.card === null && b.switch === null, b);
  const after = await boxVsTip("pp");
  check("the refused box is no wider than the reason's cap past its fields", after && after.w <= Math.max(before.w, 260) + 4, { before, after });
  check("and stays right past the arrow tip", after && after.gap <= 16, after);
  await shot("03_pp_refused");
  await page.keyboard.press("Escape");
  await settle();

  // --- 3. offset face refusal --------------------------------------------------------
  await pickFace(SLOT_END);
  await page.evaluate(() => window.__fundacad.handleAction("offset-face"));
  await page.waitForFunction(() => window.__fundacad.faceOffset.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  await followOff();
  await page.waitForTimeout(200);
  await typeValue("1.5");
  await settle();
  await page.waitForFunction(() => window.__fundacad.faceOffset.refusalShown !== null, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(300);
  const oref = await page.evaluate(() => ({
    refused: window.__fundacad.faceOffset.refusalShown,
    held: window.store.buildState.heldRefusal?.code ?? null,
  }));
  check("Offset Face refuses 1.5 with follow off", oref.refused !== null && oref.held !== null, oref);
  b = await badges();
  check("and the History badge stays clear", b.card === null && b.switch === null, b);
  const obox = await boxVsTip("offset");
  check("its box stays right past the arrow tip", obox && obox.gap <= 16 && obox.w <= 300, obox);
  await shot("04_offset_refused");
  await page.keyboard.press("Escape");
  await settle();

  // --- 4. the hole dragged to removal, then a negative radius typed ---------------
  await pickFace(HOLE_WALL);
  await page.evaluate(() => window.__fundacad.handleAction("presspull"));
  await page.waitForFunction(() => window.pressPull.round?.tangent != null, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  await typeValue("+0.5");
  await page.waitForTimeout(300);
  p = await prompt();
  check("the offset prompt says below, not past", /below -3\.03 mm removes it/.test(p) && !/past/.test(p), p);
  await typeValue("⌀0");
  await page.waitForTimeout(400);
  p = await prompt();
  check("a diameter of 0 offers removal", /Release to remove this face/.test(p), p);
  await typeValue("r-2");
  await page.waitForTimeout(400);
  p = await prompt();
  check("r-2 says why instead of offering removal", !/remove/.test(p) && /A radius can't be negative/.test(p), p);
  await shot("05_negative_typed");
  await page.keyboard.press("Escape");
  await settle();

  // --- 5. a committed failure still shows ------------------------------------------
  const broken = structuredClone(base);
  broken.features.push({ id: "bad1", type: "press-pull", face: { kind: "face", by: "nearest", point: SLOT_END }, distance: 0.5, operation: "join", followTangent: false });
  await load(broken);
  await page.waitForTimeout(500);
  b = await badges();
  const err = await page.evaluate(() => window.store.buildState.result?.featureErrors?.map((e) => e.feature_id) ?? []);
  check("a committed press/pull that fails lights the badge", err.includes("bad1") && b.card !== null && b.switch !== null, { b, err });
  await shot("06_committed_failure");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
