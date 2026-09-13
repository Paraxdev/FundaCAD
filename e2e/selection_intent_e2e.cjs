// End-to-end check of the body-then-face click, folder selection in the item
// tree, its indentation, and the rotate dial, on a real import of asm_nested.step.
//
// Usage (from the repo root, with vite on 5173 + sidecar on 8765):
//   SC_TOKEN=<token> SC_CHROME=<browser> node e2e/selection_intent_e2e.cjs
const { chromium } = require("playwright-core");
const path = require("path");
const os = require("os");

const TOKEN = process.env.SC_TOKEN || "";
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
const FIXTURE = path.resolve(__dirname, "../sidecar/fixtures/asm_nested.step");
const OUT = process.env.SC_OUT || path.join(os.tmpdir(), "selection_intent_shots");
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  require("fs").mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.SC_CHROME || "/usr/bin/chromium",
    args: ["--use-angle=swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
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
  await page.waitForTimeout(3500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(400); }
  await page.waitForFunction(() => !!window.store && !!window.viewport && !!window.geometry, null, { timeout: 60000 });

  const imported = await page.evaluate(async (file) => {
    const res = await window.geometry.importGeometry(file, "step");
    if (!res.ok) return { ok: false, message: res.message };
    window.store.addFeature({
      id: window.store.nextId(), type: "import", format: "step",
      name: res.name, geom: res.geom, source: file, solid: res.solid,
      ...(res.nodes !== undefined ? { nodes: res.nodes } : {}),
      ...(res.parts !== undefined ? { parts: res.parts } : {}),
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (!window.store.buildState.building && window.store.buildState.result) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: true, bodies: (window.store.buildState.result?.bodies ?? []).length };
  }, FIXTURE);
  if (!imported.ok) { console.error("import failed:", imported.message); process.exit(1); }
  console.log(`imported ${imported.bodies} bodies`);
  await page.waitForTimeout(1500);

  // --- the tree ------------------------------------------------------------
  const openAll = async () => {
    for (let i = 0; i < 20; i++) {
      const clicked = await page.evaluate(() => {
        const el = [...document.querySelectorAll("#browser .tree-folder")].find((f) => f.getAttribute("aria-expanded") === "false");
        if (!el) return false;
        el.querySelector(".tree-caret").click();
        return true;
      });
      if (!clicked) break;
      await page.waitForTimeout(150);
    }
  };
  await openAll();
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#browser .tree-folder, #browser .feature-row")].map((el) => ({
      folder: el.classList.contains("tree-folder"),
      text: el.querySelector(".tree-label")?.textContent ?? "",
      caret: el.querySelector(".tree-caret")?.getBoundingClientRect().left ?? null,
      icon: el.querySelector(".feature-icon")?.getBoundingClientRect().left ?? null,
    })));
  for (const r of rows) console.log(`   ${r.folder ? "+" : "."} ${r.text.padEnd(24)} caret ${r.caret?.toFixed(0) ?? "-"} icon ${r.icon?.toFixed(0)}`);
  const browserBox = await page.$("#browser");
  await browserBox.screenshot({ path: path.join(OUT, "1-tree.png") });

  const robot = rows.find((r) => r.text === "Robot");
  const bodiesHead = rows.find((r) => r.text === "Bodies");
  check("an assembly under Bodies is indented past the Bodies head", !!robot && !!bodiesHead && robot.caret > bodiesHead.caret,
    robot && bodiesHead ? `${bodiesHead.caret} -> ${robot.caret}` : "");

  const folderPick = await page.evaluate(async () => {
    const head = [...document.querySelectorAll("#browser .tree-folder")].find((f) => f.querySelector(".tree-label")?.textContent === "Robot");
    head.querySelector(".tree-label").click();
    await new Promise((r) => setTimeout(r, 200));
    return { selected: window.viewport.getSelectedBodies().length, all: window.store.buildState.result.bodies.length,
      lit: head.classList.contains("selected") || document.querySelector("#browser .tree-folder.selected") !== null };
  });
  check("clicking the root folder selects every body under it", folderPick.selected === folderPick.all, `${folderPick.selected}/${folderPick.all}`);
  check("the folder reads as selected", folderPick.lit);

  // --- body, then face -------------------------------------------------------
  await page.evaluate(() => { window.__fundacad.move.cancel(); window.viewport.setSelectedBodies([]); window.viewport.fitView(); });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  const target = await page.evaluate(() => {
    const r = window.viewport.domElement.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let rad = 0; rad < 300; rad += 12) {
      for (let a = 0; a < 16; a++) {
        const x = cx + Math.cos(a * 0.39) * rad, y = cy + Math.sin(a * 0.39) * rad;
        const id = window.viewport.bodyIdAt(x, y);
        if (id) return { x, y, id };
      }
    }
    return null;
  });
  check("found a body on screen", !!target);
  if (target) {
    const spot = await page.evaluate(() => {
      const r = window.viewport.domElement.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      window.viewport.setSelectedBodies([]);
      window.__fundacad.move.cancel();
      for (let rad = 60; rad < 400; rad += 10) {
        for (let a = 0; a < 24; a++) {
          const x = cx + Math.cos(a * 0.26) * rad, y = cy + Math.sin(a * 0.26) * rad;
          const id = window.viewport.bodyIdAt(x, y);
          if (id && window.viewport.pickEntity(x, y)?.kind === "face") return { x, y, id };
        }
      }
      return null;
    });
    await page.waitForTimeout(300);
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(400);
    const first = await page.evaluate(() => ({
      mode: window.viewport.selecting, bodies: window.viewport.getSelectedBodies(), faces: window.viewport.getSelectedFaceIds().length,
      move: window.__fundacad.move.active,
    }));
    check("the first click takes the body", first.mode === "bodies" && first.bodies.length === 1 && first.bodies[0] === spot.id,
      JSON.stringify(first));
    await page.screenshot({ path: path.join(OUT, "2-body.png") });

    // aim at a spot on the same body clear of the gizmo
    const again = await page.evaluate((id) => {
      const r = window.viewport.domElement.getBoundingClientRect();
      for (let x = r.left + 20; x < r.right - 20; x += 14) {
        for (let y = r.top + 20; y < r.bottom - 20; y += 14) {
          if (window.viewport.bodyIdAt(x, y) !== id) continue;
          if (window.__fundacad.move.hitHandle?.(x, y)) continue;
          return { x, y };
        }
      }
      return null;
    }, spot.id);
    await page.mouse.click(again.x, again.y);
    await page.waitForTimeout(400);
    const second = await page.evaluate(() => ({
      mode: window.viewport.selecting, bodies: window.viewport.getSelectedBodies().length,
      faces: window.viewport.getSelectedFaceIds().length, edges: window.viewport.selectedEdgeLines().length,
    }));
    check("a click on the selected body takes a face or edge", second.mode === "faces" && second.bodies === 0 && second.faces + second.edges > 0,
      JSON.stringify(second));
    await page.screenshot({ path: path.join(OUT, "3-face.png") });

    // --- hover intent ----------------------------------------------------------
    const reset = async () => {
      await page.keyboard.press("Escape");
      await page.evaluate(() => { window.__fundacad.move.cancel(); window.viewport.setSelectedBodies([]); window.viewport.clearSelection?.(); });
      await page.mouse.move(700, 880);
      await page.waitForTimeout(300);
    };
    const glows = () => page.evaluate(() => {
      let n = 0;
      window.viewport.scene.modelGroup.traverse((o) => { if (o.name === "selection-glow") n++; });
      return n;
    });
    await reset();
    await page.mouse.move(spot.x - 2, spot.y);
    await page.mouse.move(spot.x, spot.y);
    await page.waitForTimeout(150);
    const arrived = await page.evaluate(() => ({ body: window.viewport.highlighter.hoveredBody, faces: window.viewport.highlighter.hoveredFaces.length }));
    check("arriving on a body lights the body", arrived.body === spot.id && arrived.faces === 0, JSON.stringify(arrived));
    await page.waitForTimeout(1100);
    const dwelt = await page.evaluate(() => ({ body: window.viewport.highlighter.hoveredBody, faces: window.viewport.highlighter.hoveredFaces.length }));
    check("staying on it lights the face instead", dwelt.body === null && dwelt.faces > 0, JSON.stringify(dwelt));
    await page.screenshot({ path: path.join(OUT, "5-dwell.png") });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
    const took = await page.evaluate(() => ({ mode: window.viewport.selecting, faces: window.viewport.getSelectedFaceIds().length, bodies: window.viewport.getSelectedBodies().length }));
    check("a click then takes the lit face", took.mode === "faces" && took.faces > 0 && took.bodies === 0, JSON.stringify(took));

    await reset();
    const edgeSpot = await page.evaluate(() => {
      const r = window.viewport.domElement.getBoundingClientRect();
      for (let x = r.left + 300; x < r.right - 60; x += 2) {
        for (let y = r.top + 60; y < r.bottom - 60; y += 2) {
          if (document.elementFromPoint(x, y) !== window.viewport.domElement) continue;
          const hit = window.viewport.pickEntity(x, y);
          if (hit?.kind !== "edge" || !hit.edge.body) continue;
          if (window.viewport.pickableEdgeCandidates(x, y, r).length > 1) continue;
          return { x, y, body: hit.edge.body };
        }
      }
      return null;
    });
    check("found an edge on screen", !!edgeSpot);
    if (edgeSpot) {
      await page.mouse.click(edgeSpot.x, edgeSpot.y);
      await page.waitForTimeout(300);
      const edge = await page.evaluate(() => ({ edges: window.viewport.selectedEdgeLines().length, bodies: window.viewport.getSelectedBodies().length,
        menu: !!document.querySelector(".context-menu") }));
      check("a click right on an edge takes the edge, not the body", edge.edges > 0 && edge.bodies === 0, JSON.stringify(edge));
    }

    await reset();
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.viewport.setModel(window.store.buildState.result); window.viewport.setModel(window.store.buildState.result); });
    await page.waitForTimeout(300);
    const after = await glows();
    const sel = await page.evaluate(() => window.viewport.getSelectedBodies().length);
    check("a rebuild leaves one glow per selected body, none stuck", after === sel, `${after} glows, ${sel} selected`);
    await reset();
    await page.evaluate(() => window.viewport.setModel(window.store.buildState.result));
    await page.waitForTimeout(300);
    check("nothing selected leaves no glow after a rebuild", (await glows()) === 0);

    // --- the rotate dial -----------------------------------------------------
    await page.evaluate(() => { window.viewport.clearSelection?.(); });
    await page.mouse.click(10, 450);
    await page.waitForTimeout(200);
    await page.mouse.click(spot.x, spot.y);
    await page.waitForTimeout(500);
    const ring = await page.evaluate(() => {
      const m = window.__fundacad.move;
      const r = window.viewport.domElement.getBoundingClientRect();
      for (let x = r.left; x < r.right; x += 3) {
        for (let y = r.top; y < r.bottom; y += 3) {
          const h = m.hitHandle(x, y);
          if (h?.kind === "ring") return { x, y, axis: h.index };
        }
      }
      return null;
    });
    check("found a ring on the gizmo", !!ring);
    if (ring) {
      await page.mouse.move(ring.x, ring.y);
      await page.mouse.down();
      const gpos = await page.evaluate(() => window.viewport.projectToScreen(window.__fundacad.move.gizmo.position));
      for (let i = 1; i <= 24; i++) {
        const a = Math.atan2(ring.y - gpos.y, ring.x - gpos.x) + (i / 24) * 1.4 * Math.PI;
        const rr = Math.hypot(ring.y - gpos.y, ring.x - gpos.x);
        await page.mouse.move(gpos.x + Math.cos(a) * rr, gpos.y + Math.sin(a) * rr);
        await page.waitForTimeout(20);
      }
      await page.waitForTimeout(200);
      const dial = await page.evaluate(() => ({
        label: document.querySelector(".rotate-dial-label")?.textContent ?? null,
        deg: window.__fundacad.move.ringDeg,
      }));
      await page.screenshot({ path: path.join(OUT, "4-dial.png") });
      check("the dial shows the angle while turning", !!dial.label && dial.label === `${Math.round(dial.deg)}°`, JSON.stringify(dial));
      check("the turn is a whole number of 15 degree steps", Math.abs(dial.deg % 15) < 1e-9, `${dial.deg}`);
      check("one drag can pass half a turn", Math.abs(dial.deg) > 180, `${dial.deg}`);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await page.waitForTimeout(200);
      const gone = await page.evaluate(() => document.querySelector(".rotate-dial-label") === null);
      check("the dial goes away with the drag", gone);
    }
  }

  console.log(`\nshots in ${OUT}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
})();
