// An extrude or press/pull pushed into a body shows through it, in a real browser.
//
// A cut previews inside the material it removes, so with the body opaque all
// that showed was the arrow. While the preview is inside a body that body is
// ghosted, and the gesture ending has to hand every body back exactly as it
// was: its material, x-ray if it was on, hidden bodies still hidden.
//
// The model is a tapered cylinder with a concentric circle sketched on its top
// face, the inner disc cut down into it, next to a glowing box, a glass
// cylinder and a hidden body.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> node e2e/extrude_peek_e2e.cjs [outDir]
// SC_APP_PORT and SC_ENGINE_PORT move it off 5173/8765 (the sidecar then needs
// FUNDACAD_EXTRA_ORIGINS for that app port). SC_REAL_GPU=1 drops swiftshader,
// which otherwise forces the low-power tier and turns glass off.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const APP_PORT = process.env.SC_APP_PORT || "5173";
const WS_PORT = process.env.SC_ENGINE_PORT || "8765";
const ARGS = process.env.SC_REAL_GPU ? ["--no-sandbox"] : ["--use-angle=swiftshader", "--no-sandbox"];
const OUT = path.resolve(process.argv[2] || "extrude_peek_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(({ t, ws }) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        if (!String(u).includes(":8765")) { super(u, p); return; }
        const s = String(u).replace(":8765", `:${ws}`).replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    }
    window.WebSocket = P;
  }, { t: TOKEN, ws: WS_PORT });

  await page.goto(`http://localhost:${APP_PORT}/`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ id: "c1", type: "circle", radius: 25, x: 0, y: 0 }] });
    s.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 30, operation: "new", taper: 5 });
    s.addFeature({ id: "sb", type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: 20, height: 20, x: 50, y: 0 }] });
    s.addFeature({ id: "eb", type: "extrude", sketch: "sb", distance: 20, operation: "new" });
    s.addFeature({ id: "sg", type: "sketch", plane: "XY", entities: [{ type: "circle", radius: 10, x: 0, y: 50 }] });
    s.addFeature({ id: "eg", type: "extrude", sketch: "sg", distance: 25, operation: "new" });
    s.addFeature({ id: "sh", type: "sketch", plane: "XY", entities: [{ type: "circle", radius: 8, x: -50, y: 0 }] });
    s.addFeature({ id: "eh", type: "extrude", sketch: "sh", distance: 25, operation: "new" });
    s.addFeature({ id: "s2", type: "sketch", plane: { origin: [0, 0, 30], normal: [0, 0, 1], xdir: [1, 0, 0] }, entities: [
      { id: "c2", type: "circle", radius: 19, x: 0, y: 0 },
      { id: "c3", type: "circle", radius: 13, x: 0, y: 0 },
    ] });
    await s.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length >= 4, null, { timeout: 60000 });
  const [cyl, box, glass, hidden] = await page.evaluate(() => window.viewport.bodyMeshes.map((b) => b.id));
  await page.evaluate(([cyl, box, glass, hidden]) => {
    window.store.setBodiesMaterial([cyl], "m-carpaint");
    window.store.setBodiesMaterial([box], "m-emitter");
    window.store.setBodiesMaterial([glass], "m-glass");
    window.store.setBodyVisibility(hidden, false);
  }, [cyl, box, glass, hidden]);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1500);

  const screen = (x, y, z) => page.evaluate(([x, y, z]) => window.viewport.projectToScreen({ x, y, z }), [x, y, z]);
  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
  const prompt = () => page.evaluate(() => document.querySelector("#prompt")?.textContent ?? "");
  const looks = () => page.evaluate(() => JSON.stringify(window.viewport.bodyMeshes.map((b) => ({
    id: b.id,
    visible: b.mesh.visible,
    mats: (Array.isArray(b.mesh.material) ? b.mesh.material : [b.mesh.material]).map((m) => ({
      opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite,
      emissive: m.emissiveIntensity, clearcoat: m.clearcoat ?? null, transmission: m.transmission ?? null,
    })),
  }))));
  const opacityOf = (id) => page.evaluate((id) => {
    const b = window.viewport.bodyMeshes.find((x) => x.id === id);
    const m = Array.isArray(b.mesh.material) ? b.mesh.material[0] : b.mesh.material;
    return m.transparent ? m.opacity : 1;
  }, id);
  const startExtrude = async () => {
    await page.evaluate(() => {
      const f = window.__fundacad;
      f.overlay.update(window.store.document);
      f.overlay.selectRegionsByPoints([[0, 0, 30]]);
      f.handleAction("extrude");
    });
    await page.waitForTimeout(300);
  };
  // The depth free-tracks the cursor's projection onto the normal. Offset to the
  // side so the cursor never rests on the depth handle, which freezes the depth.
  const trackTo = async (z, dy = 0) => {
    const top = await screen(0, 0, 30);
    const at = await screen(0, 0, z);
    await page.mouse.move(top.x + 160, top.y - 40, { steps: 4 });
    await page.mouse.move(at.x + 160, at.y + dy, { steps: 16 });
    await page.waitForTimeout(300);
  };

  // --- 1. a straight cut ghosts the body it goes into, and only that one ------
  const before = await looks();
  await shot("0_model");
  await startExtrude();
  await trackTo(14);
  const during = JSON.parse(await looks());
  const inCut = during.find((b) => b.id === cyl).mats[0];
  check("the body the cut goes into is see-through", inCut.transparent && inCut.opacity < 1 && !inCut.depthWrite, JSON.stringify(inCut));
  check("its finish is off while ghosted, like x-ray", inCut.clearcoat === 0);
  check("bodies the cut does not reach are untouched",
    JSON.stringify(during.filter((b) => b.id !== cyl)) === JSON.stringify(JSON.parse(before).filter((b) => b.id !== cyl)));
  check("the hidden body stays hidden", during.find((b) => b.id === hidden).visible === false);
  await shot("1_cut_drag");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  const afterCancel = await looks();
  check("cancel hands every body back exactly", afterCancel === before, afterCancel === before ? "" : `\n    before ${before}\n    after  ${afterCancel}`);

  // --- 2. a tapered cut previews through the kernel and stays a cut ----------
  // The kernel's preview replaces the model on screen, pocket and all. Probing
  // that model again for "does this enter material" used to answer no, so the
  // preview flipped between Cut and Join on every rebuild.
  await startExtrude();
  await trackTo(14);
  await page.evaluate(() => { const x = window.extrude; x.dim.seed("taper", 8); x.updatePreview(); });
  await page.waitForTimeout(2500);
  const ops = [];
  let ghosted = true;
  for (let i = 1; i <= 4; i++) {
    await trackTo(14, 4 * i);
    await page.waitForTimeout(1500);
    ops.push(await page.evaluate(() => (window.store.preview ?? []).map((f) => f.operation).join(",")));
    if ((await opacityOf(cyl)) >= 1) ghosted = false;
  }
  check("a tapered cut stays a cut from one rebuild to the next", ops.every((o) => o === "cut"), ops.join(" "));
  check("and its body stays ghosted with the pocket visible inside", ghosted);
  await shot("2_tapered_cut_drag");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);
  check("cancelling the tapered cut hands every body back", (await looks()) === before);

  // --- 3. pulling up off the face is a join and ghosts nothing ---------------
  await startExtrude();
  await trackTo(46);
  const p3 = await prompt();
  check("a join pulled away from the body ghosts nothing", (await opacityOf(cyl)) === 1 && /Join/.test(p3), p3);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // --- 4. x-ray on before the gesture is still on after it -------------------
  await page.evaluate(() => window.viewport.setXray(true));
  await page.waitForTimeout(400);
  const xray = await looks();
  await startExtrude();
  await trackTo(14);
  await shot("4_xray_cut_drag");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check("x-ray is unchanged by the gesture", (await looks()) === xray);
  await page.evaluate(() => window.viewport.setXray(false));
  await page.waitForTimeout(400);
  check("and turning it off gives the original look", (await looks()) === before);

  // --- 5. press/pull pushing a face into its body ----------------------------
  await page.evaluate(() => window.__fundacad.overlay.clearRegionSelection());
  const face = await screen(0, -22, 30);
  await page.evaluate(() => window.__fundacad.handleAction("presspull"));
  await page.waitForTimeout(300);
  await page.mouse.click(face.x, face.y);
  await page.waitForTimeout(400);
  await page.keyboard.type("-10");
  await page.waitForTimeout(800);
  check("press/pull pushing in ghosts the body", (await opacityOf(cyl)) < 1);
  await shot("5_presspull_push");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("10");
  await page.waitForTimeout(800);
  check("press/pull pulling out ghosts nothing", (await opacityOf(cyl)) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  check("press/pull cancel hands every body back", (await looks()) === before);

  // --- 6. commit, then reopen the cut: the edit ghosts too -------------------
  await startExtrude();
  await trackTo(14);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  check("the committed cut leaves the body solid", (await opacityOf(cyl)) === 1);
  await shot("6_committed");
  const cutId = await page.evaluate(() => window.store.document.features.at(-1).id);
  await page.evaluate((id) => window.__fundacad.editFeature(id), cutId);
  await page.waitForTimeout(2500);
  check("reopening the cut ghosts the body it cuts", (await opacityOf(cyl)) < 1);
  await shot("7_edit");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);
  check("leaving the edit leaves the body solid", (await opacityOf(cyl)) === 1);

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
