// Materials, in a real browser with a real WebGL renderer.
//
// The component and unit tests cover what the document holds and what the store
// hands the viewport. This covers the half that only exists once there are
// pixels: that a metal actually looks metallic, that glass is actually
// see-through, and that the three writers of a body's material (an assigned
// material, x-ray, and the stale-model ghost) do not each undo the others.
//
// The assertions read THREE.js material state back out of the live scene rather
// than comparing screenshots: a pixel diff of a lit sphere is a test that fails
// when a driver changes. The screenshots are there to be looked at.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> node e2e/materials_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "materials_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
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

  // Three bodies side by side: one left alone, one metal, one glass.
  const ids = await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      const id = window.store.nextId();
      window.store.addFeature({ id, type: "box", length: 20, width: 20, height: 20 });
      window.store.addFeature({
        id: window.store.nextId(), type: "move", body: `body${i + 1}`,
        dx: (i - 1) * 30, dy: 0, dz: 0,
      });
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const b = window.store.buildState;
      if (!b.building && b.result?.bodies?.length >= 3) return b.result.bodies.map((x) => x.id);
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  });
  check("three bodies built", Array.isArray(ids) && ids.length === 3, String(ids));
  if (!Array.isArray(ids)) { await browser.close(); process.exit(1); }

  /** Every body's live THREE material state, which is what "it looks metallic"
   *  means in terms something can assert. */
  const finishes = () => page.evaluate(() =>
    Object.fromEntries(window.viewport.bodyMeshes.map((b) => {
      const m = b.mesh.material;
      return [b.id, {
        metalness: +m.metalness.toFixed(3),
        roughness: +m.roughness.toFixed(3),
        opacity: +m.opacity.toFixed(3),
        transparent: m.transparent,
        depthWrite: m.depthWrite,
      }];
    })));

  const before = await finishes();
  check("an unstyled body wears the app's default finish",
    before[ids[0]].metalness === 0.1 && before[ids[0]].roughness === 0.55
      && before[ids[0]].opacity === 1 && before[ids[0]].transparent === false,
    JSON.stringify(before[ids[0]]));
  await page.locator("#viewport").screenshot({ path: `${OUT}/1-plain.png` });

  await page.evaluate((b) => {
    window.store.setBodiesMaterial([b[1]], "m-copper");
    window.store.setBodiesMaterial([b[2]], "m-glass");
  }, ids);
  await page.waitForTimeout(600);

  const after = await finishes();
  check("a metal body is metallic and the plain one is untouched",
    after[ids[1]].metalness === 0.95 && after[ids[1]].roughness === 0.25
      && after[ids[0]].metalness === 0.1,
    JSON.stringify({ metal: after[ids[1]], plain: after[ids[0]] }));
  check("a glass body is see-through, and stops writing depth so it can be seen through",
    after[ids[2]].opacity === 0.25 && after[ids[2]].transparent === true
      && after[ids[2]].depthWrite === false,
    JSON.stringify(after[ids[2]]));
  await page.locator("#viewport").screenshot({ path: `${OUT}/2-materials.png` });

  // --- the three writers of a material, against each other ------------------
  await page.evaluate(() => window.viewport.setXray(true));
  await page.waitForTimeout(300);
  const xray = await finishes();
  check("x-ray makes the plain body see-through",
    xray[ids[0]].transparent === true && xray[ids[0]].opacity < 1, JSON.stringify(xray[ids[0]]));
  check("x-ray does not make glass LESS see-through than its material says",
    xray[ids[2]].opacity <= 0.25, JSON.stringify(xray[ids[2]]));
  await page.locator("#viewport").screenshot({ path: `${OUT}/3-xray.png` });

  await page.evaluate(() => window.viewport.setXray(false));
  await page.waitForTimeout(300);
  const back = await finishes();
  check("turning x-ray off restores each body to its OWN material, not to the default",
    back[ids[2]].opacity === 0.25 && back[ids[1]].metalness === 0.95
      && back[ids[0]].opacity === 1,
    JSON.stringify(back));

  // --- and it survives a rebuild, which hands back fresh materials ----------
  const survived = await page.evaluate(async () => {
    window.store.addFeature({ id: window.store.nextId(), type: "box", length: 5, width: 5, height: 5 });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const b = window.store.buildState;
      if (!b.building && b.result?.bodies?.length >= 4) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 400));
    return Object.fromEntries(window.viewport.bodyMeshes.map((b) => [b.id, {
      metalness: +b.mesh.material.metalness.toFixed(3),
      opacity: +b.mesh.material.opacity.toFixed(3),
    }]));
  });
  check("a rebuild does not strip the materials off the bodies",
    survived[ids[1]].metalness === 0.95 && survived[ids[2]].opacity === 0.25,
    JSON.stringify(survived));

  // --- the library round-trips through a file --------------------------------
  const lib = await page.evaluate(async () => {
    const { serializeLibrary, parseLibrary } = await import("/src/document/materials.ts");
    const json = serializeLibrary(window.store.materialLibrary);
    const back = parseLibrary(json);
    return { problem: back.problem, same: JSON.stringify(back.materials) === JSON.stringify(window.store.materialLibrary) };
  });
  check("the library exports and reads back unchanged", lib.problem === null && lib.same, JSON.stringify(lib));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
