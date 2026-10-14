// Surface node graphs, in a real browser with a real WebGL renderer.
//
// The unit tests check the GLSL compileGraph emits and the program cache key.
// This checks the half that only exists once three links a program: that the
// fragment shader the GPU actually runs carries the graph the material holds,
// for every node type, on a body and on faces, after a reload, and with a wire
// drawn in the editor itself. A program is reused whenever its cache key repeats,
// so a graph can sit in the document and still never reach the screen.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> [SC_URL=http://localhost:5173/] [SC_ENGINE_PORT=8765] \
//     node e2e/surface_graph_e2e.cjs [outDir]
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const OUT = path.resolve(process.argv[2] || "surface_graph_shots");
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
    args: ["--use-angle=swiftshader", "--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
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

  const built = await page.evaluate(async () => {
    window.store.addFeature({ id: window.store.nextId(), type: "box", length: 20, width: 20, height: 20 });
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const b = window.store.buildState;
      if (!b.building && b.result?.bodies?.length >= 1) return true;
    }
    return false;
  });
  check("box built", built);
  await page.evaluate(() => {
    window.__mid = window.store.addMaterial({ name: "graph", color: "#808080", roughness: 0.5 });
    window.store.setBodiesMaterial(["body1"], window.__mid);
  });

  // The fragment source three linked for each of body1's materials.
  const linked = () => page.evaluate(async () => {
    window.viewport.requestRender();
    await new Promise((r) => setTimeout(r, 600));
    const r = window.viewport.scene.renderer, gl = r.getContext();
    const b = window.viewport.bodyMeshes.find((x) => x.id === "body1");
    const mats = Array.isArray(b.mesh.material) ? b.mesh.material : [b.mesh.material];
    const out = mats.map((m) => {
      const p = r.properties.get(m).currentProgram;
      if (!p) return { program: null, sGraph: "" };
      const src = gl.getAttachedShaders(p.program).map((s) => gl.getShaderSource(s)).join("\n");
      const fn = (src.match(/SurfOut sGraph\(vec3 wp, vec3 wn\)\{[\s\S]*?return o;\n\}/) || [""])[0];
      return { program: p.id, sGraph: fn };
    });
    return { mats: out, programs: r.info.programs.length };
  });
  const look = async () => {
    const buf = await page.screenshot();
    return page.evaluate(async (b64) => {
      const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob());
      const c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      const cv = window.viewport.scene.renderer.domElement.getBoundingClientRect();
      const d = x.getImageData(Math.round(cv.left + cv.width / 2 - 60), Math.round(cv.top + cv.height / 2 - 60), 120, 120).data;
      let r = 0, g = 0, b = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      return [r / n, g / n, b / n];
    }, buf.toString("base64"));
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const setGraph = (g) => page.evaluate((g) => window.store.updateMaterial(window.__mid, { surfaceGraph: g }), g);
  const out = (wires) => ({ id: "out", type: "output", params: { roughAmount: 0.8, bumpAmount: 0.6, colorAmount: 0.9 }, in: wires });

  await setGraph({ output: "out", nodes: [out({})] });
  await linked();
  const base = await look();

  // --- every node type, through the store the editor writes to --------------
  const RAMP = { id: "rc", type: "ramp", params: { colorA: "#ff0000", colorB: "#0000ff" } };
  const gen = {
    noise: { type: "noise", params: { scale: 3, detail: 4, roughness: 0.5, distortion: 0.5 } },
    scratches: { type: "scratches", params: { scale: 3, angle: 0.3 } },
    brushed: { type: "brushed", params: { scale: 3, angle: 0 } },
    voronoi: { type: "voronoi", params: { scale: 3 } },
    wave: { type: "wave", params: { scale: 3, angle: 0 } },
    fresnel: { type: "fresnel", params: { power: 1 } },
  };
  const cases = [];
  for (const [k, n] of Object.entries(gen)) {
    cases.push([k, [{ id: "src", ...n }, { ...RAMP, in: { t: "src" } }], { bump: "src", roughness: "src", color: "rc" }]);
  }
  cases.push(["colorramp", [{ id: "src", ...gen.noise }, { id: "cr", type: "colorramp", params: { stops: "0:#ff0000;0.5:#00ff00;1:#0000ff" }, in: { t: "src" } }], { color: "cr" }]);
  cases.push(["mix", [{ id: "s1", ...gen.noise }, { id: "s2", ...gen.wave }, { id: "mx", type: "mix", params: { t: 0.5 }, in: { a: "s1", b: "s2" } }, { ...RAMP, in: { t: "mx" } }], { bump: "mx", color: "rc" }]);
  for (const op of ["multiply", "add", "subtract", "min", "max", "pow"]) {
    cases.push(["math " + op, [{ id: "s1", ...gen.noise }, { id: "mt", type: "math", params: { op, a: 0.5, b: 0.7 }, in: { a: "s1" } }, { ...RAMP, in: { t: "mt" } }], { bump: "mt", color: "rc" }]);
  }
  let programsBefore = null;
  for (const [name, nodes, wires] of cases) {
    await setGraph({ output: "out", nodes: [...nodes, out(wires)] });
    const s = await linked();
    programsBefore ??= s.programs;
    const fn = s.mats[0].sGraph;
    const wired = Object.values(wires).every((w) => fn.includes("g_" + w));
    const d = dist(await look(), base);
    check(`${name} reaches the linked shader and changes the look`, wired && d > 40, `centre moved ${d.toFixed(1)}`);
    await page.screenshot({ path: path.join(OUT, `node_${name.replace(" ", "_")}.png`) });
  }
  const programsAfter = (await linked()).programs;
  check("superseded graph programs are released", programsAfter - programsBefore <= 2, `${programsBefore} then ${programsAfter} after ${cases.length - 1} edits`);

  // --- faces: a second graph material on all six faces ----------------------
  await page.evaluate(() => {
    const id = window.store.addMaterial({ name: "faces", color: "#808080", roughness: 0.5 });
    window.store.updateMaterial(id, { surfaceGraph: { output: "out", nodes: [
      { id: "fv", type: "voronoi", params: { scale: 2 } },
      { id: "fr", type: "ramp", params: { colorA: "#00ff00", colorB: "#ff00ff" }, in: { t: "fv" } },
      { id: "out", type: "output", params: { roughAmount: 0.8, bumpAmount: 0.6, colorAmount: 0.9 }, in: { color: "fr", bump: "fv" } }] } });
    window.store.setFacesMaterial([0, 1, 2, 3, 4, 5].map((face) => ({ body: "body1", face })), id);
  });
  const faces = await linked();
  const faceMats = faces.mats.slice(1);
  // faces sharing one finish share one material, so this is a group count, not six
  check("the face material links the face graph", faceMats.length >= 1 && faceMats.every((m) => m.sGraph.includes("g_fv")), `${faceMats.filter((m) => m.sGraph.includes("g_fv")).length} of ${faceMats.length}`);
  await page.screenshot({ path: path.join(OUT, "faces.png") });

  // --- save and reload: two different graphs side by side --------------------
  await page.evaluate(() => {
    window.store.setFacesMaterial([0, 1, 2].map((face) => ({ body: "body1", face })), null);
  });
  const reload = await page.evaluate(async () => {
    const json = window.store.toJSON();
    window.store.load(json);
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const b = window.store.buildState;
      if (!b.building && b.result?.bodies?.length >= 1) return true;
    }
    return false;
  });
  check("document reloaded", reload);
  const after = await linked();
  const withFace = after.mats.filter((m) => m.sGraph.includes("g_fv")).length;
  const withBody = after.mats.filter((m) => m.sGraph.includes("g_mt")).length;
  check("after a reload the body and face graphs each link their own", withFace >= 1 && withBody >= 1 && after.mats.length >= 2, `${withBody} body graph, ${withFace} face graph materials`);
  await page.screenshot({ path: path.join(OUT, "reload.png") });

  // --- a wire drawn in the editor ------------------------------------------
  await page.evaluate(() => {
    window.store.setFacesMaterial([0, 1, 2, 3, 4, 5].map((face) => ({ body: "body1", face })), null);
    window.__mid = window.store.addMaterial({ name: "ui", color: "#808080", roughness: 0.5 });
    window.store.setBodiesMaterial(["body1"], window.__mid);
  });
  await linked();
  await page.click('#workspace-toggle [data-workspace="render"]');
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector(`[data-material="${window.__mid}"]`).click());
  await page.waitForTimeout(400);
  await page.click("[data-editgraph]");
  await page.waitForTimeout(600);
  await page.click('[data-add="voronoi"]');
  await page.waitForTimeout(300);
  await page.click('[data-add="ramp"]');
  await page.waitForTimeout(300);
  const [vor, ramp] = await page.evaluate(() => [...document.querySelectorAll("[data-out]")].map((e) => e.getAttribute("data-out")));
  // a click on a wired input disconnects it, so this drags and never clicks the in dot
  const wire = async (src, dst) => {
    await page.locator(`[data-out="${src}"]`).dispatchEvent("pointerdown", { pointerId: 1, button: 0, bubbles: true });
    const box = await page.locator(`[data-in="${dst}"]`).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.up();
  };
  const uiBefore = await linked();
  await wire(vor, `${ramp}:t`);
  await wire(vor, "out:bump");
  await wire(ramp, "out:color");
  await page.waitForTimeout(400);
  const ui = await linked();
  const fn = ui.mats[0].sGraph;
  check("a wire drawn in the editor reaches the linked shader",
    fn.includes(`g_${vor} = sGen(wp, wn, 3`) && fn.includes(`o.tint = g_${ramp}`) && ui.mats[0].program !== uiBefore.mats[0].program);
  await page.screenshot({ path: path.join(OUT, "editor_wired.png") });

  check("no shader compile errors", shaderErrors.length === 0, shaderErrors[0]);
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
