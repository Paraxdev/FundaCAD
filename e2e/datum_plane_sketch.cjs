// Can you click a construction plane and sketch on it?
//
// The unit test covers the arbitration in features/facePlanePick.ts with a stub
// viewport. This covers the half a stub cannot: a real quad, in a real scene,
// hit by a real raycast from a real click, with the plane it stands for carried
// on it — and then the sketch that click is supposed to open.
//
// It exists because the bug it checks for lived exactly in that gap. Every piece
// worked. A plane through three points was in the document, drew its quad,
// highlighted on hover and could be right-clicked; only the one question the
// sketch tool asks left it out, so the ray went through it to the base plane
// behind and the plane could not be sketched on by clicking it at all.
//
// Usage (from the repo root, with vite on 5173):
//   node e2e/datum_plane_sketch.cjs
// SC_CHROME names a Chromium/Brave binary if the default is wrong.

const { chromium } = require("playwright-core");

const CHROME = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";

// The plane from the reported document: three points on a part, so it is tilted
// and passes near but not through the origin. Nothing about the bug needed a
// special plane, and using the reported one keeps this honest.
const DATUM = {
  id: "f7",
  origin: [0.0319, -9.284, -2.993],
  normal: [0.00327, -0.95177, -0.30679],
  xdir: [0.00105, -0.30679, 0.95178],
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.viewport && window.store && window.__fundacad);
  // The welcome screen opens over a fresh profile and counts as a modal, so
  // every tool refuses to start while it is up. Nothing about this test is about
  // that; dismiss it and get on.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const failures = [];
  const check = (label, ok, detail) => {
    console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail === undefined ? "" : `  (${detail})`}`);
    if (!ok) failures.push(label);
  };

  // Put the datum in the document AND in the scene. Both, because the click has
  // to find a quad and the sketch has to be able to name the feature it is on.
  await page.evaluate((d) => {
    window.store.addFeature({
      id: d.id, type: "datumPlane",
      plane: { origin: d.origin, normal: d.normal, xdir: d.xdir }, name: "Plane",
    });
    window.viewport.setDatumPlanes([{ id: d.id, origin: d.origin, normal: d.normal, xdir: d.xdir }]);
    window.viewport.requestRender();
  }, DATUM);
  await page.waitForTimeout(300);

  // Straight down the middle of the canvas. The quad is 80mm across and centred
  // near the origin, and the default camera is framed on the origin, so the
  // centre of the view is over it.
  const box = await page.evaluate(() => {
    const r = window.viewport.domElement.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  const hit = await page.evaluate(
    (p) => window.viewport.pickConstructionAt(p.x, p.y),
    box,
  );
  check("the ray reaches the datum quad rather than a base plane", hit && hit.kind === "datum", JSON.stringify(hit));
  check("and the quad knows which plane it stands for", !!(hit && hit.def && hit.def.xdir), hit && JSON.stringify(hit.def));

  // Now the gesture. Sketch, then click.
  await page.evaluate(() => window.__fundacad.handleAction("sketch"));
  await page.waitForTimeout(200);
  check("the pick step is running", await page.evaluate(() => window.__fundacad.toolBusy()));

  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);

  const opened = await page.evaluate(() => ({
    active: window.sketch.active,
    normal: window.sketch.plane ? [window.sketch.plane.n.x, window.sketch.plane.n.y, window.sketch.plane.n.z] : null,
  }));
  check("clicking it opened a sketch", opened.active === true, JSON.stringify(opened));
  const dot = opened.normal
    ? opened.normal[0] * DATUM.normal[0] + opened.normal[1] * DATUM.normal[1] + opened.normal[2] * DATUM.normal[2]
    : 0;
  check("and on the datum's own plane, not one of the base planes", Math.abs(dot) > 0.999, dot.toFixed(6));

  // Draw something and finish, so the sketch lands in the document and can say
  // what it thinks it is on. `planeId` is what makes it FOLLOW the datum when
  // that datum's offset is edited later, instead of freezing where the plane
  // happened to be at pick time; the browser row's route has always recorded it.
  // Two clicks: a rectangle is corner-then-corner, and it is the tool the
  // sketcher arms itself with on entry.
  await page.mouse.click(box.x - 60, box.y - 40);
  await page.waitForTimeout(120);
  await page.mouse.click(box.x + 60, box.y + 40);
  await page.waitForTimeout(200);

  const saved = await page.evaluate(() => window.sketch.snapshotFeature());
  check("something was drawn on it", !!saved, saved && JSON.stringify(saved.entities?.length));
  check(
    "and the sketch is on the datum BY ID, not by a frozen copy of its plane",
    !!saved && saved.planeId === DATUM.id,
    saved && String(saved.planeId),
  );

  if (errors.length) check("no page errors", false, errors.slice(0, 3).join(" | "));

  await browser.close();
  if (failures.length) {
    console.error(`\n${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nOK a construction plane can be clicked and sketched on");
})().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
