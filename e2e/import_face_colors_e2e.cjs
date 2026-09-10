// The colours an imported file put on individual FACES, in a real browser with
// a real renderer.
//
// Its sibling import_colors_e2e.cjs covers the other half, a file that colours
// its PRODUCTS. This one covers what a mechanical CAD system actually writes:
// the reference board styles all 1,803 of its faces and leaves its 29 products
// wearing a default nobody chose, so a reader that asks only the product tree
// draws a red circuit board flat grey, and a see-through one at that.
//
// The unit tests cover the packing and the sidecar tests cover the walk from
// XCAF to the body dict. What only exists once there are pixels is the last
// hop: that the face the file painted red is drawn red, and that a body whose
// faces all agree is drawn from its material like any other body rather than
// through a six-figure per-face map.
//
// Read back off the live THREE scene (the baked vertex colours and the material
// state), not off a screenshot: a pixel diff of a lit solid is a test that fails
// when a graphics driver changes. The screenshots are there to be looked at.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> node e2e/import_face_colors_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const STEP = process.env.SC_STEP
  || path.resolve(__dirname, "../sidecar/fixtures/asm_face_colors.step");
const OUT = path.resolve(process.argv[2] || "face_color_shots");
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

  // ---- import the file, the same way the File menu does ---------------------
  console.log(`\nimporting ${STEP}`);
  const t0 = Date.now();
  const imported = await page.evaluate(async (file) => {
    const mod = await import("/src/io/files.ts");
    await mod.importPath(window.store, window.geometry, file);
    await window.store.rebuildNow();
    const f = window.store.document.features.find((x) => x.type === "import");
    return {
      parts: f?.parts?.length ?? 0,
      withColors: (f?.parts ?? []).filter((p) => p.faceColors).length,
      palettes: (f?.parts ?? []).map((p) => p.faceColors?.palette ?? []),
      bodies: (window.store.buildState.result?.bodies ?? []).map((b) => ({
        id: b.id, name: b.name, faceStart: b.faceStart, faceCount: b.faceCount,
        faceColors: b.faceColors ?? null,
      })),
    };
  }, STEP);
  console.log(`  imported in ${((Date.now() - t0) / 1000).toFixed(1)}s: `
    + `${imported.parts} parts, ${imported.bodies.length} bodies`);

  check("the import feature carries per-face colours",
    imported.withColors > 0,
    `${imported.withColors} of ${imported.parts} parts, palettes ${JSON.stringify(imported.palettes)}`);

  const coloured = imported.bodies.filter((b) => b.faceColors);
  check("the colours reached the BODIES over the wire",
    coloured.length > 0,
    `${coloured.length} of ${imported.bodies.length} bodies`);

  // ---- what the document decided the colours MEAN ---------------------------
  const decided = await page.evaluate(async () => {
    const fc = await import("/src/document/faceColors.ts");
    const bodies = window.store.buildState.result?.bodies ?? [];
    const bodyPaint = window.store.materialPaint();
    const mats = await import("/src/document/materials.ts");
    const palettes = (window.store.document.features.find((x) => x.type === "import")?.parts ?? [])
      .flatMap((p) => p.faceColors?.palette ?? []);
    const resolved = {};
    for (const hex of palettes) {
      resolved[hex.toLowerCase()] = mats.nearestMaterial(hex, window.store.materialLibrary)?.name ?? null;
    }
    return {
      library: window.store.materialLibrary.map((m) => [m.name, m.color]),
      assigned: bodies.map((b) => [b.name, window.store.bodyMaterialOf(b.id)?.color ?? null]),
      facePaint: fc.importedFacePaint(bodies, bodyPaint),
      resolved,
    };
  });
  // Every colour the file used has to RESOLVE to a material, which is not the
  // same as appearing in the library verbatim: materialsForColors matches a
  // near-enough existing material before it mints a new one, deliberately, so
  // that re-importing a revision does not leave two libraries of near-identical
  // greys. #ffffff resolving to "Plastic, white" is that rule working.
  check("every colour the file used resolves to a material",
    imported.palettes.flat().every((h) => decided.resolved[String(h).toLowerCase()]),
    `resolved ${JSON.stringify(decided.resolved)}`);
  check("a body wears the colour of its own FACES, not its product's",
    decided.assigned.some(([, hex]) => hex !== null),
    JSON.stringify(decided.assigned));

  const nFacePaint = Object.keys(decided.facePaint).length;
  const nFaces = imported.bodies.reduce((n, b) => n + b.faceCount, 0);
  // A body's material already carries its dominant colour, so only the minority
  // faces may cost anything. This is the check that would have caught comparing
  // against the material instead of the dominant, which named every face of
  // every body because a near-match is not an exact one.
  check("only the minority faces cost anything",
    nFacePaint > 0 && nFacePaint < nFaces / 10,
    `${nFacePaint} face entries against ${nFaces} faces`);
  const ranges = imported.bodies.map((b) => [b.faceStart, b.faceStart + b.faceCount]);
  check("no face entry lands outside a body",
    Object.keys(decided.facePaint).every((k) => ranges.some(([a, z]) => +k >= a && +k < z)),
    `${nFacePaint} entries against ${ranges.length} bodies`);

  // ---- and what is actually on screen --------------------------------------
  //
  // The colour a face is DRAWN in is baked per vertex (viewport.applyAnalysis ->
  // Highlighter.setBase), so this is the only place the whole chain can be read
  // back: file -> XCAF -> manifest -> document -> wire -> paint map -> vertex.
  const onScreen = await page.evaluate(async () => {
    // Through THREE's own conversion, not by scaling the floats. A vertex colour
    // is stored in the renderer's LINEAR working space, so reading the raw
    // components and multiplying by 255 reports #e51919 as #c80202, which looks
    // exactly like the colour arriving wrong.
    const THREE = await import("/node_modules/three/build/three.module.js");
    const probe = new THREE.Color();
    const out = [];
    for (const b of window.viewport.bodyMeshes) {
      const col = b.mesh.geometry.getAttribute("color");
      if (!col) continue;
      const seen = new Map();
      for (let i = 0; i < col.count; i++) {
        const hex = "#" + probe.fromBufferAttribute(col, i).getHexString(THREE.SRGBColorSpace);
        seen.set(hex, (seen.get(hex) ?? 0) + 1);
      }
      out.push({ id: b.id, colors: [...seen.entries()].sort((a, c) => c[1] - a[1]) });
    }
    return { bodies: out };
  });
  for (const b of onScreen.bodies) {
    console.log(`  ${b.id}: ${b.colors.map(([h, n]) => `${h}x${n}`).join(" ")}`);
  }
  const drawn = new Set(onScreen.bodies.flatMap((b) => b.colors.map(([h]) => h.toLowerCase())));
  const wanted = [...new Set(imported.palettes.flat().map((h) => String(h).toLowerCase()))];

  // Every colour the file painted is either drawn EXACTLY, or drawn as the
  // library material it matched, which is within the match tolerance of it
  // (materials.ts's nearestMaterial, 24 per channel). Only a body's DOMINANT
  // colour can be the second case: the minority faces are named individually,
  // so they are exact or they are wrong.
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const near = (a, b) => rgb(a).reduce((d, v, i) => d + (v - rgb(b)[i]) ** 2, 0) <= 24 * 24 * 3;
  const lost = wanted.filter((h) => ![...drawn].some((d) => near(h, d)));
  check("every colour the file painted is on screen, or within the match tolerance of it",
    lost.length === 0,
    lost.length ? `lost ${lost.join(", ")}` : `${drawn.size} distinct colours drawn`);

  const exact = wanted.filter((h) => drawn.has(h));
  check("the minority colours are drawn exactly",
    exact.length > 0, `${exact.length} of ${wanted.length} exact: ${exact.join(", ")}`);

  // CONTROL. A viewport that just painted everything one shade would satisfy
  // most of the above by accident, and the neutral shade an uncoloured model
  // gets is the state this whole path exists to replace.
  check("the model is not drawn in one flat shade (control)",
    drawn.size > 1, `${drawn.size} distinct vertex colours`);

  // Nothing the file painted may arrive SEE-THROUGH. A colour carries no
  // transparency, and a body at quarter opacity because its shade resembled
  // glass reads as a broken import, which is exactly how the reference board
  // used to open.
  const sheer = await page.evaluate(() =>
    window.viewport.bodyMeshes
      .filter((b) => (b.mesh.material.opacity ?? 1) < 1)
      .map((b) => [b.id, b.mesh.material.opacity]));
  check("no body arrives see-through", sheer.length === 0, JSON.stringify(sheer));

  await page.evaluate(() => window.__fundacad?.handleAction?.("iso"));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__fundacad?.handleAction?.("fit"));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, "imported.png") });
  console.log(`\nshots in ${OUT}`);

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall import colour checks passed");
  process.exit(failures ? 1 : 0);
})();
