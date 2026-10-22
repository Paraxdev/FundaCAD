// The High tier of the realtime frame, reached through the dev switch: edge lines
// and the selection glow drawn over the model look as on the Standard frame, a
// lit gizmo stays lit, the prepass holds face normals, roughness and depth, the
// section view clips it, a motion start and stop compiles nothing, and per stage
// GPU times are logged.
//
// Usage (from the repo root, vite + engine `fundacad-engine --ws` running):
//   SC_TOKEN=<engine token> SC_CHROME=<chrome exe> [SC_URL=http://localhost:5173/] \
//     [SC_ENGINE_PORT=8765] [SC_ANGLE=d3d11] node e2e/realtime_high_e2e.cjs [outDir]
// SC_BASELINE=<dir> compares the Standard frames with the ones in that dir; with
// SC_WRITE_BASELINE=1 the script only writes them, for a build without High.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SC_TOKEN || "";
const EXE = process.env.SC_CHROME || "/usr/bin/chromium";
const URL = process.env.SC_URL || "http://localhost:5173/";
const PORT = process.env.SC_ENGINE_PORT || "8765";
const ANGLE = process.env.SC_ANGLE || "d3d11";
const OUT = path.resolve(process.argv[2] || "realtime_high_shots");
const BASELINE = process.env.SC_BASELINE || "";
const WRITE_BASELINE = process.env.SC_WRITE_BASELINE === "1";
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
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
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

    const body = await page.evaluate(async () => {
      const s = window.store;
      s.addFeature({ id: s.nextId(), type: "box", length: 20, width: 20, height: 20 });
      await s.rebuildNow();
      for (let i = 0; i < 300; i++) {
        const b = s.buildState;
        if (!b.building && b.result?.bodies?.length >= 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return s.buildState.result?.bodies?.[0]?.id ?? null;
    });
    check("the box built", !!body, String(body));
    await page.evaluate(() => window.__fundacad.handleAction("fit"));
    await page.waitForTimeout(2500);

    // The frame the loop draws, read back in the same task so the drawing buffer is still there.
    await page.evaluate(() => {
      const v = window.viewport, gl = v.scene.renderer.getContext();
      window.__rt = {
        grab(facts = { moving: false, ghosted: false }) {
          v.scene.post.render(v.rig.active, false, false, facts);
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
          const a = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a);
          return { w, h, a };
        },
        settle: (n) => new Promise((res) => {
          let i = 0;
          const step = () => { v.requestRender(); if (++i >= n) res(); else requestAnimationFrame(step); };
          requestAnimationFrame(step);
        }),
        frames: {},
      };
    });
    const wait = (ms) => page.waitForTimeout(ms);
    const quality = async (q) => { await page.evaluate((q) => window.__fundacad.setRealtimeQuality?.(q), q); await wait(300); };
    const kinds = async (k) => {
      await page.evaluate((k) => { const v = window.viewport; v.overlays = { on: true, kinds: { ...v.overlays.kinds, ...k } }; v.requestRender(); }, k);
      await wait(400);
    };
    const select = async (ids) => { await page.evaluate((ids) => window.viewport.setSelectedBodies(ids), ids); await wait(400); };
    const grab = (name) => page.evaluate((name) => { window.__rt.frames[name] = window.__rt.grab(); return true; }, name);
    // Pixels where two frames differ by more than 30 summed over RGB.
    const maskOf = (a, b) => page.evaluate(([a, b]) => {
      const A = window.__rt.frames[a].a, B = window.__rt.frames[b].a, m = [];
      for (let i = 0; i < A.length / 4; i++) {
        const j = i * 4;
        if (Math.abs(A[j] - B[j]) + Math.abs(A[j + 1] - B[j + 1]) + Math.abs(A[j + 2] - B[j + 2]) > 30) m.push(i);
      }
      window.__rt.frames[`mask:${a}:${b}`] = m;
      return m.length;
    }, [a, b]);
    const stat = (a, b, mask) => page.evaluate(([a, b, mask]) => {
      const A = window.__rt.frames[a].a, B = window.__rt.frames[b].a;
      const idx = mask ? window.__rt.frames[mask] : null;
      const n = idx ? idx.length : A.length / 4;
      let s = 0, mx = 0;
      for (let k = 0; k < n; k++) {
        const i = idx ? idx[k] : k;
        for (let c = 0; c < 3; c++) { const d = Math.abs(A[i * 4 + c] - B[i * 4 + c]); s += d; if (d > mx) mx = d; }
      }
      return { n, mad: +(s / (n * 3 || 1)).toFixed(3), max: mx };
    }, [a, b, mask]);
    const saveRaw = async (name, file) => {
      const b64 = await page.evaluate((name) => {
        const f = window.__rt.frames[name];
        let s = "";
        for (let i = 0; i < f.a.length; i += 0x8000) s += String.fromCharCode.apply(null, f.a.subarray(i, i + 0x8000));
        return JSON.stringify({ w: f.w, h: f.h, a: btoa(s) });
      }, name);
      fs.writeFileSync(file, b64);
    };
    const loadRaw = (name, file) => page.evaluate(([name, json]) => {
      const f = JSON.parse(json), s = atob(f.a), a = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
      window.__rt.frames[name] = { w: f.w, h: f.h, a };
      return f.w * f.h;
    }, [name, fs.readFileSync(file, "utf8")]);

    // Standard identity: the direct frame of a matte box, and the composer frame with bloom.
    await page.evaluate(() => window.__fundacad.setRenderPref("bloom", 0));
    await wait(600);
    await grab("std");
    await page.evaluate(() => { window.__fundacad.setRenderPref("bloom", 0.4); window.viewport.scene.post.bloomable = true; window.viewport.scene.post.glows = true; });
    await wait(600);
    await grab("stdBloom");
    await page.evaluate(() => window.__fundacad.setRenderPref("bloom", 0));
    await wait(600);
    if (WRITE_BASELINE) {
      await saveRaw("std", path.join(OUT, "standard.json"));
      await saveRaw("stdBloom", path.join(OUT, "standard_bloom.json"));
      console.log(`wrote the Standard baseline to ${OUT}`);
      return;
    }
    if (BASELINE) {
      for (const [name, file] of [["std", "standard.json"], ["stdBloom", "standard_bloom.json"]]) {
        await loadRaw(`base:${name}`, path.join(BASELINE, file));
        const s = await stat(name, `base:${name}`);
        check(`Standard ${name} matches the build without High`, s.mad < 0.5, JSON.stringify(s));
      }
    }

    // A first selection switches the selection mode, which draws the edges differently.
    await select([body]);
    await select([]);
    await grab("std");
    await kinds({ edges: false });
    await grab("stdNoEdges");
    await kinds({ edges: true });
    const edges = await maskOf("std", "stdNoEdges");
    await select([body]);
    await grab("stdSel");
    const glow = await maskOf("stdSel", "std");
    check("the edge and glow masks are not empty", edges > 200 && glow > 200, `edges ${edges}, glow ${glow}`);

    // A lit sphere on the gizmo layer, which only keeps its light if the compose draws with layer 0 in the mask.
    await page.evaluate(async () => {
      const THREE = await import("/node_modules/three/build/three.module.js");
      const v = window.viewport;
      const m = new THREE.Mesh(new THREE.SphereGeometry(4, 32, 16), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      m.layers.set(7);
      m.position.set(0, 0, 18);
      m.updateMatrixWorld(true);
      v.scene.scene.add(m);
      const p = m.position.clone().project(v.rig.active);
      const gl = v.scene.renderer.getContext();
      window.__rt.gizmo = { mesh: m, x: Math.round((p.x * 0.5 + 0.5) * gl.drawingBufferWidth), y: Math.round((p.y * 0.5 + 0.5) * gl.drawingBufferHeight) };
    });
    await select([]);
    await grab("stdGizmo");

    await quality("high");
    await grab("high");
    const stages = await page.evaluate(() => window.viewport.scene.post.highStages);
    check("High draws the prepass", Array.isArray(stages) && stages.includes("prepass"), JSON.stringify(stages));
    const lit = await page.evaluate(() => {
      const g = window.__rt.gizmo, at = (f) => { const i = (g.y * window.__rt.frames[f].w + g.x) * 4, a = window.__rt.frames[f].a; return [a[i], a[i + 1], a[i + 2]]; };
      return { std: at("stdGizmo"), high: at("high") };
    });
    check("a lit gizmo is as lit at High", lit.std.every((c, i) => Math.abs(c - lit.high[i]) <= 4) && lit.std[0] > 140, JSON.stringify(lit));
    await page.evaluate(() => { const g = window.__rt.gizmo; g.mesh.removeFromParent(); g.mesh.geometry.dispose(); g.mesh.material.dispose(); });
    await grab("high");
    const e = await stat("high", "std", "mask:std:stdNoEdges");
    check("edge line pixels at High match Standard", e.mad < 1.5 && e.max <= 16, JSON.stringify(e));
    const whole = await stat("high", "std");
    console.log(`  info  whole frame High vs Standard ${JSON.stringify(whole)}`);
    await select([body]);
    await grab("highSel");
    const g = await stat("highSel", "stdSel", "mask:stdSel:std");
    check("selection glow pixels at High match Standard", g.mad < 1.5 && g.max <= 16, JSON.stringify(g));
    await select([]);

    // The prepass with and without a section plane through the box's middle.
    const prepass = () => page.evaluate(() => {
      const v = window.viewport, post = v.scene.post, r = v.scene.renderer;
      window.__rt.grab();
      const t = post.prepassTarget;
      const buf = new Uint16Array(t.width * t.height * 4);
      r.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
      let written = 0;
      for (let i = 0; i < buf.length; i += 4) if (buf[i] || buf[i + 1] || buf[i + 2] || buf[i + 3]) written++;
      const far = [];
      for (const y of [-9.5, 9.5]) for (const z of [-9.5, 9.5]) {
        const p = new v.rig.active.position.constructor(9.5, y, z).project(v.rig.active);
        const px = Math.round((p.x * 0.5 + 0.5) * t.width), py = Math.round((p.y * 0.5 + 0.5) * t.height);
        const i = (py * t.width + px) * 4;
        far.push(buf[i] || buf[i + 1] || buf[i + 2] || buf[i + 3] ? 1 : 0);
      }
      return { written, far };
    });
    const open = await prepass();

    // What the prepass holds: view space normals of the box faces, roughness in
    // alpha and depth exactly where something was written.
    const content = await page.evaluate(async () => {
      const THREE = await import("/node_modules/three/build/three.module.js");
      const v = window.viewport, post = v.scene.post, r = v.scene.renderer, cam = v.rig.active;
      const h2f = (h) => { const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? NaN : s * 2 ** (e - 15) * (1 + f / 1024); };
      const read = () => {
        window.__rt.grab();
        const t = post.prepassTarget, buf = new Uint16Array(t.width * t.height * 4);
        r.readRenderTargetPixels(t, 0, 0, t.width, t.height, buf);
        return { t, buf };
      };
      const alphaErr = (buf, want) => {
        let worst = 0;
        for (let i = 0; i < buf.length; i += 4) if (buf[i] || buf[i + 1] || buf[i + 2] || buf[i + 3]) worst = Math.max(worst, Math.abs(h2f(buf[i + 3]) - want));
        return +worst.toFixed(4);
      };
      let mesh = null;
      v.scene.modelGroup.traverse((o) => { if (!mesh && o.isMesh && o.userData.owner !== undefined) mesh = o; });
      const rough = mesh.material.roughness;
      const { t, buf } = read();
      let written = 0, lmin = 9, lmax = -9;
      const clusters = [];
      for (let i = 0; i < buf.length; i += 4) {
        if (!(buf[i] || buf[i + 1] || buf[i + 2] || buf[i + 3])) continue;
        written++;
        const n = [0, 1, 2].map((k) => h2f(buf[i + k]) * 2 - 1);
        const l = Math.hypot(...n);
        lmin = Math.min(lmin, l); lmax = Math.max(lmax, l);
        let c = clusters.find((c) => Math.hypot(c.n[0] - n[0], c.n[1] - n[1], c.n[2] - n[2]) < 0.05);
        if (!c) clusters.push((c = { n, count: 0 }));
        c.count++;
      }
      cam.updateMatrixWorld();
      const nm = new THREE.Matrix3().getNormalMatrix(cam.matrixWorldInverse);
      const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((w) => new THREE.Vector3(...w).applyMatrix3(nm).normalize());
      const faceErr = clusters.filter((c) => c.count > 500).map((c) => +Math.min(...faces.map((f) => Math.hypot(f.x - c.n[0], f.y - c.n[1], f.z - c.n[2]))).toFixed(4));
      const alpha = alphaErr(buf, rough);
      mesh.material.roughness = 0.2;
      const followed = alphaErr(read().buf, 0.2);
      mesh.material.roughness = rough;
      read();
      const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { d: { value: t.depthTexture } },
        vertexShader: "varying vec2 u; void main(){ u = uv; gl_Position = vec4(position.xy, 0., 1.); }",
        fragmentShader: "uniform sampler2D d; varying vec2 u; void main(){ gl_FragColor = vec4(texture2D(d, u).r, 0., 0., 1.); }",
        depthTest: false, depthWrite: false,
      }));
      const qs = new THREE.Scene();
      qs.add(q);
      const ft = new THREE.WebGLRenderTarget(t.width, t.height, { type: THREE.FloatType });
      const prev = r.getRenderTarget();
      r.setRenderTarget(ft);
      r.render(qs, new THREE.OrthographicCamera());
      r.setRenderTarget(prev);
      const db = new Float32Array(t.width * t.height * 4);
      r.readRenderTargetPixels(ft, 0, 0, t.width, t.height, db);
      ft.dispose(); q.geometry.dispose(); q.material.dispose();
      let depthWrong = 0;
      for (let p = 0; p < t.width * t.height; p++) {
        const i = p * 4, w = buf[i] || buf[i + 1] || buf[i + 2] || buf[i + 3];
        if (w ? db[i] >= 1 : db[i] < 0.99999) depthWrong++;
      }
      return { written, len: [+lmin.toFixed(4), +lmax.toFixed(4)], faceErr, rough, alpha, followed, depthWrong };
    });
    check("the prepass normals are unit length", content.written > 1000 && content.len[0] > 0.99 && content.len[1] < 1.01, JSON.stringify(content.len));
    check("each prepass normal is a box face's view space normal", content.faceErr.length > 0 && content.faceErr.every((e) => e < 0.01), JSON.stringify(content.faceErr));
    check("the prepass alpha is the body's roughness and follows a change", content.alpha < 0.002 && content.followed < 0.002, JSON.stringify({ rough: content.rough, alpha: content.alpha, followed: content.followed }));
    check("the prepass depth is written exactly where its colour is", content.depthWrong === 0, `${content.depthWrong} px`);
    await page.evaluate(async () => {
      const THREE = await import("/node_modules/three/build/three.module.js");
      window.viewport.setSectionView({ plane: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0), ghost: 0 });
    });
    await wait(600);
    const cut = await prepass();
    await grab("highCut");
    await quality("standard");
    await grab("stdCut");
    await quality("high");
    const capped = await stat("highCut", "stdCut");
    check("the sectioned frame at High matches Standard", capped.mad < 0.5 && capped.max <= 16, JSON.stringify(capped));
    await page.evaluate(() => window.viewport.setSectionView(null));
    await wait(600);
    const cleared = open.far.some((f, i) => f === 1 && cut.far[i] === 0);
    check("the section view clips the prepass", open.written > 1000 && cut.written < open.written * 0.85 && cleared, `open ${JSON.stringify(open)}, cut ${JSON.stringify(cut)}`);

    // Programs across a motion start and stop, after still frames have compiled the High set.
    for (let i = 0; i < 40; i++) await page.evaluate(() => window.__rt.grab());
    const programs = await page.evaluate(() => {
      const r = window.viewport.scene.renderer, before = r.info.programs.length;
      for (let i = 0; i < 10; i++) window.__rt.grab({ moving: true, ghosted: false });
      const moving = r.info.programs.length;
      for (let i = 0; i < 10; i++) window.__rt.grab();
      return { before, moving, after: r.info.programs.length };
    });
    check("a motion start and stop at High compiles nothing", programs.before === programs.moving && programs.moving === programs.after, JSON.stringify(programs));

    await page.evaluate(() => window.__rt.settle(60));
    await wait(500);
    const times = await page.evaluate(() => window.viewport.passTimes());
    console.log(`  info  GPU ms per stage at High ${JSON.stringify(times)}`);
    const timer = await page.evaluate(() => window.viewport.scene.post.timer.kind);
    if (timer === "timer-query") {
      check("the stages are timed", ["prepass", "main", "composer", "compose"].every((k) => typeof times[k] === "number"), JSON.stringify(times));
    } else {
      console.log(`  info  per stage GPU times need EXT_disjoint_timer_query_webgl2, kind ${timer}`);
    }

    await quality("standard");
    await grab("stdAgain");
    const back = await stat("stdAgain", "std");
    check("Standard again after High is the Standard frame", back.mad < 0.5, JSON.stringify(back));
  } finally {
    await browser.close();
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
})();
