// A stress load placed on a hook with one click, in a real browser against a
// real engine: no face is split for it.
//
//   1. Place on the load row arms the row, and an orb follows the cursor.
//   2. A click on the hook's arm puts a spot there, selects nothing, and
//      disarms the row.
//   3. A drag of the orb's rim sizes it, and the panel's field follows.
//   4. Run solves with the spot: the applied load is the force, balanced by
//      the reaction, and the result's colours go on the body.
//   5. The spot is saved with the document's study.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/stress_spot_e2e.cjs [shots dir]
const { chromium } = require("playwright-core");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const SHOTS = process.argv[2] || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  const idle = () => page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

  // A wall hook: a plate, an arm out of its foot along +X and a tip up at the
  // arm's end. The arm's top is one face from the plate to the tip.
  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: "plate", type: "box", length: 6, width: 30, height: 60 });
    s.addFeature({ id: "arm", type: "box", length: 30, width: 10, height: 6 });
    s.addFeature({ id: "arm_at", type: "move", dx: 18, dz: -27, bodies: ["body2"] });
    s.addFeature({ id: "tip", type: "box", length: 6, width: 10, height: 12 });
    s.addFeature({ id: "tip_at", type: "move", dx: 30, dz: -21, bodies: ["body3"] });
    s.addFeature({ id: "hook", type: "boolean", operation: "union", target: "body1", tools: ["body2", "body3"] });
    await s.rebuildNow();
  });
  await page.waitForTimeout(600);
  await idle();
  const bodies = await page.evaluate(() => (window.store.buildState.result?.bodies ?? []).map((b) => b.id));
  check("CONTROL: the hook is one body", bodies.length === 1, bodies.join(" "));
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(800);

  await page.evaluate(() => window.__fundacad.handleAction("stress"));
  await page.waitForSelector(".stress-place-load");
  // The wall side of the plate is a whole face, so it goes in the old way.
  await page.evaluate(() => window.viewport.selectOnlyFace(window.viewport.faceIdNear([-3, 0, 0])));
  await page.click(".stress-set-support");
  await page.waitForTimeout(200);

  const screen = (p) => page.evaluate((q) => {
    const v = window.viewport.camera.position.clone().set(q[0], q[1], q[2]);
    const s = window.viewport.projectToScreen(v);
    return { x: s.x, y: s.y };
  }, p);
  const state = () => page.evaluate(() => {
    const study = window.store.stressStudy;
    return {
      faces: window.viewport.getSelectedFaceIds().length,
      bodies: window.viewport.getSelectedBodies().length,
      label: document.querySelector(".stress-place-load")?.textContent?.trim() ?? "",
      count: [...document.querySelectorAll(".stress-count")].map((e) => e.textContent.trim()),
      radius: document.querySelector(".stress-spot-radius")?.value ?? null,
      cursor: window.viewport.domElement.style.cursor,
      spots: study?.loads?.[0]?.spots ?? null,
    };
  });

  await page.click(".stress-place-load");
  await page.waitForTimeout(200);
  const armed = await state();
  check("Place arms the load row", armed.label === "Placing…", JSON.stringify(armed.label));
  const at = await screen([12, 0, -24]);
  await page.mouse.move(at.x - 30, at.y);
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await page.waitForTimeout(300);
  check("the cursor is a crosshair over the body", (await state()).cursor === "crosshair");
  await shot("1-hover");
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);
  const placed = await state();
  const spot = placed.spots?.[0];
  check("a click puts one spot on the load", placed.spots?.length === 1, JSON.stringify(placed.spots));
  check("where the click landed, on the arm's top",
    !!spot && Math.abs(spot.at[0] - 12) < 1 && Math.abs(spot.at[1]) < 1 && Math.abs(spot.at[2] + 24) < 0.01, JSON.stringify(spot?.at));
  check("with the top's normal", !!spot && spot.normal?.[2] > 0.99, JSON.stringify(spot?.normal));
  check("the click selected nothing in the view", placed.faces === 0 && placed.bodies === 0, `${placed.faces} faces, ${placed.bodies} bodies`);
  check("the row is disarmed after one spot", placed.label === "Place", JSON.stringify(placed.label));
  check("the row counts it", placed.count[1] === "1 spot", JSON.stringify(placed.count));
  await shot("2-placed");

  // The rim handle stands on the orb's rim to the camera's right.
  const rim = await page.evaluate(() => {
    const spot = window.store.stressStudy.loads[0].spots[0];
    const cam = window.viewport.camera;
    const right = cam.position.clone().set(1, 0, 0).applyQuaternion(cam.quaternion);
    const p = cam.position.clone().set(...spot.at).addScaledVector(right, spot.radius);
    const s = window.viewport.projectToScreen(p);
    return { x: s.x, y: s.y, radius: spot.radius };
  });
  await page.mouse.move(rim.x, rim.y);
  await page.waitForTimeout(150);
  check("the rim handle shows it can be dragged", (await state()).cursor === "ew-resize", (await state()).cursor);
  await page.mouse.down();
  await page.mouse.move(rim.x + 12, rim.y, { steps: 4 });
  await page.mouse.move(rim.x + 30, rim.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const sized = await state();
  check("a drag of the rim grows the spot", sized.spots?.[0]?.radius > rim.radius, `${rim.radius} to ${sized.spots?.[0]?.radius}`);
  check("and the panel's field follows", Number(sized.radius) === sized.spots?.[0]?.radius, String(sized.radius));
  await page.fill(".stress-spot-radius", "3");
  await page.waitForTimeout(200);
  check("the field sets it back", (await state()).spots?.[0]?.radius === 3);

  await page.selectOption(".measure-row:has(.stress-force) + .measure-row select", "-Z");
  await page.fill(".stress-force", "40");
  await page.click(".stress-run");
  await page.waitForFunction(() => !document.querySelector(".stress-run")?.disabled, null, { timeout: 180000 });
  await page.waitForTimeout(500);
  const rows = await page.evaluate(() => {
    const out = {};
    for (const r of document.querySelectorAll(".stress-panel .measure-row")) {
      const k = r.querySelector(".measure-k")?.textContent?.trim();
      const v = r.querySelector(".measure-v")?.textContent?.trim();
      if (k && v) out[k] = v;
    }
    return { rows: out, error: document.querySelector(".stress-error")?.textContent ?? null, warnings: [...document.querySelectorAll(".stress-warning")].map((e) => e.textContent) };
  });
  check("Run gives a result", !rows.error && !!rows.rows["Peak von Mises"], rows.error ?? rows.rows["Peak von Mises"]);
  check("the applied load is the 40 N on the spot", rows.rows["Applied"] === "0, 0, -40 N", rows.rows["Applied"]);
  check("balanced by the reaction at the wall", rows.rows["Reaction"] === "0, 0, 40 N", rows.rows["Reaction"]);
  check("the colours are on the body", await page.evaluate(() => window.viewport.hasStressOverlay()));
  console.log(`  peak ${rows.rows["Peak von Mises"]}, deflection ${rows.rows["Max deflection"]}, mesh ${rows.rows["Mesh"]}`);
  for (const w of rows.warnings) console.log(`  warning: ${w}`);
  await shot("3-result");

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
