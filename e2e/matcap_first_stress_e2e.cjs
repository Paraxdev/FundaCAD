// The first stress result after launch is drawn in Matcap, with Shadows on.
//
// With Shadows on the key light casts, but Matcap skips the shadow pass, so until a Realtime frame has run the
// light has no shadow map. three then binds an RGBA texture to the stress mesh's shadow sampler and ANGLE drops
// the draw (GL_INVALID_OPERATION), so the result was invisible until the view mode was switched once.
//
// Usage (from the repo root, with vite on 5173 + engine on 8765 (`fundacad-engine --ws`)):
//   SC_TOKEN=<engine token> SC_CHROME=<chromium or brave> node e2e/matcap_first_stress_e2e.cjs
// SC_APP_PORT and SC_ENGINE_PORT move it off 5173/8765 (the engine then needs FUNDACAD_EXTRA_ORIGINS for that app
// port). SC_ANGLE=d3d11 runs it on a real GPU; under SwiftShader the low power tier turns the shadow map off, so
// the check turns it back on to reach the same draw.
const { chromium } = require("playwright-core");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const APP_PORT = process.env.SC_APP_PORT || "5173";
const WS_PORT = process.env.SC_ENGINE_PORT || "8765";
const ANGLE = process.env.SC_ANGLE || "swiftshader";
if (!TOKEN) {
  console.error("set SC_TOKEN");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `, ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  const args = [`--use-angle=${ANGLE}`, "--no-sandbox"];
  if (ANGLE !== "swiftshader") args.push("--enable-gpu", "--ignore-gpu-blocklist");
  const browser = await chromium.launch({ executablePath: EXE, args });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    let mismatches = 0;
    page.on("console", (m) => {
      if (/GL_INVALID_OPERATION/.test(m.text())) mismatches++;
    });
    page.on("pageerror", (e) => {
      console.error("PAGE ERROR:", e.message);
      failures++;
    });
    await page.addInitScript(
      ({ t, ws }) => {
        try {
          const k = "fundacad.render";
          const o = JSON.parse(localStorage.getItem(k) || "{}");
          localStorage.setItem(k, JSON.stringify({ ...o, viewModeModel: "matcap", shadows: true }));
        } catch {}
        const N = window.WebSocket;
        class P extends N {
          constructor(u, p) {
            const s = String(u)
              .replace(":8765", `:${ws}`)
              .replace(/([?&])token=[^&]*/, `$1token=${t}`);
            super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
          }
        }
        window.WebSocket = P;
      },
      { t: TOKEN, ws: WS_PORT },
    );

    await page.goto(`http://localhost:${APP_PORT}/`);
    await page.waitForFunction(() => !!window.__fundacad?.viewport, null, { timeout: 90000 });
    await page.waitForTimeout(2500);
    const setup = await page.evaluate(() => {
      const r = window.__fundacad.viewport.scene.renderer;
      const forced = !r.shadowMap.enabled;
      r.shadowMap.enabled = true;
      const d = r.getContext().getExtension("WEBGL_debug_renderer_info");
      return {
        gpu: d ? r.getContext().getParameter(d.UNMASKED_RENDERER_WEBGL) : "?",
        forced,
        viewMode: window.__fundacad.viewport.scene.post.viewMode,
      };
    });
    console.log(`  gpu ${setup.gpu}, shadow map forced on: ${setup.forced}`);
    check("the stored Matcap view mode is the one drawn", setup.viewMode === "matcap", setup.viewMode);

    await page.getByText("Wall bracket", { exact: true }).first().click();
    await page.waitForFunction(
      () =>
        !window.__fundacad.store.buildState.building && window.__fundacad.store.buildState.result?.bodies?.length > 0,
      null,
      { timeout: 60000 },
    );
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__fundacad.handleAction("stress"));
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^Run/ }).first().click();
    await page.waitForFunction(() => window.__fundacad.viewport.hasStressOverlay(), null, { timeout: 120000 });
    await page.waitForTimeout(2000);

    const casters = await page.evaluate(() => {
      const out = [];
      window.__fundacad.viewport.scene.scene.traverse((o) => {
        if (o.isLight && o.castShadow) out.push(!!o.shadow?.map);
      });
      return out;
    });
    check("a light casts and has no shadow map yet, the state that dropped the draw", casters.includes(false), casters);

    const drawn = await page.evaluate(async () => {
      const v = window.__fundacad.viewport;
      const gl = v.scene.renderer.getContext();
      while (gl.getError() !== gl.NO_ERROR);
      v.requestRender();
      await new Promise((r) => setTimeout(r, 1500));
      return gl.getError();
    });
    check("the Matcap frame draws with no GL error", drawn === 0, drawn);
    check("no draw is rejected for a sampler mismatch", mismatches === 0, mismatches);

    const box = await page.evaluate(() => {
      const v = window.__fundacad.viewport;
      const m = v.stressMesh;
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox;
      const rect = v.scene.renderer.domElement.getBoundingClientRect();
      const xs = [];
      const ys = [];
      for (let i = 0; i < 8; i++) {
        const p = new b.min.constructor(
          i & 1 ? b.max.x : b.min.x,
          i & 2 ? b.max.y : b.min.y,
          i & 4 ? b.max.z : b.min.z,
        );
        p.applyMatrix4(m.matrixWorld).project(v.camera);
        xs.push(rect.left + ((p.x + 1) / 2) * rect.width);
        ys.push(rect.top + ((1 - p.y) / 2) * rect.height);
      }
      const x0 = Math.max(rect.left, Math.min(...xs));
      const y0 = Math.max(rect.top, Math.min(...ys));
      const x1 = Math.min(rect.right, Math.max(...xs));
      const y1 = Math.min(rect.bottom, Math.max(...ys));
      return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
    });
    const shown = await page.screenshot({ clip: box });
    await page.evaluate(async () => {
      const v = window.__fundacad.viewport;
      v.stressMesh.visible = false;
      v.requestRender();
      await new Promise((r) => setTimeout(r, 1000));
    });
    const bare = await page.screenshot({ clip: box });
    await page.evaluate(() => {
      const v = window.__fundacad.viewport;
      v.stressMesh.visible = true;
      v.requestRender();
    });
    const changed = await page.evaluate(
      async ({ a, b }) => {
        const px = async (src) => {
          const img = new Image();
          img.src = `data:image/png;base64,${src}`;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          return g.getImageData(0, 0, c.width, c.height).data;
        };
        const [p, q] = [await px(a), await px(b)];
        let n = 0;
        for (let i = 0; i < p.length; i += 4)
          if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 30) n++;
        return n / (p.length / 4);
      },
      { a: shown.toString("base64"), b: bare.toString("base64") },
    );
    // Measured on the Wall bracket: about 19 percent of its screen box when drawn, 0 when the draw is dropped.
    check(
      "the stress result covers its box on screen",
      changed > 0.08,
      `${(changed * 100).toFixed(1)}% of ${box.width}x${box.height}`,
    );
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
