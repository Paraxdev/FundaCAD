// Overlays in the Display popover: each kind switched off through the UI, then
// Clean view by its key. For each state: a screenshot, the draw calls of one
// forced frame, how often the grid and the triad were updated, and whether an
// edge is still picked and a body still selected.
// node e2e/overlays_e2e.cjs <outDir> [enginePort] [token] [vitePort]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const OUT = process.argv[2] || "overlays_out";
const PORT = process.argv[3] || "8791";
const TOKEN = process.argv[4] || "ovtok";
const VITE = process.argv[5] || "5191";
const KINDS = ["edges", "highlight", "grid", "origin", "sketches", "sketchLabels", "handles", "stress", "section"];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  const res = { states: {}, errors: [] };
  let failed = 0;
  const check = (name, ok, detail) => {
    res[name] = { ok, detail };
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} ${JSON.stringify(detail)}`);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.on("pageerror", (e) => res.errors.push(e.message));
    await page.addInitScript(([port]) => {
      try { localStorage.removeItem("fundacad.render"); } catch { /* fresh profile */ }
      const N = window.WebSocket;
      window.WebSocket = class extends N {
        constructor(u, p) { super(String(u).replace("127.0.0.1:8765", "127.0.0.1:" + port), p); }
      };
    }, [PORT]);
    await page.goto(`http://localhost:${VITE}/?token=${TOKEN}`);
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 90000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) { await modal.click(); await page.waitForTimeout(300); }

    await page.evaluate(async () => {
      const s = window.store;
      const box = (l, dx, b) => {
        s.addFeature({ id: s.nextId(), type: "box", length: l, width: l, height: l });
        s.addFeature({ id: s.nextId(), type: "move", bodies: [b], dx, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 });
      };
      box(40, 0, "body1");
      box(30, 50, "body2");
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 2) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await page.evaluate(() => window.__fundacad.handleAction("iso"));
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(2500);

    const frame = () => page.evaluate(async () => {
      const vp = window.viewport, r = vp.scene.renderer;
      const g = vp.scene.grid, t = vp.scene.triad;
      let gu = 0, tu = 0;
      const gOrig = g.update, tOrig = t.update;
      g.update = function (...a) { gu++; return gOrig.apply(g, a); };
      t.update = function (...a) { tu++; return tOrig.apply(t, a); };
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      r.info.autoReset = false; r.info.reset();
      gu = 0; tu = 0;
      vp.requestRender();
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(ok))));
      const out = { calls: r.info.render.calls, triangles: r.info.render.triangles, gridUpdates: gu, triadUpdates: tu, mask: vp.rig.active.layers.mask };
      r.info.autoReset = true;
      g.update = gOrig; t.update = tOrig;
      return out;
    });

    // The middle of the first edge on screen, and a pick there.
    const edgePick = () => page.evaluate(() => {
      const vp = window.viewport, cam = vp.rig.active;
      const rect = vp.domElement.getBoundingClientRect();
      const ref = vp.visibleEdgeLines()[0];
      if (!ref) return { edge: null, picked: null };
      const a = ref.points[0], b = ref.points[ref.points.length - 1];
      const m = new cam.position.constructor((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2).project(cam);
      const x = rect.left + (m.x + 1) / 2 * rect.width, y = rect.top + (1 - m.y) / 2 * rect.height;
      const hit = vp.pickEdgeAt(x, y);
      return { edge: ref.id, picked: hit?.edge?.id ?? hit?.id ?? null };
    });

    // A real click on body1's middle, then what the viewport says is selected.
    const clickSelect = async () => {
      const at = await page.evaluate(() => {
        const vp = window.viewport, cam = vp.rig.active;
        const rect = vp.domElement.getBoundingClientRect();
        const m = new cam.position.constructor(0, 0, 0).project(cam);
        return { x: rect.left + (m.x + 1) / 2 * rect.width, y: rect.top + (1 - m.y) / 2 * rect.height };
      });
      await page.keyboard.press("Escape");
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(400);
      const sel = await page.evaluate(() => {
        const vp = window.viewport;
        return { bodies: vp.getSelectedBodies?.() ?? [], faces: vp.highlighter?.getSelectedFaces?.() ?? [] };
      });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      return sel;
    };

    const openDisplay = async () => {
      if (await page.$("[data-overlay='all']")) return;
      await page.click("[title='Display']");
      await page.waitForSelector("[data-overlay='all']", { timeout: 5000 });
    };
    const closeDisplay = async () => {
      if (!(await page.$("[data-overlay='all']"))) return;
      await page.click("[title='Display']");
      await page.waitForTimeout(200);
    };
    const flip = async (kind) => {
      await openDisplay();
      await page.click(`[data-overlay='${kind}'] .ft-switch`);
      await page.waitForTimeout(150);
      await closeDisplay();
      await page.waitForTimeout(250);
    };

    const record = async (name) => {
      const st = { frame: await frame() };
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      res.states[name] = st;
      return st;
    };

    const base = await record("00_all_on");
    res.states["00_all_on"].pick = await edgePick();
    await openDisplay();
    await page.screenshot({ path: path.join(OUT, "00_display_popover.png") });
    await closeDisplay();

    for (const k of KINDS) {
      await flip(k);
      const st = await record(`off_${k}`);
      st.prefs = await page.evaluate(() => JSON.parse(localStorage.getItem("fundacad.render") || "{}").overlaysModel);
      if (k === "edges") {
        st.pick = await edgePick();
        st.select = await clickSelect();
      }
      if (k === "highlight") st.select = await clickSelect();
      await flip(k);
    }
    const restored = await record("01_all_on_again");

    await page.mouse.move(5, 400);
    await page.keyboard.press("Shift+V");
    await page.waitForTimeout(400);
    const clean = await record("02_clean_view");
    clean.pick = await edgePick();
    clean.select = await clickSelect();

    // The gizmo a body selection raises by itself hides in Clean view; Move
    // asked for over it, like any running tool, keeps its gizmo.
    const ambient = await page.evaluate(async () => {
      const vp = window.viewport, cam = vp.rig.active;
      const rect = vp.domElement.getBoundingClientRect();
      const m = new cam.position.constructor(0, 0, 0).project(cam);
      vp.selectBodyAt(rect.left + (m.x + 1) / 2 * rect.width, rect.top + (1 - m.y) / 2 * rect.height, false);
      await new Promise((r) => setTimeout(r, 500));
      // Every tool keeps its own value box; the Move one is the box on display.
      const row = [...document.querySelectorAll(".dim-input")].find((el) => el.style.display === "flex");
      return { handlesDrawn: vp.overlayDrawn("handles"), rowHidden: !!row && row.style.visibility === "hidden" };
    });
    await page.evaluate(async () => {
      window.__fundacad.handleAction("move");
      await new Promise((r) => setTimeout(r, 500));
    });
    const tool = await record("03_clean_view_move_tool");
    tool.handlesDrawn = await page.evaluate(() => window.viewport.overlayDrawn("handles"));
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // A plane pick draws and picks the construction planes in Clean view.
    await page.evaluate(() => window.__fundacad.handleAction("sketch"));
    await page.waitForTimeout(500);
    const planes = await page.evaluate(() => {
      const vp = window.viewport, cam = vp.rig.active;
      const rect = vp.domElement.getBoundingClientRect();
      const p = vp.scene.planes.XY.getWorldPosition(new cam.position.constructor()).project(cam);
      const x = rect.left + (p.x + 1) / 2 * rect.width, y = rect.top + (1 - p.y) / 2 * rect.height;
      return { drawn: vp.overlayDrawn("origin"), plane: vp.pickPlane(x, y), mask: cam.layers.mask };
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const afterPick = await page.evaluate(() => window.viewport.overlayDrawn("origin"));

    await page.keyboard.press("Shift+V");
    await page.waitForTimeout(400);
    const back = await record("04_clean_view_off");

    // A saved picture leaves the overlays out and gives the view its mask back.
    const pic = await page.evaluate(() => {
      const vp = window.viewport;
      const before = vp.rig.active.layers.mask;
      const url = vp.renderStill(1);
      return { before, after: vp.rig.active.layers.mask, bytes: url.length };
    });

    const s = res.states;
    check("grid off drops draw calls and grid updates", s.off_grid.frame.calls < base.frame.calls && s.off_grid.frame.gridUpdates === 0 && base.frame.gridUpdates > 0,
      { base: base.frame, off: s.off_grid.frame });
    check("origin off drops draw calls and triad updates", s.off_origin.frame.calls < base.frame.calls && s.off_origin.frame.triadUpdates === 0 && base.frame.triadUpdates > 0,
      { base: base.frame, off: s.off_origin.frame });
    check("edges off drops draw calls", s.off_edges.frame.calls < base.frame.calls, { base: base.frame.calls, off: s.off_edges.frame.calls });
    check("edges off still picks the edge", !!s.off_edges.pick.picked && s.off_edges.pick.picked === s["00_all_on"].pick.picked,
      { on: s["00_all_on"].pick, off: s.off_edges.pick });
    check("edges off still selects by a click", s.off_edges.select.bodies.length + s.off_edges.select.faces.length > 0, s.off_edges.select);
    check("highlight off still selects by a click", s.off_highlight.select.bodies.length + s.off_highlight.select.faces.length > 0, s.off_highlight.select);
    check("every switch saved per workspace", KINDS.every((k) => s[`off_${k}`].prefs?.kinds?.[k] === false), KINDS.map((k) => s[`off_${k}`].prefs?.kinds?.[k]));
    check("all back on draws what it drew", restored.frame.calls === base.frame.calls, { base: base.frame.calls, again: restored.frame.calls });
    check("clean view draws only the model", clean.frame.mask === 1 && clean.frame.calls < base.frame.calls && clean.frame.gridUpdates === 0 && clean.frame.triadUpdates === 0,
      clean.frame);
    check("clean view still picks and selects", !!clean.pick.picked && clean.select.bodies.length + clean.select.faces.length > 0, { pick: clean.pick, select: clean.select });
    check("clean view hides the gizmo a body selection raises", ambient.handlesDrawn === false && ambient.rowHidden, ambient);
    check("clean view shows a running tool's gizmo", tool.handlesDrawn === true && tool.frame.calls > clean.frame.calls, { clean: clean.frame.calls, tool: tool.frame.calls });
    check("clean view plane pick draws and picks the planes", planes.drawn && planes.plane === "XY" && !afterPick, { ...planes, afterPick });
    check("clean view off brings the set back", back.frame.calls === base.frame.calls && back.frame.mask === base.frame.mask, { base: base.frame, back: back.frame });
    check("a picture leaves the mask as the view had it", pic.before === pic.after && pic.bytes > 1000, pic);
    check("no page errors", res.errors.length === 0, res.errors.slice(0, 3));
  } catch (e) {
    failed++;
    res.errors.push(String(e && e.stack || e));
    console.log("FAIL", e);
  } finally {
    fs.writeFileSync(path.join(OUT, "overlays.json"), JSON.stringify(res, null, 1));
    await browser.close();
  }
  console.log(failed ? `${failed} FAILED` : "ALL OK");
  process.exit(failed ? 1 : 0);
})();
