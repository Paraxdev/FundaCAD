// The composer path has to draw the same background as the canvas path, keep its
// passes while the camera moves unless the machine is on a low power tier, and
// follow the renderer's pixel ratio.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { PostChain, SHADOW_MAP_TYPE } from "../../src/viewport/scene";
import { composerClearColor, neutralToneMap } from "../../src/viewport/composerColor";
import { BACKGROUND_COLOR, DEFAULT_RENDER, setRenderPref } from "../../src/ui/renderPrefs";

function encode(lin: number): number {
  const c = lin < 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
  return Math.round(THREE.MathUtils.clamp(c, 0, 1) * 255);
}

describe("composerClearColor", () => {
  const backgrounds = [0x0b0912, 0x1a1d21, ...Object.values(BACKGROUND_COLOR), 0xf4f5f7, 0xffffff, 0x203040, 0x806020];
  for (let v = 0; v <= 255; v += 17) backgrounds.push(v * 0x010101);
  // Tints only up to mid bright: near white, Neutral desaturates so hard that a strong tint has no preimage.
  for (let v = 0; v <= 204; v += 17) backgrounds.push((v << 16) | (Math.round(v * 0.6) << 8) | Math.min(255, v + 40));

  it("comes back as the same background once the OutputPass tone maps and encodes it", () => {
    for (const hex of backgrounds) {
      const bg = new THREE.Color(hex);
      for (const exposure of [1, 1.6]) {
        const clear = composerClearColor(bg, THREE.NeutralToneMapping, exposure);
        const shown = neutralToneMap([clear.r * exposure, clear.g * exposure, clear.b * exposure]);
        const want = [bg.r, bg.g, bg.b].map(encode);
        const got = shown.map(encode);
        for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!), `#${hex.toString(16)} at ${exposure}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("leaves the colour alone when nothing is tone mapped", () => {
    const bg = new THREE.Color(0x0b0912);
    expect(composerClearColor(bg, THREE.NoToneMapping, 1).equals(bg)).toBe(true);
  });
});

function fakeComposer() {
  const calls: string[] = [];
  const readBuffer = { name: "read" };
  return {
    calls,
    readBuffer,
    composer: {
      passes: [] as unknown[],
      readBuffer,
      render: () => calls.push("render"),
      setPixelRatio: (pr: number) => calls.push(`ratio ${pr}`),
      setSize: () => {},
    },
  };
}

function chain(lowPower: boolean) {
  const scene = new THREE.Scene();
  let target: unknown = null;
  let ratio = 2;
  const clear = new THREE.Color(0x0b0912);
  const clears: { target: unknown; color: THREE.Color }[] = [];
  const direct: unknown[] = [];
  const cleared: { target: unknown; color: THREE.Color }[] = [];
  const renderer = {
    toneMapping: THREE.NeutralToneMapping,
    toneMappingExposure: 1,
    getPixelRatio: () => ratio,
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(64, 32),
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => { target = t; },
    getClearColor: (c: THREE.Color) => c.copy(clear),
    getClearAlpha: () => 1,
    setClearColor: (c: THREE.Color) => { clear.copy(c); clears.push({ target, color: c.clone() }); },
    clear: () => cleared.push({ target, color: clear.clone() }),
    render: (s: unknown) => direct.push(s),
  } as unknown as THREE.WebGLRenderer;
  const post = new PostChain(renderer, scene, () => false, () => lowPower);
  const f = fakeComposer();
  (post as unknown as { composer: unknown }).composer = f.composer;
  return { post, f, clears, cleared, direct, clear, setRatio: (r: number) => { ratio = r; } };
}

describe("PostChain composer frames", () => {
  it("clears the composer's target with the inverse tone mapped background, glass with the plain one", () => {
    setRenderPref("bloom", 0.4);
    const c = chain(false);
    const bg = c.clear.clone();
    c.post.render(new THREE.PerspectiveCamera());
    expect(c.f.calls).toContain("render");
    expect(c.cleared).toHaveLength(1);
    expect(c.cleared[0]!.target).toBe(c.f.readBuffer);
    expect(c.cleared[0]!.color.equals(composerClearColor(bg, THREE.NeutralToneMapping, 1))).toBe(true);
    // The value the transmission pass clears from is cached at the last setClearColor before the passes.
    expect(c.clears.map((x) => [x.target, x.color.getHex()])).toEqual([
      [c.f.readBuffer, composerClearColor(bg, THREE.NeutralToneMapping, 1).getHex()],
      [c.f.readBuffer, bg.getHex()],
      [null, bg.getHex()],
    ]);
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
  });

  it("keeps bloom on while the camera moves unless the machine is on a low power tier", () => {
    setRenderPref("bloom", 0.4);
    const live = chain(false);
    live.post.render(new THREE.PerspectiveCamera(), true);
    expect(live.f.calls).toContain("render");
    const low = chain(true);
    low.post.render(new THREE.PerspectiveCamera(), true);
    expect(low.f.calls).not.toContain("render");
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
  });

  it("keeps a light ground below the bloom threshold at the top of the slider", () => {
    setRenderPref("bloom", 1);
    for (const hex of [0xeee8d5, 0xf4f5f7, 0xffffff, ...Object.values(BACKGROUND_COLOR)]) {
      const c = chain(false);
      c.clear.set(hex);
      const bloom = { enabled: true, strength: 0, radius: 0, threshold: 0, setSize: () => {} };
      (c.post as unknown as { bloom: unknown }).bloom = bloom;
      c.post.render(new THREE.PerspectiveCamera());
      const ground = c.cleared[0]!.color;
      const luma = 0.2126729 * ground.r + 0.7151522 * ground.g + 0.072175 * ground.b;
      // smoothWidth of UnrealBloomPass's high pass is 0.01, above that a texel blooms in full.
      expect(bloom.threshold, `#${hex.toString(16)}`).toBeGreaterThan(luma + 0.01);
    }
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
  });

  it("sizes the glow at CSS size when the chain is built at a pixel ratio above 1", async () => {
    const c = chain(false);
    const r = c.post as unknown as { renderer: Record<string, unknown>; passes: unknown; composer: unknown; build(): void; bloom: { renderTargetBright: { width: number } } };
    r.renderer.getSize = (v: THREE.Vector2) => v.set(600, 400);
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { BokehPass }, { OutputPass }] = await Promise.all([
      import("three/examples/jsm/postprocessing/EffectComposer.js"),
      import("three/examples/jsm/postprocessing/RenderPass.js"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
      import("three/examples/jsm/postprocessing/BokehPass.js"),
      import("three/examples/jsm/postprocessing/OutputPass.js"),
    ]);
    r.passes = { EffectComposer, RenderPass, UnrealBloomPass, BokehPass, OutputPass };
    r.composer = null;
    c.post.setSize(600, 400);
    r.build();
    // UnrealBloomPass halves what setSize gets: 300 at CSS size, 600 at the ratio of 2.
    expect(r.bloom.renderTargetBright.width).toBe(300);
    // A picture four times the view's size keeps the view's glow width.
    c.post.setSize(2400, 1600, 4);
    expect(r.bloom.renderTargetBright.width).toBe(300);
    c.post.setSize(600, 400);
    expect(r.bloom.renderTargetBright.width).toBe(300);
  });

  it("follows the renderer's pixel ratio", () => {
    setRenderPref("bloom", 0.4);
    const c = chain(false);
    const camera = new THREE.PerspectiveCamera();
    c.post.render(camera);
    c.setRatio(0.75);
    c.post.render(camera);
    c.post.render(camera);
    expect(c.f.calls.filter((s) => s.startsWith("ratio"))).toEqual(["ratio 2", "ratio 0.75"]);
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
  });
});

describe("PostChain composer frame that redraws the shadow maps", () => {
  it("leaves the clear the glass transmission buffer reads at the background, not the shadow pass's white", () => {
    setRenderPref("bloom", 0.4);
    const bg = new THREE.Color(0x0b0912);
    // WebGLState's cached clear value, which three's shadow pass sets to white and leaves there.
    const cache = new THREE.Color();
    const seenByGlass: number[] = [];
    let target: unknown = null;
    const renderer = {
      toneMapping: THREE.NeutralToneMapping,
      toneMappingExposure: 1,
      getPixelRatio: () => 1,
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(64, 32),
      getRenderTarget: () => target,
      setRenderTarget: (t: unknown) => { target = t; },
      getClearColor: (c: THREE.Color) => c.copy(bg),
      getClearAlpha: () => 1,
      setClearColor: (c: THREE.Color) => { cache.copy(c); },
      clear: () => {},
      shadowMap: { enabled: true, autoUpdate: true, needsUpdate: false, render: () => { cache.setRGB(1, 1, 1); } },
    } as unknown as THREE.WebGLRenderer;
    const post = new PostChain(renderer, new THREE.Scene(), () => false, () => false);
    const f = fakeComposer();
    f.composer.render = () => {
      renderer.shadowMap.render([], new THREE.Scene(), new THREE.PerspectiveCamera());
      seenByGlass.push(cache.getHex());
      return seenByGlass.length;
    };
    (post as unknown as { composer: unknown }).composer = f.composer;
    const own = renderer.shadowMap.render;
    post.render(new THREE.PerspectiveCamera());
    expect(seenByGlass).toEqual([bg.getHex()]);
    expect(renderer.shadowMap.render).toBe(own);
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
  });
});

describe("three internals the composer clear relies on", () => {
  // The transmission pass clears from the value WebGLState cached at the last
  // setClearColor, converted for the target bound then, and only a GPU shows it.
  // Bumping three means running e2e/bloom_e2e.cjs on a GPU Chrome, then this number.
  it("is still the three release e2e/bloom_e2e.cjs was run against", () => {
    expect(THREE.REVISION).toBe("186");
  });
});

describe("shadow map type", () => {
  it("is one this three keeps instead of rewriting on the first shadowed frame", () => {
    expect([THREE.BasicShadowMap, THREE.PCFShadowMap, THREE.VSMShadowMap]).toContain(SHADOW_MAP_TYPE);
  });
});

describe("PostChain composer frame that throws inside a pass", () => {
  it("does not leave the pass's material override on the scene for later frames", () => {
    setRenderPref("bloom", 0.4);
    const scene = new THREE.Scene();
    const renderer = {
      toneMapping: THREE.NeutralToneMapping,
      toneMappingExposure: 1,
      getPixelRatio: () => 1,
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(64, 32),
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      getClearColor: (c: THREE.Color) => c.set(0x0b0912),
      getClearAlpha: () => 1,
      setClearColor: () => {},
      clear: () => {},
    } as unknown as THREE.WebGLRenderer;
    const post = new PostChain(renderer, scene, () => false, () => false);
    const f = fakeComposer();
    // BokehPass sets its depth override, renders, then clears it, with no try/finally.
    f.composer.render = () => {
      scene.overrideMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      throw new TypeError("a mesh callback threw mid pass");
    };
    (post as unknown as { composer: unknown }).composer = f.composer;
    expect(() => post.render(new THREE.PerspectiveCamera())).toThrow(TypeError);
    expect(scene.overrideMaterial).toBeNull();
    setRenderPref("bloom", DEFAULT_RENDER.bloom);
  });
});
