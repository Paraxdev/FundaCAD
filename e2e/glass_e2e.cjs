// Glass in a real browser on a real GPU: IOR, thickness, tint and dispersion
// from the material editor have to bend the picture behind a glass body, and
// performance mode has to put it back to plain alpha.
//
// Transmission is drawn only on a capable renderer: SwiftShader is detected as a
// weak machine and drops glass to alpha, so this launches Chrome on the GPU
// (ANGLE D3D11 on Windows). The last step checks that drop on purpose.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome exe> [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_ANGLE=d3d11] node e2e/glass_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const ANGLE = process.env.SC_ANGLE || "d3d11";
const OUT = path.resolve(process.argv[2] || "glass_shots");
if (!TOKEN) { console.error("set SC_TOKEN"); process.exit(1); }
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const shaderErrors = [];
  page.on("console", (m) => { if (/Shader Error|Program Info Log|WebGL: INVALID/i.test(m.text())) shaderErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => { console.error("PAGE ERROR:", e.message); failures++; });
  await page.addInitScript(([port, t]) => {
    const N = window.WebSocket;
    window.WebSocket = class extends N {
      constructor(u, p) {
        let s = String(u).replace("127.0.0.1:8765", "127.0.0.1:" + port);
        s = s.replace(/([?&])token=[^&]*/, `$1token=${t}`);
        super(s.includes("token=") ? s : s + (s.includes("?") ? "&" : "?") + "token=" + t, p);
      }
    };
  }, [PORT, TOKEN]);

  await page.goto(URL);
  await page.waitForFunction(() => !!window.store && !!window.viewport, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const modal = await page.$(".modal-close");
  if (modal) { await modal.click(); await page.waitForTimeout(300); }
  const renderer = await page.evaluate(() => {
    const gl = window.viewport.scene.renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  console.log("renderer:", renderer);
  check("renderer is a GPU, not SwiftShader", !/swiftshader/i.test(renderer), renderer);

  // A glass block turned 40 degrees in front of black bars on a white wall, so
  // anything the glass does to light shows as bent, shifted or coloured bars.
  const built = await page.evaluate(async () => {
    const s = window.store;
    s.addFeature({ id: s.nextId(), type: "box", length: 40, width: 24, height: 40 });
    s.addFeature({ id: s.nextId(), type: "move", bodies: ["body1"], dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 40 });
    s.addFeature({ id: s.nextId(), type: "box", length: 120, width: 2, height: 80 });
    s.addFeature({ id: s.nextId(), type: "move", bodies: ["body2"], dx: 0, dy: 60, dz: 0, rx: 0, ry: 0, rz: 0 });
    for (let i = 0; i < 10; i++) {
      s.addFeature({ id: s.nextId(), type: "box", length: 4, width: 2, height: 80 });
      s.addFeature({ id: s.nextId(), type: "move", bodies: [`body${i + 3}`], dx: -54 + i * 12, dy: 56, dz: 0, rx: 0, ry: 0, rz: 0 });
    }
    await s.rebuildNow();
    for (let i = 0; i < 300; i++) {
      const b = s.buildState;
      if (!b.building && b.result?.bodies?.length >= 12) return b.result.bodies.length;
      await new Promise((r) => setTimeout(r, 100));
    }
    return s.buildState.result?.bodies?.length ?? 0;
  });
  check("scene built", built >= 12, `${built} bodies`);
  await page.evaluate(() => {
    const s = window.store;
    const white = s.addMaterial({ name: "wall", color: "#f2f2f2" });
    const black = s.addMaterial({ name: "bar", color: "#101010" });
    s.setBodiesMaterial(["body2"], white);
    s.setBodiesMaterial(Array.from({ length: 10 }, (_, i) => `body${i + 3}`), black);
    s.setBodiesMaterial(["body1"], "m-glass");
  });
  await page.evaluate(() => window.__fundacad.handleAction("front"));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__fundacad.handleAction("fit"));
  await page.waitForTimeout(1200);

  await page.click('#workspace-toggle [data-workspace="render"]');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('[data-material="m-glass"]').click());
  await page.waitForTimeout(300);
  check("glass controls shown for a glass material", !!(await page.$("[data-glass]")));

  const glassMat = () => page.evaluate(() => {
    const b = window.viewport.bodyMeshes.find((x) => x.id === "body1");
    const m = Array.isArray(b.mesh.material) ? b.mesh.material[0] : b.mesh.material;
    return {
      ior: m.ior, thickness: m.thickness, dispersion: m.dispersion, transmission: m.transmission,
      transparent: m.transparent, attenuation: m.attenuationColor?.getHexString(), distance: m.attenuationDistance,
    };
  });
  // The pixels inside the glass body's screen rectangle, as a PNG and its bounds.
  const shot = async (name) => {
    await page.evaluate(async () => { window.viewport.requestRender(); await new Promise((r) => setTimeout(r, 700)); });
    const rect = await page.evaluate(() => {
      const b = window.viewport.bodyMeshes.find((x) => x.id === "body1");
      b.mesh.geometry.computeBoundingBox();
      const bb = b.mesh.geometry.boundingBox.clone().applyMatrix4(b.mesh.matrixWorld);
      const cam = window.viewport.camera ?? window.viewport.rig?.camera;
      const cv = window.viewport.scene.renderer.domElement.getBoundingClientRect();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        const p = bb.min.clone();
        if (i & 1) p.x = bb.max.x;
        if (i & 2) p.y = bb.max.y;
        if (i & 4) p.z = bb.max.z;
        p.project(cam);
        const sx = cv.left + (p.x + 1) / 2 * cv.width, sy = cv.top + (1 - p.y) / 2 * cv.height;
        x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
      }
      return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
    });
    const buf = await page.screenshot({ clip: rect });
    fs.writeFileSync(path.join(OUT, `${name}.png`), buf);
    return buf.toString("base64");
  };
  const diff = (a, b) => page.evaluate(async ([a, b]) => {
    const px = async (s) => {
      const img = await createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob());
      const c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, img.width, img.height).data;
    };
    const [p, q] = [await px(a), await px(b)];
    if (p.length !== q.length) return { meanAbs: -1, changed: -1 };
    let sum = 0, changed = 0;
    for (let i = 0; i < p.length; i += 4) {
      const d = Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
      sum += d / 3;
      if (d > 30) changed++;
    }
    return { meanAbs: +(sum / (p.length / 4)).toFixed(2), changed };
  }, [a, b]);
  const slide = (field, v) => page.evaluate(([f, v]) => {
    const el = document.querySelector(`[data-field="${f}"]`);
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, [field, v]);

  const old = await glassMat();
  check("an old glass keeps IOR 1.5 and 3 mm", old.ior === 1.5 && old.thickness === 3 && old.dispersion === 0
    && old.transmission > 0, JSON.stringify(old));
  await shot("glass_default");

  // --- IOR through the preset chips -------------------------------------------
  await page.click('[data-ior="1.33"]');
  const water = await shot("ior_1.33");
  check("Water chip sets IOR 1.33", (await glassMat()).ior === 1.33);
  await page.click('[data-ior="2.42"]');
  const diamond = await shot("ior_2.42");
  check("Diamond chip sets IOR 2.42", (await glassMat()).ior === 2.42);
  const dIor = await diff(water, diamond);
  check("IOR 1.33 to 2.42 visibly bends the bars", dIor.meanAbs > 5 && dIor.changed > 2000, JSON.stringify(dIor));

  // --- dispersion, which needs thickness to show ------------------------------
  await slide("thickness", 20);
  await slide("dispersion", 0);
  const d0 = await shot("t20_dispersion_0");
  await slide("dispersion", 5);
  const d5 = await shot("t20_dispersion_5");
  const m5 = await glassMat();
  check("sliders set thickness 20 and dispersion 5", m5.thickness === 20 && m5.dispersion === 5, JSON.stringify(m5));
  const dDisp = await diff(d0, d5);
  check("dispersion 0 to 5 visibly splits the colours", dDisp.meanAbs > 2 && dDisp.changed > 1000, JSON.stringify(dDisp));

  // --- tint by depth ------------------------------------------------------------
  await page.evaluate(() => {
    const el = document.querySelector('[data-field="attenuationColor"]');
    el.value = "#2a8f6a";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const tinted = await shot("tint_2a8f6a");
  const mt = await glassMat();
  check("tint sets the attenuation colour and a depth", mt.attenuation === "2a8f6a" && mt.distance === 20, JSON.stringify(mt));
  const dTint = await diff(d5, tinted);
  check("tint visibly colours the glass", dTint.meanAbs > 5, JSON.stringify(dTint));

  // --- the swatch is a new render for the changed glass ------------------------
  const swatches = await page.evaluate(() => new Set([...document.querySelectorAll(".rd-tile img")].map((i) => i.src)).size);
  check("swatches rendered", swatches > 1, `${swatches} distinct`);

  // --- performance mode drops glass to plain alpha -----------------------------
  await page.evaluate(async () => {
    const p = await import("/src/ui/renderPrefs.ts");
    p.setRenderPref("performanceMode", true);
  });
  await page.waitForTimeout(300);
  const low = await glassMat();
  await shot("performance_mode");
  check("performance mode draws glass as alpha", low.transmission === 0 && low.transparent === true
    && low.dispersion === 0, JSON.stringify(low));
  await page.evaluate(async () => {
    const p = await import("/src/ui/renderPrefs.ts");
    p.setRenderPref("performanceMode", false);
  });
  await page.waitForTimeout(300);
  const back = await glassMat();
  check("leaving performance mode brings the glass back", back.transmission > 0 && back.dispersion === 5, JSON.stringify(back));

  check("no shader errors", shaderErrors.length === 0, shaderErrors[0]);
  await page.screenshot({ path: path.join(OUT, "full.png") });
  await browser.close();
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
