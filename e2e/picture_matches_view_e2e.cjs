// A saved Realtime picture looks like the viewport: glass, an emitter and painted
// boxes, every body and a face selected, a face hovered, and the picture must
// show none of that selection, nor the grid or a gizmo, at any size. Then glass
// on every body under shadows and bloom.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome exe> [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_ANGLE=d3d11] [SC_QUALITY=standard|high] node e2e/picture_matches_view_e2e.cjs [outDir]
// SC_QUALITY picks the realtime quality through the Realtime quality row of the
// Render dock (a dev build shows it), so the pictures are compared with the view
// drawn by that tier.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const ANGLE = process.env.SC_ANGLE || "d3d11";
const QUALITY = process.env.SC_QUALITY || "";
const OUT = path.resolve(process.argv[2] || "picture_shots");
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: EXE,
    args: [`--use-angle=${ANGLE}`, "--enable-gpu", "--ignore-gpu-blocklist", "--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    await page.addInitScript(
      ([port, t]) => {
        const N = window.WebSocket;
        window.WebSocket = class extends N {
          constructor(u, p) {
            let s = String(u).replace("127.0.0.1:8765", "127.0.0.1:" + port);
            s = s.replace(/([?&])token=[^&]*/, `$1token=${t}`);
            super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
          }
        };
      },
      [PORT, TOKEN],
    );
    await page.goto(URL);
    await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const modal = await page.$(".modal-close");
    if (modal) {
      await modal.click();
      await page.waitForTimeout(300);
    }

    if (QUALITY) {
      await page.click('#workspace-toggle [data-workspace="render"]');
      await page.waitForTimeout(500);
      await page.click('#renderdock [role=tab][data-tab="environment"]');
      await page.click(`[data-realtime-quality="${QUALITY}"]`);
      await page.waitForTimeout(2500);
      const now = await page.evaluate(() => window.viewport.scene.post.realtimeQuality);
      check(`the row put the view at ${QUALITY}`, now === QUALITY, now);
    }

    const bodies = await page.evaluate(async () => {
      const s = window.store;
      const box = (l, w, h, dx, dy, dz, b) => {
        s.addFeature({ id: s.nextId(), type: "box", length: l, width: w, height: h });
        s.addFeature({ id: s.nextId(), type: "move", bodies: [b], dx, dy, dz, rx: 0, ry: 0, rz: 0 });
      };
      box(40, 40, 40, 0, 0, 0, "body1");
      box(30, 30, 30, 50, 0, 0, "body2");
      box(20, 20, 60, -45, 0, 0, "body3");
      box(160, 100, 4, 0, 0, -22, "body4");
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 4) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const red = s.addMaterial({ name: "red", color: "#c03020" });
      s.setBodiesMaterial(["body1"], red);
      s.setBodiesMaterial(["body2"], "m-glass");
      s.setBodiesMaterial(["body3"], "m-emitter");
      s.setBodiesMaterial(["body4"], "m-wood");
      return s.buildState.result?.bodies?.length ?? 0;
    });
    check("four bodies built", bodies === 4, `${bodies}`);
    await page.evaluate(() => window.__fundacad.handleAction("iso"));
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(1500);

    // The High stages each view and picture was drawn by, null for today's path.
    const drawnBy = [];
    const save = (name, url) =>
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(url.split(",")[1], "base64"));
    const still = async (name, k, edges) => {
      const { url, stages } = await page.evaluate(
        ([k, edges]) => {
          const url = window.viewport.renderStill(k, { edges, realtime: true });
          return { url, stages: window.viewport.scene.post.highStages };
        },
        [k, edges],
      );
      drawnBy.push([name, stages]);
      save(name, url);
      await page.waitForTimeout(300);
      return url;
    };
    // The view as drawn, with the furniture a picture never has switched off by hand.
    const bareView = async (name) => {
      const { url, stages } = await page.evaluate(() => {
        const sc = window.viewport.scene;
        const was = [sc.grid.group.visible, sc.triad.group.visible];
        sc.grid.group.visible = false;
        sc.triad.group.visible = false;
        try {
          return { url: window.viewport.screenshotPNG(), stages: sc.post.highStages };
        } finally {
          [sc.grid.group.visible, sc.triad.group.visible] = was;
        }
      });
      drawnBy.push([name, stages]);
      save(name, url);
      return url;
    };
    // Mean absolute difference per channel (0 to 255), b resized to a's size.
    const diff = (a, b) =>
      page.evaluate(
        async ([a, b]) => {
          const load = (u) =>
            new Promise((res, rej) => {
              const i = new Image();
              i.onload = () => res(i);
              i.onerror = rej;
              i.src = u;
            });
          const [A, B] = await Promise.all([load(a), load(b)]);
          const w = A.width,
            h = A.height;
          const px = (img) => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const g = c.getContext("2d");
            g.imageSmoothingQuality = "high";
            g.drawImage(img, 0, 0, w, h);
            return g.getImageData(0, 0, w, h).data;
          };
          const p = px(A),
            q = px(B);
          let sum = 0,
            n = 0;
          for (let i = 0; i < p.length; i += 4) {
            for (let c = 0; c < 3; c++) sum += Math.abs(p[i + c] - q[i + c]);
            n += 3;
          }
          return sum / n;
        },
        [a, b],
      );

    // Emitter lights and glass finish a while after the build, wait for the view to stop changing.
    for (let i = 0, prev = await page.evaluate(() => window.viewport.screenshotPNG()); i < 30; i++) {
      await page.waitForTimeout(1000);
      const now = await page.evaluate(() => window.viewport.screenshotPNG());
      const d = await diff(prev, now);
      prev = now;
      if (d < 0.05) break;
    }
    const plain1 = await still("plain_1", 1, false);
    const plain4 = await still("plain_4", 4, false);
    for (const [k, big] of [
      [2, await still("plain_2", 2, false)],
      [4, plain4],
    ]) {
      const d = await diff(plain1, big);
      check(`a ${k}x picture shrunk to the view's size looks like a 1x one, glow included`, d < 1.5, d.toFixed(2));
    }
    const view1 = await bareView("plain_view");
    const d1 = await diff(view1, await still("plain_edges_1", 1, true));
    check("a 1x picture with edges matches the view", d1 < 2, d1.toFixed(2));

    await page.evaluate(() => {
      const v = window.viewport;
      v.setSelectedBodies(["body1", "body2", "body3", "body4"]);
      const hl = v.highlighter;
      hl.selectFace(hl.view.bodies[0].faceStart);
      hl.hoverFace(hl.view.bodies[3].faceStart);
      v.requestRender();
    });
    await page.waitForTimeout(800);
    const selView = await page.evaluate(() => window.viewport.screenshotPNG());
    save("selected_view", selView);
    const selDiffView = await diff(view1, selView);
    check("the selection shows in the view", selDiffView > 1, selDiffView.toFixed(2));
    const sel1 = await still("selected_1", 1, false);
    const dSel = await diff(plain1, sel1);
    check("a selection is not in the picture", dSel < 0.5, dSel.toFixed(2));
    const sel4 = await still("selected_4", 4, false);
    const dSel4 = await diff(plain4, sel4);
    check("nor in a 4x picture", dSel4 < 0.5, dSel4.toFixed(2));
    await page.evaluate(() => window.viewport.setSelectedBodies([]));
    await page.evaluate(() => {
      const hl = window.viewport.highlighter;
      hl.clearSelection();
      hl.clearHover();
    });
    await page.waitForTimeout(500);

    // How much of the picture the edge lines cover, as the difference they make,
    // is about the same share at every size when they are as thick as in the view.
    // Not exactly: on a silhouette the face in front hides the inner half of a
    // wider line, measured 0.81 at 2x and 0.67 at 4x, against 0.40 and 0.16 when
    // the lines were not widened.
    const lines1 = await diff(plain1, await still("plain_edges_1", 1, true));
    for (const k of [2, 4]) {
      const bare = await still(`plain_${k}`, k, false);
      const linesK = await diff(bare, await still(`plain_edges_${k}`, k, true));
      const share = linesK / lines1;
      check(
        `edge lines in a ${k}x picture are as heavy as in the view`,
        share > 0.6 && share < 1.4,
        `${linesK.toFixed(2)} against ${lines1.toFixed(2)} at 1x`,
      );
    }

    // Glass everywhere under shadows and bloom: a frame that redraws the shadow
    // maps (every picture does) must look like the frames that keep them.
    await page.evaluate(async () => {
      const s = window.store,
        f = window.__fundacad;
      s.setBodiesMaterial(["body1", "body2", "body3", "body4"], "m-glass-tinted");
      f.setRenderPref("environment", "bright");
      f.setRenderPref("shadows", true);
      f.setRenderPref("bloom", 0.2);
      await s.rebuildNow();
    });
    for (let i = 0, prev = await page.evaluate(() => window.viewport.screenshotPNG()); i < 30; i++) {
      await page.waitForTimeout(1000);
      const now = await page.evaluate(() => window.viewport.screenshotPNG());
      const d = await diff(prev, now);
      prev = now;
      if (d < 0.05) break;
    }
    const frame = (redraw) =>
      page.evaluate((redraw) => {
        const v = window.viewport,
          sc = v.scene,
          r = sc.renderer;
        const was = [sc.grid.group.visible, sc.triad.group.visible, r.shadowMap.autoUpdate];
        sc.grid.group.visible = false;
        sc.triad.group.visible = false;
        r.shadowMap.autoUpdate = redraw;
        try {
          sc.post.render(v.rig.active, false, false, { moving: false, ghosted: v.ghosted });
          return { url: r.domElement.toDataURL("image/png"), stages: sc.post.highStages };
        } finally {
          [sc.grid.group.visible, sc.triad.group.visible, r.shadowMap.autoUpdate] = was;
          v.requestRender();
        }
      }, redraw);
    const { url: kept, stages: keptBy } = await frame(false);
    drawnBy.push(["glass_view", keptBy]);
    save("glass_view", kept);
    const { url: redrawn, stages: redrawnBy } = await frame(true);
    drawnBy.push(["glass_view_shadows_redrawn", redrawnBy]);
    save("glass_view_shadows_redrawn", redrawn);
    const dRedraw = await diff(kept, redrawn);
    check("glass looks the same on a frame that redraws the shadow maps", dRedraw < 1, dRedraw.toFixed(2));
    const glassStill = await still("glass_1", 1, true);
    const dGlass = await diff(kept, glassStill);
    check("a picture of glass under shadows and bloom matches the view", dGlass < 2, dGlass.toFixed(2));
    const glass2 = await still("glass_2", 2, true);
    const dGlass2 = await diff(kept, glass2);
    check("and so does a 2x one", dGlass2 < 3, dGlass2.toFixed(2));
    if (QUALITY === "high") {
      const today = drawnBy.filter(([, stages]) => !stages).map(([name]) => name);
      check(
        "every view and picture compared was drawn by the High stages",
        drawnBy.length > 0 && today.length === 0,
        today.length ? `today's path: ${today.join(", ")}` : `${drawnBy.length} drawn`,
      );
    }
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures ? 1 : 0);
})();
