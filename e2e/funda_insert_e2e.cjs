// Inserting one FundaCAD document into another, in a real browser against the
// real geometry engine.
//
//   1. Append: the source is built on its own, written to STEP, read back, and
//      lands as bodies at the end of the history.
//   2. Link: the same, carrying the file and a stamp; after the source changes,
//      an update replaces the geometry in place and the history keeps its length.
//   3. A step renamed in the history keeps its name through a rebuild.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chrome.exe> node e2e/funda_insert_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "funda_insert_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

const source = (size) => JSON.stringify({
  parameters: {},
  features: [
    { id: "f1", type: "box", length: size, width: 20, height: 10 },
    { id: "f2", type: "cylinder", radius: 4, height: 30 },
  ],
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "funda-insert-"));
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
  const settle = () => page.waitForFunction(() => !window.store.buildState.building && !window.store.busy?.active, null, { timeout: 120000 });

  await page.evaluate(async () => {
    window.store.addFeature({ id: "h1", type: "sphere", radius: 6 });
    await window.store.rebuildNow();
  });
  await settle();

  console.log("\n  1. append");
  const appended = await page.evaluate(async ({ text, tempPath }) => {
    const m = await import("/src/io/fundaInsert.ts");
    const res = await m.insertFundaDocument(window.store, window.geometry, { path: "C:/parts/Plate.funda", text }, "append", tempPath);
    await window.store.rebuildNow();
    const f = window.store.document.features.at(-1);
    return { res, type: f.type, name: f.name, link: f.link ?? null, bodies: window.store.buildState.result?.bodies.length ?? 0 };
  }, { text: source(40), tempPath: path.join(tmp, "append.step") });
  await settle();
  check("the insert succeeded", appended.res.ok, JSON.stringify(appended.res));
  check("it is an import step named after the file", appended.type === "import" && appended.name === "Plate", JSON.stringify(appended));
  check("with no link", appended.link === null);
  const bodiesAfterAppend = await page.evaluate(() => window.store.buildState.result?.bodies.length ?? 0);
  check("the host sphere plus the source's two bodies", bodiesAfterAppend === 3, String(bodiesAfterAppend));

  console.log("\n  2. link");
  const linked = await page.evaluate(async ({ text, tempPath }) => {
    const m = await import("/src/io/fundaInsert.ts");
    const res = await m.insertFundaDocument(window.store, window.geometry, { path: "C:/parts/Peg.funda", text }, "link", tempPath);
    await window.store.rebuildNow();
    const f = window.store.document.features.at(-1);
    return { res, link: f.link ?? null };
  }, { text: source(10), tempPath: path.join(tmp, "link.step") });
  await settle();
  check("linked with a path and a stamp", linked.res.ok && linked.link?.path === "C:/parts/Peg.funda" && !!linked.link?.stamp, JSON.stringify(linked.link));
  const widthOf = () => page.evaluate(() => {
    const bodies = window.store.buildState.result.bodies;
    const ids = bodies.slice(-2).map((b) => b.id);
    const box = window.viewport.bodiesBox(ids);
    return box ? +(box.max.x - box.min.x).toFixed(2) : null;
  });
  const before = await widthOf();
  const updated = await page.evaluate(async ({ id, text, tempPath }) => {
    const m = await import("/src/io/fundaInsert.ts");
    const n = window.store.document.features.length;
    const res = await m.updateFundaLink(window.store, window.geometry, id, { path: "C:/parts/Peg.funda", text }, tempPath);
    await window.store.rebuildNow();
    return { res, sameLength: window.store.document.features.length === n };
  }, { id: linked.res.id, text: source(60), tempPath: path.join(tmp, "link2.step") });
  await settle();
  await page.waitForTimeout(800);
  const after = await widthOf();
  check("the update replaced the geometry in place", updated.res.ok && updated.sameLength, JSON.stringify(updated));
  check("and the linked body is now the changed size", after !== null && before !== null && after > before, JSON.stringify({ before, after }));

  console.log("\n  3. rename");
  await page.evaluate(async () => {
    window.store.renameFeature("h1", "Ball");
    await window.store.rebuildNow();
  });
  await settle();
  const renamed = await page.evaluate(() => ({
    name: window.store.document.features.find((f) => f.id === "h1").name,
    chip: [...document.querySelectorAll("#timeline .t-name")].map((e) => e.textContent.trim()),
    errors: window.store.buildState.result?.featureErrors ?? [],
  }));
  check("the step carries its new name", renamed.name === "Ball");
  check("and the history shows it", renamed.chip.includes("Ball"), JSON.stringify(renamed.chip));
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, "inserted.png") });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n  ${failures} FAILED\n` : "\n  all passed\n");
  await browser.close();
  process.exit(failures ? 1 : 0);
})();
