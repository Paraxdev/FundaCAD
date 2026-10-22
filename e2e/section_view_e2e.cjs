// A confirmed section stays on as a view state: orbit, Fillet on F, Esc and undo all leave the cut in place.
// The model is a tapered asymmetric block off the origin with an off centre pocket, cut along a slanted side face.
//
// Usage (vite + engine running):
//   SC_TOKEN=<t> SC_CHROME=<exe> SC_URL=http://localhost:5952/ SC_ENGINE_PORT=8952 [SC_OUT=<dir>] \
//     node e2e/section_view_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const ENGINE_PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || process.env.SC_OUT || path.join(os.tmpdir(), "section_view_shots"));
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};

const POLY = [[30, -20], [118, -12], [104, 46], [41, 38]];
const HEIGHT = 40;

function modelDoc() {
  const lines = POLY.map((p, i) => {
    const q = POLY[(i + 1) % POLY.length];
    return { type: "line", x1: p[0], y1: p[1], x2: q[0], y2: q[1] };
  });
  return {
    parameters: {},
    features: [
      { id: "s1", type: "sketch", plane: "XY", entities: lines },
      { id: "e1", type: "extrude", sketch: "s1", distance: HEIGHT, operation: "new", taper: 7 },
      { id: "s2", type: "sketch", plane: { origin: [0, 0, HEIGHT], normal: [0, 0, 1], xdir: [1, 0, 0] },
        entities: [{ type: "circle", radius: 11, x: 70, y: 9 }] },
      { id: "e2", type: "extrude", sketch: "s2", distance: -25, operation: "cut" },
    ],
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  try {
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
    await page.waitForTimeout(2500);
    const modal = await page.$(".modal-close");
    if (modal) { await modal.click(); await page.waitForTimeout(400); }
    await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.section, null, { timeout: 60000 });

    const settle = async () => {
      await page.waitForTimeout(250);
      await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
      await page.waitForTimeout(300);
    };
    const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
    // A click on bare canvas, clear of every panel and of the model, takes focus from the offset box.
    const clickEmpty = async () => {
      const at = await page.evaluate(() => {
        for (let y = 820; y > 100; y -= 40)
          for (let x = 1000; x > 300; x -= 40) {
            const el = document.elementFromPoint(x, y);
            if (el?.tagName === "CANVAS" && window.viewport.bodyIdAt(x, y) === null) return { x, y };
          }
        return null;
      });
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(200);
    };
    const state = () => page.evaluate(() => {
      const v = window.viewport;
      let handles = 0;
      v.scene.scene.traverse((o) => { if (o.userData.handle === "section") handles++; });
      const shownBoxes = [...document.querySelectorAll(".dim-input")].filter((b) => b.style.display !== "none");
      const p = v.sectionPlane;
      return {
        phase: window.section.phase,
        sectioned: v.sectioned,
        handles,
        box: shownBoxes.length,
        cross: shownBoxes.some((b) => b.querySelector(".dim-no")),
        plane: [p.normal.x, p.normal.y, p.normal.z, p.constant].map((c) => Math.round(c * 1e4) / 1e4),
        fillet: window.edgeFeature.active,
      };
    });

    await page.evaluate(async (doc) => {
      window.store.loadDocument(doc);
      await window.store.rebuildNow();
    }, modelDoc());
    await page.waitForFunction(() => (window.store.buildState.result?.bodies ?? []).length > 0, null, { timeout: 60000 });
    await page.evaluate(() => { window.__fundacad.handleAction("iso"); window.__fundacad.handleAction("fit"); });
    await settle();

    // A point on the front side face (the one from (30,-20) to (118,-12)), found with the app's own picker.
    const face = await page.evaluate(([poly, h]) => {
      const v = window.viewport;
      const V = v.camera.position.constructor;
      const [a, b] = poly;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const inward = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      for (const t of [0.55, 0.45, 0.65, 0.35])
        for (const z of [h * 0.3, h * 0.5])
          for (const d of [0.6, 1.2, 1.8]) {
            const p = new V(a[0] + (b[0] - a[0]) * t + inward[0] * d, a[1] + (b[1] - a[1]) * t + inward[1] * d, z);
            const s = v.projectToScreen(p);
            const hit = v.pickFaceForPressPull(s.x, s.y);
            if (hit && Math.abs(hit.normal.z) > 0.05 && hit.normal.y < -0.5)
              return { x: s.x, y: s.y, normal: [hit.normal.x, hit.normal.y, hit.normal.z] };
          }
      return null;
    }, [POLY, HEIGHT]);
    check("found a point on the tapered front face", !!face, face);
    if (!face) throw new Error("no face point");

    console.log("\n[part 1: confirm keeps the cut on]");
    const tile = page.locator('.tool-rail [data-action="section"], [data-action="section"]:visible').first();
    await tile.click();
    await page.waitForTimeout(400);
    await page.locator(".choice-btn", { hasText: "Face or plane" }).click();
    await page.waitForTimeout(300);
    check("Section aims after Face or plane", (await state()).phase === "aiming");
    await page.mouse.click(face.x, face.y);
    await page.waitForTimeout(300);
    let s = await state();
    check("a face pick starts editing with the handle and the box, no cross",
      s.phase === "editing" && s.sectioned && s.handles === 1 && s.box === 1 && !s.cross, s);
    const dot = (p, n) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
    check("the cut first keeps the side the face points into", dot(s.plane, face.normal) > 0.999, s.plane);

    await clickEmpty();
    await page.keyboard.press("f");
    await page.waitForTimeout(200);
    s = await state();
    check("F while editing keeps the bulk", s.phase === "editing" && dot(s.plane, face.normal) < -0.999, s.plane);

    await page.locator(".dim-input input").first().click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("-9.5");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    s = await state();
    check("Enter keeps the cut on with no handle and no box",
      s.phase === "on" && s.sectioned && s.handles === 0 && s.box === 0, s);
    const kept = s.plane;

    const eye0 = await page.evaluate(() => window.viewport.camera.position.toArray());
    await page.mouse.move(700, 450);
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 22; i++) {
      await page.mouse.move(700 + i * 10, 450 + i);
      await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(400);
    const eye1 = await page.evaluate(() => window.viewport.camera.position.toArray());
    s = await state();
    const moved = Math.hypot(eye1[0] - eye0[0], eye1[1] - eye0[1], eye1[2] - eye0[2]);
    check("an orbit turns the camera and the cut stays on", moved > 1 && s.phase === "on" && s.sectioned,
      { moved: Math.round(moved), phase: s.phase });

    await clickEmpty();
    await page.keyboard.press("f");
    await page.waitForTimeout(400);
    s = await state();
    check("F starts Fillet over the cut, and does not flip it",
      s.fillet && s.phase === "on" && s.sectioned && JSON.stringify(s.plane) === JSON.stringify(kept), s);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    s = await state();
    check("Esc ends Fillet and the cut stays on", !s.fillet && s.phase === "on" && s.sectioned, s);

    await page.evaluate(() => window.store.updateFeature("e1", { distance: 46 }));
    await settle();
    await clickEmpty();
    await page.keyboard.press("Control+z");
    await settle();
    const dist = await page.evaluate(() => window.store.document.features.find((f) => f.id === "e1").distance);
    s = await state();
    check("undo of a model edit leaves the cut on and where it was",
      dist === HEIGHT && s.phase === "on" && s.sectioned && JSON.stringify(s.plane) === JSON.stringify(kept), { dist, s });
    await shot("01_on");
  } catch (err) {
    console.error(err);
    failures++;
  } finally {
    await browser.close();
  }
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}  (shots in ${OUT})`);
  process.exit(failures);
})();
