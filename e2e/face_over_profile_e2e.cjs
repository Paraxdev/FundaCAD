// A face under a visible sketch, in a real browser.
//
//   1. A sketch whose outline traces a whole face lies in the face: clicking it
//      selects the FACE, not the profile area.
//   2. A small circle sketched on that face is still its own target: clicking
//      inside it selects the profile area, and its hover highlight shows.
//   3. A profile behind the body, seen through it, is not picked, while one off
//      to the side with nothing in front of it still is.
//
// Usage (from the repo root, with vite + sidecar running):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/face_over_profile_e2e.cjs [outDir]
// SC_URL (default http://localhost:5173/) and SC_PORT (the sidecar port, default
// 8765) point it at servers that are not on the default ports.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "face_over_profile_shots");
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
  await page.addInitScript(([t, port]) => {
    const N = window.WebSocket;
    class P extends N {
      constructor(u, p) {
        let s = String(u).replace(/([?&])token=[^&]*/, `$1token=${t}`).replace(":8765", `:${port}`);
        s = s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t;
        super(s, p);
      }
    }
    window.WebSocket = P;
  }, [TOKEN, PORT]);
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.overlay && !!window.viewport, null, { timeout: 60000 });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "b1", type: "box", length: 40, width: 40, height: 20 });
    await window.store.rebuildNow();
  });
  const bb = await page.evaluate(() => window.store.buildState.result?.bbox ?? null);
  check("the box built", !!bb, JSON.stringify(bb));
  const [minX, minY, minZ] = bb.min;
  const [maxX, maxY] = bb.max;
  const cxW = (minX + maxX) / 2;
  const cyW = (minY + maxY) / 2;
  const planeZ = minZ;

  const setSketch = (entities) => page.evaluate(async ([entities, z]) => {
    if (window.store.document.features.some((f) => f.id === "s1")) window.store.removeFeature("s1");
    const plane = { origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] };
    window.store.addFeature({ id: "s1", type: "sketch", plane: z === 0 ? "XY" : plane, entities });
    await window.store.rebuildNow();
  }, [entities, planeZ]);
  const view = async (v) => {
    await page.evaluate((v) => window.viewport.setStandardView(v), v);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(1000);
  };
  const screenOf = (x, y, z) => page.evaluate(([x, y, z]) => {
    const T = window.viewport.rayFrom(0, 0).ray.origin.constructor;
    return window.viewport.projectToScreen(new T(x, y, z));
  }, [x, y, z]);
  const reset = () => page.evaluate(() => {
    window.overlay.clearRegionSelection();
    window.viewport.setSelectedBodies([]);
    window.viewport.clearSelection();
  });
  const state = () => page.evaluate(() => ({
    regions: window.overlay.selectedRegions().length,
    faces: window.viewport.getSelectedFaceIds().length,
    bodies: window.viewport.getSelectedBodies().length,
    prompt: document.querySelector(".prompt")?.textContent?.trim() ?? null,
  }));

  console.log("\n1. a sketch tracing the whole bottom face");
  await setSketch([{ type: "rectangle", id: "r1", x: cxW, y: cyW, width: maxX - minX, height: maxY - minY }]);
  await view("bottom");
  const regionCount = await page.evaluate(() => window.overlay.regions?.length ?? null);
  console.log(`  visible profile areas: ${regionCount}`);
  await reset();
  {
    const p = await screenOf(cxW + 5, cyW + 5, planeZ);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(200);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(400);
    let s = await state();
    check("the first click takes the body, not the profile area", s.regions === 0 && s.bodies === 1, JSON.stringify(s));
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(400);
    s = await state();
    check("the next click selects the face, not the profile area", s.regions === 0 && s.faces === 1, JSON.stringify(s));
    const pp = await page.evaluate(() => !!window.viewport.selectedFacesForPressPull());
    check("the face is ready for press/pull", pp);
    await page.mouse.move(p.x + 3, p.y + 3);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, "1_whole_face_selected.png") });
  }

  console.log("\n2. a small circle on the same face");
  await setSketch([{ type: "circle", id: "c1", x: cxW, y: cyW, radius: 6 }]);
  await view("bottom");
  await reset();
  {
    const p = await screenOf(cxW, cyW, planeZ);
    await page.mouse.move(p.x + 1, p.y + 1);
    await page.waitForTimeout(300);
    const hovered = await page.evaluate(() => {
      const o = window.overlay;
      return !!o.hovered;
    });
    check("hovering inside the circle highlights its area", hovered);
    await page.screenshot({ path: path.join(OUT, "2_circle_hover.png") });
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(400);
    const s = await state();
    check("clicking inside the circle selects the profile area", s.regions === 1 && s.faces === 0, JSON.stringify(s));
    await page.screenshot({ path: path.join(OUT, "2b_circle_selected.png") });
    const q = await screenOf(cxW + 15, cyW + 15, planeZ);
    await reset();
    await page.mouse.move(q.x, q.y);
    await page.waitForTimeout(200);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(400);
    const s2 = await state();
    check("clicking the face outside the circle does not take the area", s2.regions === 0 && s2.bodies + s2.faces === 1, JSON.stringify(s2));
  }

  console.log("\n3. a profile behind the body");
  await setSketch([
    { type: "circle", id: "c1", x: cxW, y: cyW, radius: 6 },
    { type: "circle", id: "c2", x: maxX + 30, y: cyW, radius: 6 },
  ]);
  await view("top");
  await reset();
  {
    const p = await screenOf(cxW, cyW, planeZ);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(300);
    const hovered = await page.evaluate(() => !!window.overlay.hovered);
    check("the hidden circle does not hover through the body", !hovered);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(400);
    const s = await state();
    check("clicking over the hidden circle takes the body, not the area", s.regions === 0 && s.bodies + s.faces === 1, JSON.stringify(s));
    await page.screenshot({ path: path.join(OUT, "3_hidden_circle.png") });
    await reset();
    const q = await screenOf(maxX + 30, cyW, planeZ);
    await page.mouse.move(q.x, q.y);
    await page.waitForTimeout(200);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(400);
    const s2 = await state();
    check("a circle with nothing in front of it is still picked", s2.regions === 1, JSON.stringify(s2));
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
