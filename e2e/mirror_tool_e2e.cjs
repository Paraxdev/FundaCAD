// 3D Mirror as a tool with a panel, in a real browser.
//
//   0. A body clicked before the start fills Objects, Mirror comes from the selection toolbar and
//      waits on the plane; Shift click adds a second body.
//   1. The YZ chip sets the plane, a reflected ghost shows, Enter writes one mirror feature with
//      both bodies, the result is symmetric about YZ and one undo takes it back.
//   2. A curved face is refused as the plane, a flat face is taken: Enter adds a datum plane and
//      the mirror together and one undo removes both. Esc in a third run changes nothing.
//
// Usage (from the repo root, with vite and an engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/mirror_tool_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "mirror_tool_shots");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
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
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.__fundacad, null, {
    timeout: 60000,
  });

  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: "b1", type: "box", length: 20, width: 12, height: 8 });
    s.addFeature({ id: "m1", type: "move", bodies: ["body1"], dx: 30, dy: 7, dz: 4, rx: 0, ry: 0, rz: 25 });
    s.addFeature({ id: "b2", type: "box", length: 10, width: 10, height: 10 });
    s.addFeature({ id: "m2", type: "move", bodies: ["body2"], dx: -25, dy: 18, dz: 0, rx: 0, ry: 0, rz: 0 });
    s.addFeature({ id: "c3", type: "cylinder", radius: 4, height: 10 });
    s.addFeature({ id: "m3", type: "move", bodies: ["body3"], dx: 6, dy: -30, dz: 0, rx: 0, ry: 0, rz: 0 });
    await s.rebuildNow();
  });
  await page.waitForTimeout(1500);

  const settle = async () => {
    await page.waitForFunction(() => !window.store.buildState?.building, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(800);
  };
  const scr = (x, y, z) => page.evaluate(([x, y, z]) => window.viewport.projectToScreen({ x, y, z }), [x, y, z]);
  const clickAt = async (p, mods = []) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.click(p.x, p.y);
    for (const m of mods) await page.keyboard.up(m);
    await page.waitForTimeout(400);
  };
  // The point of the cylinder's side that faces the camera, half way up.
  const cylinderSide = () =>
    page.evaluate(() => {
      const c = window.viewport.camera.position;
      const dx = c.x - 6;
      const dy = c.y + 30;
      const l = Math.hypot(dx, dy) || 1;
      return window.viewport.projectToScreen({ x: 6 + (4 * dx) / l, y: -30 + (4 * dy) / l, z: 0 });
    });
  const features = () => page.evaluate(() => JSON.parse(JSON.stringify(window.store.doc.features)));
  const state = () =>
    page.evaluate(() => {
      const panel = document.querySelector(".mirror-panel");
      const field = (k) => {
        const row = panel && panel.querySelector(`.mirror-field[data-field="${k}"]`);
        if (!row) return null;
        return {
          value: row.querySelector(".mirror-field-v").textContent.trim(),
          active: row.classList.contains("active"),
          clearable: !row.querySelector(".float-card-close").disabled,
        };
      };
      const apply = panel && panel.querySelector(".mirror-actions .btn-primary");
      const g = window.viewport.ghosts && window.viewport.ghosts.ghosts;
      return {
        running: window.__fundacad.mirror.active,
        panel: !!panel,
        objects: field("objects"),
        plane: field("line"),
        chips: panel ? [...panel.querySelectorAll(".rd-chip")].map((c) => c.textContent.trim()) : [],
        ready: !!apply && !apply.disabled,
        ghost: g ? { copies: g.copies.length, m: g.copies.map((c) => Array.from(c.matrix.elements)) } : null,
      };
    });

  // 0: preselect by a click, start from the selection toolbar, Shift adds a second body
  await clickAt(await scr(30, 7, 8));
  const offer = await page.$("#toolrail [data-action='offer:mirror']");
  check("a selected body offers Mirror in the selection toolbar", !!offer);
  if (offer) await offer.click();
  else await page.evaluate(() => window.__fundacad.starters?.startMirror?.());
  await page.waitForTimeout(500);
  let st = await state();
  check("the panel opens with the three origin chips", st.panel && st.chips.join() === "XY,XZ,YZ", JSON.stringify(st));
  check(
    "the clicked body fills Objects and the plane is the active field",
    !!st.objects && /\b1\b/.test(st.objects.value) && st.plane.active && !st.ready,
    JSON.stringify([st.objects, st.plane]),
  );
  await clickAt(await scr(-25, 18, 5), ["Shift"]);
  st = await state();
  check(
    "Shift click adds the second body and stays on the plane",
    /\b2\b/.test(st.objects.value) && st.plane.active && !st.plane.clearable,
    JSON.stringify([st.objects, st.plane]),
  );

  // 1: YZ chip, ghost, Enter, symmetric result, one undo
  await page.click(".mirror-panel .rd-chip:nth-child(3)");
  await page.waitForTimeout(400);
  st = await state();
  check("the YZ chip sets the plane", st.plane.clearable && /YZ/.test(st.plane.value) && st.ready, st.plane.value);
  const m = st.ghost && st.ghost.m[0];
  check(
    "one reflected ghost shows, x flipped across YZ",
    !!m && st.ghost.copies === 1 && near(m[0], -1, 1e-9) && near(m[5], 1, 1e-9) && near(m[10], 1, 1e-9),
    JSON.stringify(st.ghost),
  );
  await page.screenshot({ path: path.join(OUT, "00_ghost.png") });

  const before = await features();
  await page.keyboard.press("Enter");
  await settle();
  let after = await features();
  const fresh = after.filter((f) => !before.some((b) => b.id === f.id));
  check(
    "Enter writes one mirror feature with both bodies across YZ",
    fresh.length === 1 &&
      JSON.stringify({ ...fresh[0], id: "x" }) ===
        JSON.stringify({ id: "x", type: "mirror", plane: { name: "YZ" }, bodies: ["body1", "body2"] }),
    JSON.stringify(fresh),
  );
  st = await state();
  check("the tool ends and the ghost goes", !st.running && !st.panel && !st.ghost, JSON.stringify(st));
  const box = await page.evaluate(() => {
    const model = window.viewport.model;
    const b = model && model.bodies.find((x) => x.id === "body1");
    if (!b) return null;
    b.mesh.geometry.computeBoundingBox();
    const bb = b.mesh.geometry.boundingBox;
    return { minX: bb.min.x, maxX: bb.max.x };
  });
  check("body1 is now symmetric about YZ", !!box && near(box.minX, -box.maxX, 0.01), JSON.stringify(box));
  await page.screenshot({ path: path.join(OUT, "01_committed.png") });

  await page.evaluate(() => window.store.undo());
  await settle();
  after = await features();
  check("one undo takes the mirror back", after.length === before.length, `${after.length} vs ${before.length}`);

  // 2: a curved face is refused, a flat face makes a datum plane in the same undo step
  await clickAt(await scr(30, 7, 8));
  await page.click("#toolrail [data-action='offer:mirror']").catch(() => {});
  await page.waitForTimeout(500);
  const side = await cylinderSide();
  const hit = await page.evaluate((p) => window.viewport.bodyIdAt(p.x, p.y), side);
  check("the click lands on the cylinder", hit === "body3", String(hit));
  await clickAt(side);
  st = await state();
  check(
    "the cylinder's round side is refused as the plane",
    st.running && !st.plane.clearable && /\b1\b/.test(st.objects.value),
    JSON.stringify(st.plane),
  );
  await clickAt(await scr(-25, 18, 5));
  st = await state();
  check("a flat face is taken as the plane", st.plane.clearable && st.ready, st.plane.value);
  await page.screenshot({ path: path.join(OUT, "02_flat_face.png") });
  const before2 = await features();
  await page.keyboard.press("Enter");
  await settle();
  const fresh2 = (await features()).filter((f) => !before2.some((b) => b.id === f.id));
  check(
    "Enter adds a datum plane on the face and the mirror across it",
    fresh2.length === 2 &&
      fresh2[0].type === "datumPlane" &&
      fresh2[0].offset === 0 &&
      !!fresh2[0].face &&
      JSON.stringify({ ...fresh2[1], id: "x" }) ===
        JSON.stringify({ id: "x", type: "mirror", plane: { name: fresh2[0].id }, bodies: ["body1"] }),
    JSON.stringify(fresh2),
  );
  const errs = await page.evaluate(() => window.store.buildState.errorMessage);
  check("the face mirror builds", !errs, String(errs));
  await page.evaluate(() => window.store.undo());
  await settle();
  check("one undo removes both", (await features()).length === before2.length);

  // Esc in a third run changes nothing and gives the selection back
  await clickAt(await scr(30, 7, 8));
  await page.click("#toolrail [data-action='offer:mirror']").catch(() => {});
  await page.waitForTimeout(400);
  await page.click(".mirror-panel .rd-chip:nth-child(1)");
  await page.keyboard.press("Escape");
  await settle();
  st = await state();
  const sel = await page.evaluate(() => [...window.viewport.getSelectedBodies()]);
  check(
    "Esc leaves the document as it was",
    !st.running && !st.panel && !st.ghost && (await features()).length === before.length,
    JSON.stringify(st),
  );
  check("Esc gives the preselected body back", sel.join() === "body1", JSON.stringify(sel));

  console.log(`\n${failures === 0 ? "all checks passed" : failures + " check(s) failed"}`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
})();
