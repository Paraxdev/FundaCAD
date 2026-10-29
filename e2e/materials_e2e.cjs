// Materials, in a real browser with a real WebGL renderer.
//
// The component and unit tests cover what the document holds and what the store
// hands the viewport. This covers the half that only exists once there are
// pixels: that a metal actually looks metallic, that glass is actually
// see-through, that sheen and anisotropy draw on an engine body (no uv
// attribute, which turns three's own anisotropy NaN), and that the three
// writers of a body's material (an assigned material, x-ray, and the
// stale-model ghost) do not each undo the others.
//
// The assertions read THREE.js material state back out of the live scene rather
// than comparing screenshots: a pixel diff of a lit sphere is a test that fails
// when a driver changes. The screenshots are there to be looked at.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> [SC_URL=http://localhost:5173/] [SC_ENGINE_PORT=8765] [SC_ANGLE=swiftshader|d3d11|gl] node e2e/materials_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const OUT = path.resolve(process.argv[2] || "materials_shots");
// SwiftShader is a low power tier, which draws no sheen or anisotropy; d3d11
// (Windows) or gl (Linux) on a GPU runs the full finish checks.
const ANGLE = process.env.SC_ANGLE || "swiftshader";
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
    args: [`--use-angle=${ANGLE}`, "--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR:", e.message);
    failures++;
  });
  await page.addInitScript(
    ([port, t]) => {
      const N = window.WebSocket;
      class P extends N {
        constructor(u, p) {
          let s = String(u).replace("127.0.0.1:8765", "127.0.0.1:" + port);
          s = s.replace(/([?&])token=[^&]*/, `$1token=${t}`);
          super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
        }
      }
      window.WebSocket = P;
    },
    [PORT, TOKEN],
  );

  await page.goto(URL);
  await page.waitForTimeout(3000);
  const modal = await page.$(".modal-close");
  if (modal) {
    await modal.click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });

  // Three bodies side by side: one left alone, one metal, one glass.
  const ids = await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      const id = window.store.nextId();
      window.store.addFeature({ id, type: "box", length: 20, width: 20, height: 20 });
      window.store.addFeature({
        id: window.store.nextId(),
        type: "move",
        body: `body${i + 1}`,
        dx: (i - 1) * 30,
        dy: 0,
        dz: 0,
      });
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const b = window.store.buildState;
      if (!b.building && b.result?.bodies?.length >= 3) return b.result.bodies.map((x) => x.id);
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  });
  check("three bodies built", Array.isArray(ids) && ids.length === 3, String(ids));
  if (!Array.isArray(ids)) {
    await browser.close();
    process.exit(1);
  }

  /** Every body's live THREE material state, which is what "it looks metallic"
   *  means in terms something can assert. */
  const finishes = () =>
    page.evaluate(() =>
      Object.fromEntries(
        window.viewport.bodyMeshes.map((b) => {
          const m = b.mesh.material;
          return [
            b.id,
            {
              metalness: +m.metalness.toFixed(3),
              roughness: +m.roughness.toFixed(3),
              opacity: +m.opacity.toFixed(3),
              transparent: m.transparent,
              depthWrite: m.depthWrite,
              transmission: +(m.transmission ?? 0).toFixed(3),
            },
          ];
        }),
      ),
    );

  const before = await finishes();
  check(
    "an unstyled body wears the app's default finish",
    before[ids[0]].metalness === 0.1 &&
      before[ids[0]].roughness === 0.55 &&
      before[ids[0]].opacity === 1 &&
      before[ids[0]].transparent === false,
    JSON.stringify(before[ids[0]]),
  );
  await page.locator("#viewport").screenshot({ path: `${OUT}/1-plain.png` });

  await page.evaluate((b) => {
    window.store.setBodiesMaterial([b[1]], "m-copper");
    window.store.setBodiesMaterial([b[2]], "m-glass");
  }, ids);
  await page.waitForTimeout(600);

  const after = await finishes();
  check(
    "a metal body is metallic and the plain one is untouched",
    after[ids[1]].metalness === 0.95 && after[ids[1]].roughness === 0.25 && after[ids[0]].metalness === 0.1,
    JSON.stringify({ metal: after[ids[1]], plain: after[ids[0]] }),
  );
  // Glass fades with alpha on the low power tier and transmits on the full one.
  const glassy = (g) =>
    (g.opacity === 0.25 && g.transparent === true && g.depthWrite === false) ||
    (g.transmission > 0.9 && g.opacity === 1);
  check(
    "a glass body is see-through, and stops writing depth so it can be seen through",
    glassy(after[ids[2]]),
    JSON.stringify(after[ids[2]]),
  );
  await page.locator("#viewport").screenshot({ path: `${OUT}/2-materials.png` });

  // --- the three writers of a material, against each other ------------------
  await page.evaluate(() => window.viewport.setXray(true));
  await page.waitForTimeout(300);
  const xray = await finishes();
  check(
    "x-ray makes the plain body see-through",
    xray[ids[0]].transparent === true && xray[ids[0]].opacity < 1,
    JSON.stringify(xray[ids[0]]),
  );
  check(
    "x-ray does not make glass LESS see-through than its material says",
    xray[ids[2]].opacity <= 0.25,
    JSON.stringify(xray[ids[2]]),
  );
  await page.locator("#viewport").screenshot({ path: `${OUT}/3-xray.png` });

  await page.evaluate(() => window.viewport.setXray(false));
  await page.waitForTimeout(300);
  const back = await finishes();
  check(
    "turning x-ray off restores each body to its OWN material, not to the default",
    glassy(back[ids[2]]) && back[ids[1]].metalness === 0.95 && back[ids[0]].opacity === 1,
    JSON.stringify(back),
  );

  // --- and it survives a rebuild, which hands back fresh materials ----------
  const survived = await page.evaluate(async () => {
    window.store.addFeature({ id: window.store.nextId(), type: "box", length: 5, width: 5, height: 5 });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const b = window.store.buildState;
      if (!b.building && b.result?.bodies?.length >= 4) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 400));
    return Object.fromEntries(
      window.viewport.bodyMeshes.map((b) => [
        b.id,
        {
          metalness: +b.mesh.material.metalness.toFixed(3),
          opacity: +b.mesh.material.opacity.toFixed(3),
          transmission: +(b.mesh.material.transmission ?? 0).toFixed(3),
        },
      ]),
    );
  });
  check(
    "a rebuild does not strip the materials off the bodies",
    survived[ids[1]].metalness === 0.95 && (survived[ids[2]].opacity === 0.25 || survived[ids[2]].transmission > 0.9),
    JSON.stringify(survived),
  );

  // --- the library round-trips through a file --------------------------------
  const lib = await page.evaluate(async () => {
    const { serializeLibrary, parseLibrary } = await import("/src/document/materials.ts");
    const json = serializeLibrary(window.store.materialLibrary);
    const back = parseLibrary(json);
    return {
      problem: back.problem,
      same: JSON.stringify(back.materials) === JSON.stringify(window.store.materialLibrary),
    };
  });
  check("the library exports and reads back unchanged", lib.problem === null && lib.same, JSON.stringify(lib));

  // --- the filament finish fields --------------------------------------------
  const fin = await page.evaluate(async () => {
    const s = window.store;
    const ids = [
      s.addMaterial({ name: "Velvet check", color: "#8a2a3a", roughness: 0.7, sheen: 0.8 }),
      s.addMaterial({ name: "Brushed check", color: "#c0c4c8", metalness: 1, roughness: 0.35, anisotropy: 0.6 }),
      s.addMaterial({ name: "Glow check", color: "#ffd080", emissive: 2, castsLight: false }),
    ];
    const lib = Object.fromEntries(s.materialLibrary.filter((m) => ids.includes(m.id)).map((m) => [m.id, m]));
    const n0 = s.buildState.result.bodies.length;
    s.addFeature({ id: s.nextId(), type: "sphere", radius: 10 });
    s.addFeature({ id: s.nextId(), type: "move", body: `body${n0 + 1}`, dx: -15, dy: 0, dz: 40 });
    s.addFeature({ id: s.nextId(), type: "sphere", radius: 10 });
    s.addFeature({ id: s.nextId(), type: "move", body: `body${n0 + 2}`, dx: 15, dy: 0, dz: 40 });
    s.addFeature({ id: s.nextId(), type: "box", length: 10, width: 10, height: 10 });
    s.addFeature({ id: s.nextId(), type: "move", body: `body${n0 + 3}`, dx: 45, dy: 0, dz: 40 });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const b = s.buildState;
      if (!b.building && b.result?.bodies?.length >= n0 + 3) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const bodies = [`body${n0 + 1}`, `body${n0 + 2}`, `body${n0 + 3}`];
    s.setBodiesMaterial([bodies[0]], ids[0]);
    s.setBodiesMaterial([bodies[1]], ids[1]);
    s.setBodiesMaterial([bodies[2]], ids[2]);
    return { ids, lib, bodies };
  });
  const [mSheen, mAniso, mGlow] = fin.ids;
  check(
    "the library keeps sheen, anisotropy and castsLight false as written",
    fin.lib[mSheen]?.sheen === 0.8 &&
      fin.lib[mAniso]?.anisotropy === 0.6 &&
      fin.lib[mGlow]?.castsLight === false &&
      !("castsLight" in fin.lib[mSheen]),
    JSON.stringify(fin.lib),
  );

  await page.evaluate(() => {
    window.viewport.setProjection("ortho");
    window.viewport.setStandardView("front");
    window.viewport.fitView();
  });
  await page.waitForTimeout(1200);
  const live = await page.evaluate((b) => {
    const body = (id) => window.viewport.bodyMeshes.find((x) => x.id === id);
    const m = (id) => body(id).mesh.material;
    return {
      low: window.viewport.renderTier.lowPower,
      sheen: { sheen: m(b[0]).sheen, anisotropy: m(b[0]).anisotropy },
      aniso: {
        anisotropy: m(b[1]).anisotropy,
        sheen: m(b[1]).sheen,
        uv: !!body(b[1]).mesh.geometry.getAttribute("uv"),
      },
      glow: { noLight: m(b[2]).userData.noLight === true, emissive: m(b[2]).emissiveIntensity },
    };
  }, fin.bodies);
  console.log(`  (${live.low ? "low power tier, sheen and anisotropy are dropped" : "full tier"}, ANGLE ${ANGLE})`);
  if (live.low) {
    check(
      "the low power tier draws no sheen and no anisotropy",
      !live.sheen.sheen && !live.aniso.anisotropy,
      JSON.stringify({ sheen: live.sheen, aniso: live.aniso }),
    );
  } else {
    check(
      "a sheen body draws sheen and no anisotropy",
      live.sheen.sheen === 0.8 && live.sheen.anisotropy === 0,
      JSON.stringify(live.sheen),
    );
    check(
      "an anisotropic engine body draws anisotropy, and has no uv attribute",
      live.aniso.anisotropy === 0.6 && live.aniso.uv === false,
      JSON.stringify(live.aniso),
    );
  }

  // A still decoded in the page, a disc inside the sphere's outline. A NaN
  // pixel reaches an 8 bit still as black.
  const disc = (centre, r) =>
    page.evaluate(
      async ([centre, r]) => {
        const v = window.viewport;
        for (let i = 0; i < 30; i++) {
          v.requestRender();
          await new Promise((q) => requestAnimationFrame(q));
        }
        const url = v.renderStill(1, { realtime: true });
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
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const cam = v.rig.active;
        const V3 = cam.position.constructor;
        const px = (x, y, z) => {
          const p = new V3(x, y, z).project(cam);
          return [((p.x + 1) / 2) * img.width, ((1 - p.y) / 2) * img.height];
        };
        const [cx, cy] = px(...centre);
        const [ex] = px(centre[0] + r * 0.8, centre[1], centre[2]);
        const rp = Math.abs(ex - cx);
        let black = 0,
          white = 0,
          n = 0,
          sum = 0;
        for (let y = Math.ceil(cy - rp); y <= Math.floor(cy + rp); y++) {
          for (let x = Math.ceil(cx - rp); x <= Math.floor(cx + rp); x++) {
            if ((x - cx) ** 2 + (y - cy) ** 2 > rp * rp) continue;
            const i = (y * img.width + x) * 4;
            if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0) black++;
            if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) white++;
            sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            n++;
          }
        }
        return { url, black, white, n, mean: +(sum / Math.max(n, 1)).toFixed(2), rp: +rp.toFixed(1) };
      },
      [centre, r],
    );
  const savePng = (name, url) =>
    fs.writeFileSync(path.join(OUT, name), Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
  const clean = (p) => p.n > 200 && p.black === 0 && p.white < p.n * 0.05;
  const sheenPx = await disc([-15, 0, 40], 10);
  const anisoPx = await disc([15, 0, 40], 10);
  savePng("4-sheen-aniso.png", anisoPx.url);
  delete sheenPx.url;
  delete anisoPx.url;
  check(
    "the anisotropic sphere has no NaN black pixel and is not blown out to white",
    clean(anisoPx),
    JSON.stringify(anisoPx),
  );
  check("the sheen sphere has no NaN black pixel", clean(sheenPx), JSON.stringify(sheenPx));

  if (!live.low) {
    // The same body through three's own anisotropy, its tangent frame left to
    // three: the check above has to be able to see the fault it guards against.
    await page.evaluate(async (b) => {
      const { removePatch } = await import("/src/viewport/shaderPatches.ts");
      const mat = window.viewport.bodyMeshes.find((x) => x.id === b).mesh.material;
      removePatch(mat, "anisotropy");
      mat.needsUpdate = true;
    }, fin.bodies[1]);
    const stockPx = await disc([15, 0, 40], 10);
    savePng("5-aniso-stock-three.png", stockPx.url);
    delete stockPx.url;
    check("without the tangent frame patch the same check fails (control)", !clean(stockPx), JSON.stringify(stockPx));
    await page.evaluate((id) => window.store.updateMaterial(id, { anisotropy: 0.61 }), mAniso);
    await page.waitForTimeout(300);
    await page.evaluate((id) => window.store.updateMaterial(id, { anisotropy: 0.6 }), mAniso);
    await page.waitForTimeout(600);
    const backPx = await disc([15, 0, 40], 10);
    delete backPx.url;
    check("the next finish change puts the patch back", clean(backPx), JSON.stringify(backPx));
  }

  // castsLight false: the glow stays and blooms, but throws no area light.
  // Emitter lights fill in over frames (seconds on a GPU tier), so the lit case
  // runs first to time the fill, and the dark case is held twice that long.
  const lightsOf = (wantLit, holdMs) =>
    page.evaluate(
      async ([wantLit, holdMs]) => {
        const v = window.viewport;
        const frame = () => {
          v.requestRender();
          return new Promise((q) => requestAnimationFrame(q));
        };
        const count = () => {
          let n = 0;
          v.scene.scene.traverseVisible((o) => {
            if (o.isRectAreaLight && o.intensity > 0) n++;
          });
          return n;
        };
        const t0 = Date.now();
        while (Date.now() - t0 < 15000 && count() > 0 !== wantLit) await frame();
        const ms = Date.now() - t0;
        while (Date.now() - t0 < ms + holdMs) await frame();
        for (let i = 0; i < 30; i++) await frame();
        return { lit: count(), bloomable: v.scene.post.bloomable, ms };
      },
      [wantLit, holdMs],
    );
  await page.evaluate((id) => window.store.updateMaterial(id, { castsLight: undefined }), mGlow);
  const lit = await lightsOf(true, 0);
  check("an emissive body that casts light throws area light", lit.lit > 0, JSON.stringify(lit));
  await page.evaluate((id) => window.store.updateMaterial(id, { castsLight: false }), mGlow);
  const dark = await lightsOf(false, Math.max(3000, 2 * lit.ms));
  check(
    "the same body with castsLight false throws no area light and still blooms",
    live.glow.noLight && live.glow.emissive > 0 && dark.lit === 0 && dark.bloomable === true,
    JSON.stringify({ ...live.glow, ...dark }),
  );

  // A motion start and stop links no new program for these finishes. The
  // motion draw is warmed first, it links its own programs once per page.
  const settle = () =>
    page.evaluate(async () => {
      const v = window.viewport;
      for (let i = 0; i < 60; i++) {
        v.requestRender();
        await new Promise((q) => requestAnimationFrame(q));
      }
    });
  await page.evaluate(() => {
    const v = window.viewport;
    v.scene.post.render(v.rig.active, true);
  });
  await settle();
  const programs = () => page.evaluate(() => window.viewport.scene.renderer.info.programs.length);
  const programKeys = () =>
    page.evaluate(() => window.viewport.scene.renderer.info.programs.map((q) => q.cacheKey.split(",")[0]));
  const progStill = await programs();
  const keysStill = await programKeys();
  // The low power motion draw goes to the canvas and a still frame through the post chain, so a hover glow needs
  // both output variants before the first glow shows, or its first motion frame links one.
  const glowSpaces = await page.evaluate(() => [
    ...new Set(
      window.viewport.scene.renderer.info.programs
        .filter((q) => q.name === "selection-glow")
        .map((q) => q.cacheKey.split(",").find((k) => k.startsWith("srgb")))
        .sort(),
    ),
  ]);
  check(
    "the selection glow is linked for the canvas and the post chain before any hover",
    JSON.stringify(glowSpaces) === JSON.stringify(["srgb", "srgb-linear"]),
    JSON.stringify(glowSpaces),
  );
  const cv = await page.evaluate(() => {
    const r = window.viewport.scene.renderer.domElement.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  });
  await page.mouse.move(cv[0] + 200, cv[1] + 200);
  await page.mouse.down({ button: "middle" });
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(cv[0] + 200 + i * 6, cv[1] + 200 + i * 3);
    await page.waitForTimeout(30);
  }
  const progMoving = await programs();
  await page.mouse.up({ button: "middle" });
  await page.waitForTimeout(1500);
  await settle();
  const progAfter = await programs();
  check(
    "a motion start and stop links no program with sheen and anisotropy on",
    progMoving === progStill && progAfter === progStill,
    JSON.stringify({
      still: progStill,
      moving: progMoving,
      after: progAfter,
      added: (await programKeys()).filter((k) => !keysStill.includes(k)),
    }),
  );

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
