// The High tier chooses its stages from the frame's facts, and every frame it
// cannot serve keeps today's path. At High the composer draws the model alone and
// the overlays are drawn after it on the canvas, with everything given back.
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { HIGH_NEEDS_FULL, HIGH_NEEDS_GPU, HIGH_NEEDS_POWER, resolveRealtimeQuality, stagesFor, type FrameState } from "../../src/viewport/realtimePipeline";
import { PostChain } from "../../src/viewport/scene";
import { DEFAULT_RENDER, setRenderPref } from "../../src/ui/renderPrefs";

function state(over: Partial<FrameState> = {}): FrameState {
  return {
    quality: "high",
    potato: false,
    lowPower: false,
    viewMode: "realtime",
    tracing: false,
    forceRealtime: false,
    motion: false,
    facts: { moving: false, ghosted: false },
    bloom: true,
    blur: true,
    perspective: true,
    passesReady: true,
    ...over,
  };
}

describe("stagesFor", () => {
  it("draws Standard straight to the canvas with no bloom and no blur, through the composer with either", () => {
    expect(stagesFor(state({ quality: "standard", bloom: false, blur: false }))).toEqual({ path: "direct" });
    expect(stagesFor(state({ quality: "standard", blur: false }))).toEqual({ path: "composer" });
    expect(stagesFor(state({ quality: "standard", bloom: false }))).toEqual({ path: "composer" });
    expect(stagesFor(state({ quality: "standard", passesReady: false }))).toEqual({ path: "loading" });
  });

  it("keeps today's path on a low power tier, for a ghosted model and for a frame drawn outside the loop", () => {
    for (const over of [{ lowPower: true }, { facts: { moving: false, ghosted: true } }, { facts: null }]) {
      expect(stagesFor(state({ ...over, bloom: false, blur: false }))).toEqual({ path: "direct" });
      expect(stagesFor(state(over))).toEqual({ path: "composer" });
    }
  });

  it("lists the High stages, bokeh only through a lens and the prepass only while still", () => {
    expect(stagesFor(state())).toEqual({ path: "high", stages: ["prepass", "model", "bokeh", "bloom", "output", "compose"] });
    expect(stagesFor(state({ perspective: false }))).toEqual({ path: "high", stages: ["prepass", "model", "bloom", "output", "compose"] });
    expect(stagesFor(state({ bloom: false }))).toEqual({ path: "high", stages: ["prepass", "model", "bokeh", "output", "compose"] });
    expect(stagesFor(state({ facts: { moving: true, ghosted: false } }))).toEqual({ path: "high", stages: ["model", "bokeh", "bloom", "output", "compose"] });
    expect(stagesFor(state({ bloom: false, blur: false }))).toEqual({ path: "high", stages: ["prepass", "model", "output", "compose"] });
  });

  it("is not High before the passes have loaded", () => {
    expect(stagesFor(state({ passesReady: false }))).toEqual({ path: "loading" });
    expect(stagesFor(state({ passesReady: false, bloom: false, blur: false }))).toEqual({ path: "direct" });
  });

  it("lets potato, matcap, the traced overlay and the low power motion draw go first, as render does", () => {
    expect(stagesFor(state({ potato: true, viewMode: "matcap" }))).toEqual({ path: "potato" });
    expect(stagesFor(state({ viewMode: "matcap" }))).toEqual({ path: "matcap" });
    expect(stagesFor(state({ viewMode: "matcap", forceRealtime: true })).path).toBe("high");
    expect(stagesFor(state({ viewMode: "pathtraced", tracing: true }))).toEqual({ path: "overlay" });
    expect(stagesFor(state({ viewMode: "pathtraced", tracing: true, forceRealtime: true })).path).toBe("high");
    expect(stagesFor(state({ motion: true, lowPower: true }))).toEqual({ path: "motion" });
    expect(stagesFor(state({ motion: true })).path).toBe("high");
  });
});

describe("resolveRealtimeQuality", () => {
  const full = { lowPower: false, auto: false, software: false };

  it("gives High only where it was chosen and the tier offers it", () => {
    expect(resolveRealtimeQuality("high", full)).toEqual({ quality: "high", reason: null });
    expect(resolveRealtimeQuality("standard", full)).toEqual({ quality: "standard", reason: null });
    expect(resolveRealtimeQuality("auto", full)).toEqual({ quality: "standard", reason: null });
  });

  it("gives Standard with a reason on Light, Potato, a weak machine and a software renderer", () => {
    expect(resolveRealtimeQuality("high", { ...full, lowPower: true })).toEqual({ quality: "standard", reason: HIGH_NEEDS_FULL });
    expect(resolveRealtimeQuality("high", { lowPower: true, auto: true, software: false })).toEqual({ quality: "standard", reason: HIGH_NEEDS_POWER });
    expect(resolveRealtimeQuality("high", { lowPower: true, auto: true, software: true })).toEqual({ quality: "standard", reason: HIGH_NEEDS_GPU });
    expect(resolveRealtimeQuality("high", { ...full, software: true })).toEqual({ quality: "standard", reason: HIGH_NEEDS_GPU });
  });

  it("still names the refusal when High was not chosen, for the row's tooltip", () => {
    expect(resolveRealtimeQuality("auto", { ...full, lowPower: true }).reason).toBe(HIGH_NEEDS_FULL);
  });
});

interface Draw { target: unknown; mask: number; background: unknown; autoClear: boolean; autoUpdate: boolean; materials: unknown[] }

function highChain() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x203040);
  const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.3 }));
  body.userData.owner = "b1";
  const glass = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ transmission: 1 }));
  glass.userData.owner = "b2";
  const handle = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
  handle.layers.set(7);
  // Like a section cap: a hook that writes its own material's uniforms before each draw.
  const cap = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShaderMaterial({ uniforms: { pitch: { value: 0 } }, colorWrite: false }));
  cap.onBeforeRender = () => { (cap.material as THREE.ShaderMaterial).uniforms["pitch"]!.value = 9; };
  scene.add(body, glass, handle, cap);
  let target: unknown = null;
  const clear = new THREE.Color(0x0b0912);
  const draws: Draw[] = [];
  const camera = new THREE.PerspectiveCamera();
  camera.layers.enableAll();
  const full = camera.layers.mask;
  const compiles: { target: unknown; materials: unknown[] }[] = [];
  let release: () => void = () => {};
  const renderer = {
    compileAsync: (sc: THREE.Scene) => {
      const materials: unknown[] = [];
      sc.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && o.layers.test(camera.layers)) materials.push((o as THREE.Mesh).material); });
      compiles.push({ target, materials });
      return new Promise<void>((resolve) => { const was = release; release = () => { was(); resolve(); }; });
    },
    toneMapping: THREE.NeutralToneMapping,
    toneMappingExposure: 1,
    autoClear: true,
    shadowMap: { autoUpdate: true, render: () => {} },
    getPixelRatio: () => 1,
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(64, 32),
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => { target = t; },
    getClearColor: (c: THREE.Color) => c.copy(clear),
    getClearAlpha: () => 1,
    setClearColor: (c: THREE.Color | number) => { clear.set(c); },
    clear: () => {},
    clearDepth: () => {},
    clearStencil: () => {},
    render: (s: THREE.Scene, c: THREE.Camera) => {
      s.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && o.layers.test(c.layers)) o.onBeforeRender(renderer as unknown as THREE.WebGLRenderer, s, c, m.geometry, m.material as THREE.Material, new THREE.Group());
      });
      draws.push({
        target, mask: c.layers.mask, background: s.background, autoClear: renderer.autoClear,
        autoUpdate: renderer.shadowMap.autoUpdate, materials: [body.material, glass.material, handle.material],
      });
      if (throwOn === draws.length) throw new Error("lost context");
    },
  };
  let throwOn = 0;
  const post = new PostChain(renderer as unknown as THREE.WebGLRenderer, scene, () => false, () => false);
  const composed: number[] = [];
  const composer = {
    passes: [] as unknown[],
    readBuffer: { name: "read" },
    render: () => composed.push(camera.layers.mask),
    setPixelRatio: () => {},
    setSize: () => {},
  };
  const internals = post as unknown as { composer: unknown; passes: unknown };
  internals.composer = composer;
  internals.passes = {};
  post.realtimeQuality = "high";
  setRenderPref("bloom", 0);
  setRenderPref("focusBlur", 0);
  const originals = [body.material, glass.material, handle.material];
  return { post, scene, camera, full, draws, composed, compiles, release: () => release(), renderer, originals, body, glass, handle, cap, throwAt: (n: number) => { throwOn = n; } };
}

describe("PostChain quality switch", () => {
  afterEach(() => {
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
    setRenderPref("focusBlur", DEFAULT_RENDER.focusBlur);
  });

  const facts = { moving: false, ghosted: false };
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("keeps drawing the old stages until the High programs have linked, then swaps", async () => {
    const c = highChain();
    c.post.realtimeQuality = "standard";
    const swapped = c.post.switchRealtimeQuality("high", c.camera);
    await tick();
    expect(c.compiles).toHaveLength(2);
    c.post.render(c.camera, false, false, facts);
    expect(c.post.highStages).toBeNull();
    expect(c.composed).toEqual([]);
    expect(c.draws.map((d) => d.background)).toEqual([c.scene.background]);
    c.release();
    await swapped;
    c.post.render(c.camera, false, false, facts);
    expect(c.post.highStages).toEqual(["prepass", "model", "output", "compose"]);
  });

  it("links the prepass twins into the prepass target and the depth twins on the canvas, the model's own materials left alone", async () => {
    const c = highChain();
    c.post.realtimeQuality = "standard";
    const swapped = c.post.switchRealtimeQuality("high", c.camera);
    await tick();
    const [prepass, overlay] = c.compiles as [(typeof c.compiles)[number], (typeof c.compiles)[number]];
    expect(prepass.target).not.toBeNull();
    expect(prepass.materials).toHaveLength(1);
    expect(prepass.materials[0]).toBeInstanceOf(THREE.MeshNormalMaterial);
    expect(overlay.target).toBeNull();
    expect(overlay.materials.filter((m) => (m as THREE.Material).colorWrite === false)).toHaveLength(overlay.materials.length - 1);
    expect([c.body.material, c.glass.material, c.handle.material]).toEqual(c.originals);
    c.release();
    await swapped;
  });

  it("drops back to Standard at once, and a High still waiting does not swap in afterwards", async () => {
    const c = highChain();
    c.post.realtimeQuality = "standard";
    const high = c.post.switchRealtimeQuality("high", c.camera);
    await tick();
    await c.post.switchRealtimeQuality("standard", c.camera);
    c.release();
    await high;
    c.post.render(c.camera, false, false, facts);
    expect(c.post.highStages).toBeNull();
    expect(c.post.prepassTarget).toBeNull();
  });

  it("does not link anything when the quality is already the one asked for", async () => {
    const c = highChain();
    await c.post.switchRealtimeQuality("high", c.camera);
    expect(c.compiles).toEqual([]);
  });
});

describe("PostChain at High", () => {
  afterEach(() => {
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
    setRenderPref("focusBlur", DEFAULT_RENDER.focusBlur);
  });

  it("draws the prepass and the model on layer 0 and the overlays with the full mask over the canvas", () => {
    const c = highChain();
    c.post.render(c.camera, false, false, { moving: false, ghosted: false });
    expect(c.post.highStages).toEqual(["prepass", "model", "output", "compose"]);
    expect(c.composed).toEqual([1]);
    expect(c.draws).toHaveLength(2);
    const [prepass, compose] = c.draws as [Draw, Draw];
    expect(prepass.target).toBe(c.post.prepassTarget);
    expect(prepass.mask).toBe(1);
    expect(prepass.background).toBeNull();
    expect(prepass.autoUpdate).toBe(false);
    expect(prepass.materials[0]).toBeInstanceOf(THREE.MeshNormalMaterial);
    expect(compose.target).toBeNull();
    expect(compose.mask).toBe(c.full);
    expect(compose.background).toBeNull();
    expect(compose.autoClear).toBe(false);
    expect(compose.autoUpdate).toBe(false);
    expect((compose.materials[0] as THREE.Material).colorWrite).toBe(false);
    expect((compose.materials[1] as THREE.Material).colorWrite).toBe(false);
    expect(compose.materials[2]).toBe(c.originals[2]);
    expect(c.glass.visible).toBe(true);
    expect((c.cap.material as THREE.ShaderMaterial).uniforms["pitch"]!.value).toBe(0);
  });

  it("gives back the materials, the mask, the background, the clear and the shadow switch when a draw throws", () => {
    for (const at of [1, 2]) {
      const c = highChain();
      const background = c.scene.background;
      c.throwAt(at);
      expect(() => c.post.render(c.camera, false, false, { moving: false, ghosted: false })).toThrow("lost context");
      expect([c.body.material, c.glass.material, c.handle.material]).toEqual(c.originals);
      expect(c.camera.layers.mask).toBe(c.full);
      expect(c.scene.background).toBe(background);
      expect(c.renderer.autoClear).toBe(true);
      expect(c.renderer.shadowMap.autoUpdate).toBe(true);
      expect(c.glass.visible).toBe(true);
    }
  });

  it("skips the prepass while moving and keeps today's path for a ghosted model or a picture", () => {
    const c = highChain();
    c.post.render(c.camera, true, false, { moving: true, ghosted: false });
    expect(c.post.highStages).toEqual(["model", "output", "compose"]);
    expect(c.draws.map((d) => d.mask)).toEqual([c.full]);
    for (const facts of [{ moving: false, ghosted: true }, undefined]) {
      const g = highChain();
      g.post.render(g.camera, false, false, facts);
      expect(g.post.highStages).toBeNull();
      expect(g.composed).toEqual([]);
      expect(g.draws.map((d) => [d.mask, d.background])).toEqual([[g.full, g.scene.background]]);
    }
  });

  it("goes back to the Standard frame once the quality is set back", () => {
    const c = highChain();
    c.post.render(c.camera, false, false, { moving: false, ghosted: false });
    c.post.realtimeQuality = "standard";
    c.post.render(c.camera, false, false, { moving: false, ghosted: false });
    expect(c.post.highStages).toBeNull();
    expect(c.post.prepassTarget).toBeNull();
    expect(c.composed).toEqual([1]);
  });
});
