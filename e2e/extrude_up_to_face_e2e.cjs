// An extrude cut up to a face with an offset, in a real browser.
//
//   1. A 40x20x10 box with a 4 mm groove cut from its top up to its bottom face,
//      stopping 2 mm short, so it leaves a 2 mm floor.
//   2. The feature panel shows the end as "Up to face" with the offset row.
//   3. Making the box 16 tall downwards keeps the floor 2 mm: the groove follows
//      the bottom face.
//   4. Changing the offset in the panel deepens the groove.
//
// Usage (from the repo root, with vite + engine running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome.exe> [SC_URL=http://localhost:5173/] node e2e/extrude_up_to_face_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const OUT = path.resolve(process.argv[2] || "extrude_up_to_face_shots");
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
  await page.goto(`${URL}?token=${TOKEN}`);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  const settle = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !window.store.buildState.building, null, { timeout: 60000 });
  };
  const state = () => page.evaluate(() => {
    const r = window.store.buildState.result;
    const b = (r?.bodies ?? [])[0];
    return {
      errors: (r?.errors ?? []).map((e) => e.message),
      volume: b ? window.viewport.bodyProperties([b.id])?.volume ?? null : null,
      bbox: r?.bbox ?? null,
    };
  });

  await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: "s1", type: "sketch", plane: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] }, entities: [{ type: "rectangle", id: "r1", x: 0, y: 0, width: 40, height: 20 }] });
    s.addFeature({ id: "e1", type: "extrude", sketch: "s1", distance: -10, operation: "new" });
    await s.rebuildNow();
    const body = s.buildState.result.bodies[0].id;
    s.addFeature({ id: "s2", type: "sketch", plane: { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] },
      entities: [{ type: "rectangle", id: "r2", x: 0, y: 0, width: 4, height: 30 }] });
    s.addFeature({ id: "g1", type: "extrude", sketch: "s2", distance: -1, operation: "cut", targets: [body],
      endType: "upToFace", upToFace: { kind: "face", by: "tracked", point: [0, 0, 0], normal: [0, 0, -1], body }, endOffset: -2 });
    await s.rebuildNow();
  });
  await settle();
  let st = await state();
  check("the groove builds", st.errors.length === 0, JSON.stringify(st.errors));
  check("it leaves a 2 mm floor", st.volume != null && Math.abs(st.volume - (8000 - 4 * 20 * 8)) < 1, String(st.volume));
  await page.evaluate(() => window.__fundacad.handleAction("iso"));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "01_groove.png") });

  await page.evaluate(() => window.__fundacad.selectFeature("g1"));
  await page.waitForTimeout(500);
  const rows = await page.$$eval(".timeline-props .param-row", (els) => els.map((el) => {
    const sel = el.querySelector("select");
    return { label: el.querySelector("label")?.textContent?.trim() ?? "", value: sel ? sel.options[sel.selectedIndex]?.text ?? "" : null };
  }));
  const endRow = rows.find((r) => r.value === "Up to face");
  check("the panel shows the end as up to face", !!endRow, JSON.stringify(rows));
  check("and an end offset row", rows.some((r) => /offset/i.test(r.label)), JSON.stringify(rows.map((r) => r.label)));
  await page.screenshot({ path: path.join(OUT, "02_panel.png") });

  await page.evaluate(async () => {
    window.store.updateFeature("e1", { distance: -16 });
    await window.store.rebuildNow();
  });
  await settle();
  st = await state();
  check("a taller box still builds", st.errors.length === 0, JSON.stringify(st.errors));
  check("the floor stays 2 mm", st.volume != null && Math.abs(st.volume - (40 * 20 * 16 - 4 * 20 * 14)) < 1, String(st.volume));

  await page.evaluate(async () => {
    window.store.updateFeature("g1", { endOffset: -1 });
    await window.store.rebuildNow();
  });
  await settle();
  st = await state();
  check("a smaller offset deepens the groove", st.volume != null && Math.abs(st.volume - (40 * 20 * 16 - 4 * 20 * 15)) < 1, String(st.volume));
  await page.screenshot({ path: path.join(OUT, "03_taller.png") });

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
