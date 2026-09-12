// Showing and hiding many rows at once in the Browser, with a real mouse.
//
// The component test (tests/components/shell/BrowserPane.spec.ts) dispatches the
// events a paint drag is made of. What only a real browser can answer:
//
//   1. Does a FAST mouse drag actually skip rows? It should, the browser reports
//      the pointer about once a frame, and every skipped row must still be painted.
//   2. Does a press on a body row's eye stay a paint, rather than the row's own
//      HTML5 drag picking the body up?
//   3. Do the real context menu and its Visibility submenu act on a Shift run?
//   4. Does a curved body reach the viewport carrying surface normals?
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<sidecar token> SC_CHROME=<chromium or brave> node e2e/visibility_paint_e2e.cjs <doc.funda> [outDir]
// The document needs a few dozen sketches and several bodies; any real part does.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const DOC = process.argv[2];
const OUT = path.resolve(process.argv[3] || "visibility_paint_shots");
if (!TOKEN || !DOC) { console.error("set SC_TOKEN and pass a .funda"); process.exit(1); }
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXE, args: ["--use-angle=swiftshader", "--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
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
  await page.waitForFunction(() => !!window.store, null, { timeout: 60000 });

  const json = fs.readFileSync(DOC, "utf8");
  const bodies = await page.evaluate(async (text) => {
    window.store.load(text);
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      const b = window.store.buildState;
      if (!b.building && b.result?.bodies?.length) return b.result.bodies.map((x) => ({ id: x.id, name: window.store.bodyName(x.id) ?? x.name }));
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }, json);
  check("document built", Array.isArray(bodies) && bodies.length > 1, bodies && `${bodies.length} bodies`);
  await page.waitForTimeout(800);

  // --- helpers over the drawn panel -----------------------------------------
  const rowOf = `(label) => [...document.querySelectorAll("#browser .feature-row, #browser .tree-folder")]
      .find((r) => r.querySelector(".tree-label")?.textContent.trim() === label)`;
  const eyeAt = (label, block = "nearest") => page.evaluate(({ label, block, rowOf }) => {
    const row = eval(rowOf)(label);
    if (!row) return null;
    row.scrollIntoView({ block });
    const b = row.querySelector(".tree-eye").getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, { label, block, rowOf });
  const labelAt = (label) => page.evaluate(({ label, rowOf }) => {
    const b = eval(rowOf)(label).querySelector(".tree-label").getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, { label, rowOf });
  const eyes = (labels) => page.evaluate(({ labels, rowOf }) =>
    labels.map((l) => eval(rowOf)(l)?.querySelector(".tree-eye svg")?.getAttribute("data-icon")), { labels, rowOf });
  const sketchLabels = await page.evaluate(() =>
    window.store.document.features.filter((f) => f.type === "sketch").map((f, i) => f.name || `Sketch${i + 1}`));
  check("enough sketches to drag across", sketchLabels.length >= 20, `${sketchLabels.length}`);

  // --- 1. a fast drag paints every sketch it skipped --------------------------
  const run = sketchLabels.slice(0, 12);
  const before = await eyes([...run, sketchLabels[12]]);
  const top = await eyeAt(run[0], "start");
  const bottom = await eyeAt(run[11]);
  await page.mouse.move(top.x, top.y);
  await page.mouse.down();
  await page.mouse.move(bottom.x, bottom.y, { steps: 1 }); // one jump: rows 2 to 11 are never entered
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await eyes([...run, sketchLabels[12]]);
  const target = before[0] === "visible" ? "hidden" : "visible";
  check("a one-jump drag painted all 12 sketches", after.slice(0, 12).every((s) => s === target), after.slice(0, 12).join(","));
  check("the row past the drag is untouched", after[12] === before[12], `${before[12]} -> ${after[12]}`);

  // show every sketch by painting from the first eye to the last, and look
  await (async () => {
    const all = await eyes(sketchLabels);
    if (all[0] === "visible") { // make the press SHOW: hide the first one alone first
      const e = await eyeAt(sketchLabels[0], "start");
      await page.mouse.click(e.x, e.y);
      await page.waitForTimeout(200);
    }
    const a = await eyeAt(sketchLabels[0], "start");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (const l of sketchLabels.slice(1)) {
      const p = await eyeAt(l);
      await page.mouse.move(p.x, p.y, { steps: 2 });
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
  })();
  check("painting down the whole list shows every sketch",
    (await eyes(sketchLabels)).every((s) => s === "visible"));
  await page.screenshot({ path: `${OUT}/1-all-sketches-shown.png` });

  // --- 2. Alt-click shows only one, and a second Alt-click restores ------------
  const soloLabel = sketchLabels[sketchLabels.length - 1];
  const beforeSolo = await eyes(sketchLabels);
  let e = await eyeAt(soloLabel);
  await page.keyboard.down("Alt");
  await page.mouse.click(e.x, e.y);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(400);
  const solo = await eyes(sketchLabels);
  check("Alt-click shows only that sketch",
    solo.every((s, i) => (sketchLabels[i] === soloLabel ? s === "visible" : s === "hidden")));
  await page.screenshot({ path: `${OUT}/2-solo.png` });
  e = await eyeAt(soloLabel);
  await page.keyboard.down("Alt");
  await page.mouse.click(e.x, e.y);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(400);
  check("a second Alt-click puts the list back", JSON.stringify(await eyes(sketchLabels)) === JSON.stringify(beforeSolo));

  // --- 3. a Shift run, then the real Visibility submenu -----------------------
  const [s2, s5] = [sketchLabels[1], sketchLabels[4]];
  await eyeAt(s2, "center");
  let p = await labelAt(s2);
  await page.mouse.click(p.x, p.y);
  p = await labelAt(s5);
  await page.keyboard.down("Shift");
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up("Shift");
  await page.waitForTimeout(300);
  const picked = await page.evaluate(({ labels, rowOf }) =>
    labels.filter((l) => eval(rowOf)(l)?.classList.contains("selected")), { labels: sketchLabels, rowOf });
  check("Shift-click selected the run of 4", JSON.stringify(picked) === JSON.stringify(sketchLabels.slice(1, 5)), picked.join(","));
  const textSel = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  check("and did not also text-select the labels in between", textSel === "", JSON.stringify(textSel));
  p = await labelAt(sketchLabels[2]);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.waitForTimeout(300);
  const vis = page.locator(".context-menu .ctx-item", { hasText: "Visibility" }).first();
  await vis.hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/3-visibility-menu.png` });
  await page.locator(".context-menu.submenu .ctx-item", { hasText: "Hide these 4" }).click();
  await page.waitForTimeout(400);
  const hid = await eyes(sketchLabels.slice(0, 6));
  check("Hide these 4 hid exactly the run", hid.slice(1, 5).every((s) => s === "hidden") && hid[0] === "visible" && hid[5] === "visible", hid.join(","));

  // --- 4. painting body eyes never picks a body up ----------------------------
  await page.evaluate(() => {
    window.__drags = [];
    window.addEventListener("dragstart", (ev) => window.__drags.push(ev.defaultPrevented));
  });
  const bodyLabels = bodies.map((b) => b.name);
  const first = await eyeAt(bodyLabels[0], "center");
  const last = await eyeAt(bodyLabels[bodyLabels.length - 1]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(first.x, first.y + 12, { steps: 4 }); // enough movement to start an HTML5 drag
  await page.mouse.move(last.x, last.y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const bodyVis = await page.evaluate((ids) => ids.map((id) => window.store.isBodyVisible(id)), bodies.map((b) => b.id));
  const drags = await page.evaluate(() => window.__drags);
  check("a drag across the body eyes hid every body", bodyVis.every((v) => v === false), bodyVis.join(","));
  check("and no body was picked up by the row's own drag", drags.every((prevented) => prevented), JSON.stringify(drags));

  // --- 5. the housing, alone, arrives with surface normals --------------------
  // the curved body with the most faces, leaving out an imported mesh, whose
  // thousands of facets are faces too
  const housing = await page.evaluate(() => {
    const r = window.store.buildState.result;
    return [...r.bodies].filter((b) => !/reference|import/i.test(b.name))
      .sort((a, b) => b.faceCount - a.faceCount)[0];
  });
  e = await eyeAt(bodies.find((b) => b.id === housing.id).name, "center");
  await page.keyboard.down("Alt");
  await page.mouse.click(e.x, e.y);
  await page.keyboard.up("Alt");
  await page.waitForTimeout(1500);
  const normals = await page.evaluate(() => {
    const m = window.store.buildState.result.mesh;
    if (!m.normals) return { present: false };
    let nonZero = 0;
    for (let i = 0; i < m.normals.length; i += 3) if (m.normals[i] || m.normals[i + 1] || m.normals[i + 2]) nonZero++;
    return { present: true, length: m.normals.length, positions: m.positions.length, nonZero, verts: m.positions.length / 3 };
  });
  check("the mesh carries normals for every vertex", normals.present && normals.length === normals.positions && normals.nonZero === normals.verts,
    JSON.stringify(normals));
  // a clean look at the housing: no sketch selected, no sketches drawn, framed
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    for (const f of window.store.document.features) if (f.type === "sketch") window.store.setSketchVisibility(f.id, false);
    window.overlay?.update?.(window.store.document);
  });
  for (const view of ["right", "iso"]) {
    await page.evaluate((v) => window.viewport.setStandardView(v), view);
    await page.locator(".view-bar button, button", { hasText: /^Fit$/ }).first().click().catch(() => {});
    await page.waitForTimeout(1200);
    await page.locator("canvas").first().screenshot({ path: `${OUT}/5-housing-${view}.png` });
  }

  await browser.close();
  console.log(failures ? `FAILED (${failures})` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})();
