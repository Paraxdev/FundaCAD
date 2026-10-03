// A selection never outlives the model it was made on, in a real browser.
//
//   1. A selected face shows the drag handle and its prompt (CONTROL).
//   2. A new document takes the handle, the prompt and the selection away.
//   3. So does undoing the model back to nothing.
//   4. A selected body is forgotten the same way.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/selection_gone_with_model_e2e.cjs
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
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
  const settle = async () => { await page.waitForTimeout(600); await idle(); await page.waitForTimeout(400); };
  const state = () => page.evaluate(() => ({
    prompt: document.querySelector("#prompt")?.textContent ?? "",
    handle: window.__fundacad.nudge.want !== null,
    faces: window.viewport.getSelectedFaceIds().length,
    bodies: window.viewport.getSelectedBodies().length,
  }));
  const box = () => page.evaluate(async () => {
    window.store.addFeature({ id: "s1", type: "sketch", plane: "XY", entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 20, height: 20 }] });
    window.store.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: 30, operation: "new" });
    window.__fundacad.extrude.lastCommit = null;
    await window.store.rebuildNow();
  });
  const pickFace = () => page.evaluate(() => window.viewport.selectOnlyFace(window.viewport.faceIdNear([10, 0, 15])));
  const gone = (what, s) => {
    check(`${what} takes the handle away`, !s.handle);
    check(`${what} clears the prompt`, !/selected/.test(s.prompt), JSON.stringify(s.prompt));
    check(`${what} leaves nothing selected`, s.faces === 0 && s.bodies === 0, `${s.faces} faces, ${s.bodies} bodies`);
  };

  await box();
  await settle();
  await pickFace();
  await page.waitForTimeout(300);
  const s1 = await state();
  check("CONTROL: a selected face shows the handle", s1.handle && s1.faces === 1);
  check("CONTROL: and its prompt", /1 face selected/.test(s1.prompt), JSON.stringify(s1.prompt));

  await page.evaluate(() => window.store.newDocument());
  await settle();
  gone("a new document", await state());

  await box();
  await settle();
  await pickFace();
  await page.waitForTimeout(300);
  check("CONTROL: the face is selected again", (await state()).handle);
  await page.evaluate(() => { window.store.undo(); window.store.undo(); });
  await settle();
  gone("undoing the model away", await state());

  await page.evaluate(() => { window.store.redo(); window.store.redo(); });
  await settle();
  await page.evaluate(() => window.viewport.setSelectedBodies([window.store.buildState.result.bodies[0].id]));
  await page.waitForTimeout(300);
  check("CONTROL: a body is selected", (await state()).bodies === 1);
  await page.evaluate(() => window.store.newDocument());
  await settle();
  gone("a new document over a selected body", await state());
  const busy = await page.evaluate(() => window.__fundacad.busyWhy());
  check("and no tool is left open on it", !Object.values(busy).some(Boolean), JSON.stringify(busy));

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
