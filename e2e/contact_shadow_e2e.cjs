// The ground contact shadow: darker ground beside a box than far from it, on
// the side the box stands (a mirrored bake puts it on the other side), no bake
// while orbiting and one on a hide, kept in a picture, off on the lightweight
// render, and with Ground at None a frame exactly like one without the catcher.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome exe> [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_ANGLE=d3d11] node e2e/contact_shadow_e2e.cjs [outDir]
// SC_BASELINE=<png> compares the Ground None frame with that file; with
// SC_WRITE_BASELINE=1 the script only writes it, for a build without the catcher.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const ANGLE = process.env.SC_ANGLE || "d3d11";
const OUT = path.resolve(process.argv[2] || "contact_shadow_shots");
const BASELINE = process.env.SC_BASELINE || "";
const WRITE_BASELINE = process.env.SC_WRITE_BASELINE === "1";
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
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
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
    const gpu = await page.evaluate(() => {
      const g = window.viewport.scene.renderer.getContext();
      const d = g.getExtension("WEBGL_debug_renderer_info");
      return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?";
    });
    console.log(`  gpu ${gpu}`);
    // A software renderer starts on the low power tier, which never draws the catcher.
    if (/swiftshader|llvmpipe|software/i.test(gpu)) {
      console.error("needs a GPU: the low power tier a software renderer gets draws no contact shadow");
      process.exitCode = 1;
      return;
    }
    const modal = await page.$(".modal-close");
    if (modal) {
      await modal.click();
      await page.waitForTimeout(300);
    }

    const save = (name, url) =>
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(url.split(",")[1], "base64"));
    const frames = (n) =>
      page.evaluate(
        (n) =>
          new Promise((res) => {
            let i = 0;
            const step = () => (++i >= n ? res() : requestAnimationFrame(step));
            requestAnimationFrame(step);
          }),
        n,
      );
    const pref = async (k, v) => {
      await page.evaluate(
        ([k, v]) => {
          window.__fundacad.setRenderPref(k, v);
          window.viewport.requestRender();
        },
        [k, v],
      );
      await frames(6);
    };
    // The view without the grid, which is drawn over the catcher.
    const shot = (name) =>
      page
        .evaluate(() => {
          const sc = window.viewport.scene;
          const was = [sc.grid.group.visible, sc.triad.group.visible];
          sc.grid.group.visible = false;
          sc.triad.group.visible = false;
          try {
            return window.viewport.screenshotPNG();
          } finally {
            [sc.grid.group.visible, sc.triad.group.visible] = was;
          }
        })
        .then((url) => {
          save(name, url);
          return url;
        });
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
            g.drawImage(img, 0, 0, w, h);
            return g.getImageData(0, 0, w, h).data;
          };
          const p = px(A),
            q = px(B);
          let sum = 0,
            n = 0,
            max = 0;
          for (let i = 0; i < p.length; i += 4)
            for (let c = 0; c < 3; c++) {
              const d = Math.abs(p[i + c] - q[i + c]);
              sum += d;
              n++;
              if (d > max) max = d;
            }
          return { mean: sum / n, max, sameSize: A.width === B.width && A.height === B.height };
        },
        [a, b],
      );
    // Mean luminance of a 2 mm square around world point (x, y, z) in an image of the current view. The square
    // is sized in mm, not pixels, so at any fit zoom it stays clear of a body's outline 2.5 mm away.
    const lum = (url, pts) =>
      page.evaluate(
        async ([url, pts]) => {
          const cam = window.viewport.rig.active;
          cam.updateMatrixWorld();
          const V = cam.position.constructor;
          const img = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = rej;
            i.src = url;
          });
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          return pts.map(([x, y, z]) => {
            const v = new V(x, y, z).project(cam);
            const u = new V(x + 1, y, z).project(cam);
            const px = Math.round(((v.x + 1) / 2) * img.width),
              py = Math.round(((1 - v.y) / 2) * img.height);
            const r = Math.max(1, Math.round((Math.abs(u.x - v.x) / 2) * img.width));
            const d = g.getImageData(px - r, py - r, 2 * r + 1, 2 * r + 1).data;
            let s = 0;
            for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            return s / (d.length / 4);
          });
        },
        [url, pts],
      );

    // One block standing on the ground at x = 30 and a small one off to -X and
    // +Y, so the catcher's middle is under neither and a mirror in X or Y shows.
    const n = await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "box", length: 20, width: 20, height: 20 });
      s.addFeature({ id: s.nextId(), type: "move", bodies: ["body1"], dx: 30, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 });
      s.addFeature({ id: s.nextId(), type: "box", length: 6, width: 6, height: 6 });
      s.addFeature({ id: s.nextId(), type: "move", bodies: ["body2"], dx: -30, dy: 20, dz: -7, rx: 0, ry: 0, rz: 0 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 2) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return s.buildState.result?.bodies?.length ?? 0;
    });
    check("two bodies built", n === 2, `${n}`);
    // A light ground, so a shadow has something to darken.
    await pref("background", "light");
    await page.evaluate(() => window.__fundacad.handleAction("top"));
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    for (let i = 0, prev = await shot("settle"); i < 20; i++) {
      await page.waitForTimeout(700);
      const now = await shot("settle");
      const d = await diff(prev, now);
      prev = now;
      if (d.mean < 0.02) break;
    }

    const none0 = await shot("ground_none");
    if (WRITE_BASELINE) {
      fs.writeFileSync(BASELINE || path.join(OUT, "baseline.png"), Buffer.from(none0.split(",")[1], "base64"));
      console.log("baseline written");
      return;
    }
    if (BASELINE && fs.existsSync(BASELINE)) {
      const base = "data:image/png;base64," + fs.readFileSync(BASELINE).toString("base64");
      const d = await diff(base, none0);
      check(
        "Ground None draws the frame a build without the catcher drew",
        d.sameSize && d.max === 0,
        JSON.stringify(d),
      );
    }
    const caught = await page.evaluate(() => window.viewport.contactShadow.group.visible);
    check("Ground None by default, no catcher drawn", !caught);
    // Both workspaces, whichever the page opened on.
    const ground = async (g) => {
      await pref("groundModel", g);
      await pref("groundRender", g);
    };
    await ground("shadow");
    await page.waitForTimeout(300);
    const shadow = await shot("ground_shadow");
    const z = await page.evaluate(() => window.viewport.contactShadow.group.position.z);
    const [cx, cy] = await page.evaluate(() => [
      window.viewport.contactShadow.group.position.x,
      window.viewport.contactShadow.group.position.y,
    ]);
    // Beside the big block's +X and -Y faces, the same points mirrored through
    // the catcher's middle, and two far from both blocks.
    const pts = [
      [42.5, 0, z],
      [30, -12.5, z],
      [2 * cx - 42.5, 0, z],
      [30, 2 * cy + 12.5, z],
      [5, -30, z],
      [0, 40, z],
    ];
    const [lx, ly, mx, my, far1, far2] = await lum(shadow, pts);
    const far = (far1 + far2) / 2;
    console.log(
      `    luminance beside the block ${lx.toFixed(1)} ${ly.toFixed(1)}, mirrored ${mx.toFixed(1)} ${my.toFixed(1)}, far ${far1.toFixed(1)} ${far2.toFixed(1)}`,
    );
    check(
      "the ground beside the big block is darker than far away",
      lx < far - 8 && ly < far - 8,
      `${lx.toFixed(1)} ${ly.toFixed(1)} against ${far.toFixed(1)}`,
    );
    check(
      "and not where a mirrored bake would put it",
      mx > lx + 5 && my > ly + 5,
      `${mx.toFixed(1)} ${my.toFixed(1)}`,
    );
    await ground("none");
    const none1 = await shot("ground_none_again");
    const dn = await diff(none0, none1);
    check("Ground None again is the first frame exactly", dn.max === 0, JSON.stringify(dn));
    const [nx, ny, , , nfar1] = await lum(none1, pts);
    check(
      "with Ground None there is no such darkness",
      Math.abs(nx - nfar1) < 3 && Math.abs(ny - nfar1) < 3,
      `${nx.toFixed(1)} ${ny.toFixed(1)} ${nfar1.toFixed(1)}`,
    );
    await ground("shadow");

    const bakes = () => page.evaluate(() => window.viewport.contactShadow.bakes);
    const b0 = await bakes();
    check("it baked", b0 >= 1, `${b0}`);
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.viewport.rig.orbitBy(0.03, 0.01));
      await frames(1);
    }
    await frames(4);
    check("orbiting 30 frames never rebakes", (await bakes()) === b0, `${b0} then ${await bakes()}`);
    await page.evaluate(() => window.__fundacad.handleAction("top"));
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(1500);

    const meshVisible = (on) =>
      page.evaluate((on) => {
        const v = window.viewport;
        v.scene.modelGroup.traverse((o) => {
          if (o.userData.owner && o.userData.owner.id === "body2") o.visible = on;
        });
        v.requestRender();
      }, on);
    const b1 = await bakes();
    await meshVisible(false);
    await frames(4);
    check("hiding a body rebakes once", (await bakes()) === b1 + 1, `${b1} then ${await bakes()}`);
    await meshVisible(true);
    await frames(4);
    check("showing it again rebakes once", (await bakes()) === b1 + 2, `${b1} then ${await bakes()}`);
    const b2 = await bakes();
    await page.evaluate(() => window.store.setBodyVisibility("body2", false));
    await page.waitForTimeout(2500);
    check("hiding it from the browser rebakes", (await bakes()) > b2, `${b2} then ${await bakes()}`);
    await page.evaluate(() => window.store.setBodyVisibility("body2", true));
    await page.waitForTimeout(2500);

    await page.evaluate(() => window.__fundacad.handleAction("top"));
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(1500);

    // A section keeping x < 30 cuts the big block's +X half away, and its shadow with it.
    const section = (on) =>
      page.evaluate(async (on) => {
        const url = [...document.scripts].map((x) => x.src).find((x) => /three/.test(x));
        const THREE = url ? await import(url) : await import("/node_modules/.vite/deps/three.js");
        window.viewport.setSectionView(
          on ? { plane: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 30), ghost: 0 } : null,
        );
        window.viewport.requestRender();
      }, on);
    const b3 = await bakes();
    await section(true);
    await frames(6);
    const cut = await shot("section_shadow");
    const [cutX, , , , cutFar] = await lum(cut, [
      [42.5, 0, z],
      [30, -12.5, z],
      [0, 0, z],
      [0, 0, z],
      [5, -30, z],
    ]);
    const [cutY] = await lum(cut, [[25, -12.5, z]]);
    check("a section rebakes", (await bakes()) > b3, `${b3} then ${await bakes()}`);
    check(
      "the cut away half leaves no shadow, the kept half does",
      cutX > cutFar - 3 && cutY < cutFar - 8,
      `${cutX.toFixed(1)} ${cutY.toFixed(1)} against ${cutFar.toFixed(1)}`,
    );
    await section(false);
    await frames(6);
    const viewNow = await shot("ground_shadow_again");
    const pic = await page.evaluate(() => window.viewport.renderStill(1, { realtime: true }));
    save("picture_shadow", pic);
    const [plx, ply, , , pfar1, pfar2] = await lum(pic, pts);
    const pfar = (pfar1 + pfar2) / 2;
    check(
      "a Realtime picture keeps the shadow",
      plx < pfar - 10 && ply < pfar - 10,
      `${plx.toFixed(1)} ${ply.toFixed(1)} against ${pfar.toFixed(1)}`,
    );
    const [vlx] = await lum(viewNow, pts);
    check("as dark as in the view", Math.abs(plx - vlx) < 8, `${plx.toFixed(1)} against ${vlx.toFixed(1)}`);

    await pref("performanceMode", true);
    await page.waitForTimeout(500);
    const hidden = await page.evaluate(() => window.viewport.contactShadow.group.visible === false);
    check("performance mode does not draw the catcher", hidden);
    const perfShadow = await shot("perf_shadow");
    await ground("none");
    const perfNone = await shot("perf_none");
    const dp = await diff(perfShadow, perfNone);
    check("and draws what Ground None draws", dp.max === 0, JSON.stringify(dp));
    await pref("performanceMode", false);

    await ground("shadow");
    await pref("shadows", true);
    await page.waitForTimeout(800);
    const keyLit = await shot("shadows_on");
    const [klx, kly] = await lum(keyLit, pts);
    check(
      "with Shadows on the catcher still darkens beside the block",
      klx < far && kly < far,
      `${klx.toFixed(1)} ${kly.toFixed(1)}`,
    );
    const keyVisible = await page.evaluate(() => window.viewport.contactShadow.keyShadow.visible);
    check("and takes the key shadow", keyVisible);
    await pref("shadows", false);
    await ground("none");

    // The row in Render's Environment tab sets Render's ground only.
    await page.evaluate(() => window.__fundacad.handleAction("materials"));
    await page.waitForTimeout(600);
    await page.click('#renderdock [role=tab][data-tab="environment"]');
    await page.waitForTimeout(200);
    await page.click('[data-ground="shadow"]');
    await frames(6);
    const row = await page.evaluate(() => {
      const p = window.__fundacad.renderPrefs();
      return {
        render: p.groundRender,
        model: p.groundModel,
        drawn: window.viewport.contactShadow.group.visible,
        pressed: document.querySelector('[data-ground="shadow"]')?.getAttribute("aria-pressed"),
      };
    });
    check(
      "the Shadow chip sets Render's ground and the catcher shows",
      row.render === "shadow" && row.model === "none" && row.drawn && row.pressed === "true",
      JSON.stringify(row),
    );
    await page.click('[data-ground="none"]');
    await frames(6);
    check(
      "and None takes it away",
      await page.evaluate(
        () => window.__fundacad.renderPrefs().groundRender === "none" && !window.viewport.contactShadow.group.visible,
      ),
    );
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} failed` : "all passed");
  process.exit(failures ? 1 : 0);
})();
