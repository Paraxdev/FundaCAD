// An imported assembly's own colours become materials, and the parts wear them.
//
// This is end to end on purpose, through the real sidecar and the real store:
// the colours are read by the Python XCAF reader, travel in the import
// manifest, are matched against the document's library in TypeScript, and land
// on bodies whose ids do not exist until the rebuild has run. Every one of those
// hand-offs is somewhere the colour used to be dropped, and until this feature
// it was dropped at the last one, so a fully coloured assembly opened as a run
// of identical grey bodies.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> node e2e/import_colors_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "import_color_shots");
const FIXTURE = path.resolve(__dirname, "../sidecar/fixtures/asm_colors.step");
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
  await page.waitForFunction(() => !!window.store && !!window.geometry, null, { timeout: 60000 });

  const before = await page.evaluate(() => window.store.materialLibrary.length);

  // Exactly what io/files.ts importPath does, minus the native file picker,
  // INCLUDING the colour adoption that is the thing under test.
  const out = await page.evaluate(async (file) => {
    const res = await window.geometry.importGeometry(file, "step");
    if (!res.ok) return { error: res.message };
    const id = window.store.nextId();
    window.store.addFeature({
      id, type: "import", format: "step", name: res.name, geom: res.geom,
      source: file, solid: res.solid,
      ...(res.color !== undefined ? { color: res.color } : {}),
      ...(res.nodes !== undefined ? { nodes: res.nodes } : {}),
      ...(res.parts !== undefined ? { parts: res.parts } : {}),
    });
    const { materialsForColors, nodeColors } = await import("/src/document/materials.ts");
    const perNode = nodeColors(res.nodes);
    const { add, byColor } = materialsForColors(
      perNode.filter(Boolean).map((c) => ({ color: c })),
      window.store.materialLibrary,
    );
    if (add.length) window.store.importMaterials(add);
    // The one await the whole flow turns on: addFeature has a rebuild in
    // flight, so this is the "already rebuilding" branch of rebuildNow, which
    // used to return before the result was published and left every assignment
    // below writing to an empty body list.
    await window.store.rebuildNow();
    const byMaterial = new Map();
    for (const b of window.store.buildState.result?.bodies ?? []) {
      const slash = b.nodeRef ? b.nodeRef.lastIndexOf("/") : -1;
      if (slash <= 0 || b.nodeRef.slice(0, slash) !== id) continue;
      const m = byColor.get(perNode[Number(b.nodeRef.slice(slash + 1))]);
      if (!m) continue;
      byMaterial.set(m, [...(byMaterial.get(m) ?? []), b.id]);
    }
    for (const [m, ids] of byMaterial) window.store.setBodiesMaterial(ids, m);
    await new Promise((r) => setTimeout(r, 500));
    return {
      nodes: res.nodes,
      perNode,
      added: add.map((m) => `${m.name} ${m.color}`),
      worn: (window.store.buildState.result?.bodies ?? []).map((b) => ({
        name: window.store.bodyName(b.id) ?? b.name,
        material: window.store.bodyMaterialOf(b.id)?.name ?? null,
        color: window.store.bodyMaterialOf(b.id)?.color ?? null,
      })),
      painted: Object.entries(window.store.materialPaint()),
    };
  }, FIXTURE);

  if (out.error) { console.error("import failed:", out.error); process.exit(1); }
  console.log("\n  the file said:", JSON.stringify(out.perNode));
  console.log("  materials made:", JSON.stringify(out.added));
  console.log("  bodies now wear:", JSON.stringify(out.worn, null, 2), "\n");

  const after = await page.evaluate(() => window.store.materialLibrary.length);
  check("three materials were made, one per colour in the file",
    after - before === 3, `library ${before} -> ${after}`);
  check("each of them is named for its colour",
    out.added.length === 3 && out.added.every((n) => /^Imported (red|green|yellow) #/.test(n)),
    JSON.stringify(out.added));

  const worn = Object.fromEntries(out.worn.map((b) => [b.name, b.color]));
  check("the red part wears the red material", worn["Red Part"] === "#e51919", JSON.stringify(worn));
  check("the green part wears the green material", worn["Green Part"] === "#19e519");
  check("the yellow part wears the yellow material", worn["Yellow Part"] === "#e5e519");
  check("the part the file left uncoloured is left alone",
    worn["Uncoloured Part"] === null, String(worn["Uncoloured Part"]));
  check("and those colours actually reach the renderer",
    out.painted.length === 3, JSON.stringify(out.painted));

  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(900);
  await page.locator("#viewport").screenshot({ path: `${OUT}/imported.png` });
  await page.locator("#browser").screenshot({ path: `${OUT}/browser.png` });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
