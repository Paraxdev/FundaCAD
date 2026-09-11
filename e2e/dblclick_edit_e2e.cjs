// Double-click a face to edit the feature that made it, in a real browser.
//
// tests/app/selection.test.ts proves editFeature dispatches to the right
// per-type edit. It cannot prove the VIEWPORT reaches editFeature at all: the
// double-click is a raw DOM event on the canvas, resolved through a live
// raycast (viewport.faceIdAt) and the build's faceOwners, none of which a pure
// test has. So the question here is the one it structurally cannot ask, does
// double-clicking a face on the model open that feature's edit, and does a
// single click, or a double-click on empty space, deliberately NOT.
//
// The signal is toolBusy(): editing an extrude opens the interactive extrude
// tool, which a plain selection never does. Extrude, not a box primitive,
// precisely because a box has no draggable edit and so would not move the
// signal either way.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/dblclick_edit_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "dblclick_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
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

  // A box, made by a sketch + extrude, so the faces are owned by an edit that
  // has an interactive tool (the extrude).
  await page.evaluate(async () => {
    window.store.addFeature({ id: "s", type: "sketch", plane: "XY", entities: [{ type: "rectangle", width: 30, height: 30, x: 0, y: 0 }] });
    window.store.addFeature({ id: "e", type: "extrude", sketch: "s", distance: 20, operation: "new" });
    await window.store.rebuildNow();
  });
  await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(700);

  // A screen point over a face owned by the extrude "e", found the way the app
  // resolves one: faceIdAt, then featureForFace off the build's faceOwners.
  const spot = await page.evaluate(() => {
    const bodies = window.store.buildState.result?.bodies ?? [];
    const ownerOf = (faceId) => {
      for (const b of bodies) {
        if (faceId >= b.faceStart && faceId < b.faceStart + b.faceCount) {
          return b.faceOwners?.[faceId - b.faceStart] ?? null;
        }
      }
      return null;
    };
    const W = window.innerWidth, H = window.innerHeight;
    for (let yy = 180; yy < H - 180; yy += 6) {
      for (let xx = 220; xx < W - 220; xx += 6) {
        const face = window.viewport.faceIdAt(xx, yy);
        if (face != null && ownerOf(face) === "e") return { x: xx, y: yy };
      }
    }
    return null;
  });
  check("found a screen point over a face of the extrude", !!spot, JSON.stringify(spot));
  if (!spot) { await browser.close(); process.exit(1); }

  // A canvas point that is over NOTHING (faceIdAt null), for the empty-space
  // control. Found rather than guessed: where the model sits on screen depends
  // on the fit, and a hardcoded corner can land on the box or a side panel.
  const empty = await page.evaluate(() => {
    const r = window.viewport.domElement.getBoundingClientRect();
    for (let yy = r.top + 40; yy < r.bottom - 40; yy += 10) {
      for (let xx = r.left + 40; xx < r.right - 40; xx += 10) {
        if (window.viewport.faceIdAt(xx, yy) == null) return { x: xx, y: yy };
      }
    }
    return null;
  });
  check("found an empty canvas point", !!empty, JSON.stringify(empty));
  if (!empty) { await browser.close(); process.exit(1); }

  const busy = () => page.evaluate(() => window.__fundacad.toolBusy());
  const clearSel = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(300); };

  // CONTROL 1: a single click selects the face, it does not edit anything.
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(350);
  check("CONTROL: a single click on the face opens no edit", (await busy()) === false);
  await clearSel();

  // CONTROL 2: a double-click on empty canvas is a no-op.
  await page.mouse.dblclick(empty.x, empty.y);
  await page.waitForTimeout(350);
  check("CONTROL: a double-click on empty space opens no edit", (await busy()) === false);
  await clearSel();

  // The behaviour: a double-click on the face opens the extrude's edit.
  await page.mouse.dblclick(spot.x, spot.y);
  await page.waitForTimeout(600);
  check("a double-click on the face opens the extrude's edit", (await busy()) === true);
  await page.screenshot({ path: `${OUT}/face-doubleclick-edit.png` });

  // And Escape leaves it cleanly: the tool ends and the body is still there.
  await clearSel();
  const after = await page.evaluate(() => ({
    busy: window.__fundacad.toolBusy(),
    bodies: (window.store.buildState.result?.bodies ?? []).length,
  }));
  check("Escape ends the edit and keeps the body", after.busy === false && after.bodies > 0, JSON.stringify(after));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
