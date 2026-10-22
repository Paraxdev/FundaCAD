// Bloom spills only from glowing faces: the bright pass reads a mask drawn from
// the bodies, glowing faces white and every other solid black, so a lit white
// body never haloes because something else in the scene glows.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GlowMask, glows, maskHighPass } from "../../src/viewport/realtimePipeline";
import { PostChain } from "../../src/viewport/scene";

interface Seen {
  color: string;
  colorWrite: boolean;
  depthWrite: boolean;
  transparent: boolean;
  blending: number;
  side: number;
}
interface Draw {
  target: unknown;
  mask: number;
  background: unknown;
  autoClear: boolean;
  autoUpdate: boolean;
  clear: string;
  alpha: number;
  meshes: Record<string, Seen[]>;
}

function seen(m: THREE.Material): Seen {
  const b = m as THREE.MeshBasicMaterial;
  return {
    color: b.color?.getHexString() ?? "-",
    colorWrite: m.colorWrite,
    depthWrite: m.depthWrite,
    transparent: m.transparent,
    blending: m.blending,
    side: m.side,
  };
}

function body(name: string, material: THREE.Material | THREE.Material[], at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(18, 18, 18), material);
  mesh.name = name;
  mesh.userData.owner = { id: name };
  mesh.position.set(...at);
  return mesh;
}

const glowing = (hex: number, intensity: number) =>
  new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: intensity, roughness: 0.6 });

function fakeRenderer() {
  let target: unknown = "composer-read";
  const clear = new THREE.Color(0x0b0912);
  let alpha = 1;
  const draws: Draw[] = [];
  let throwOn = 0;
  const renderer = {
    autoClear: false,
    shadowMap: { autoUpdate: true, render: () => {} },
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => {
      target = t;
    },
    getClearColor: (c: THREE.Color) => c.copy(clear),
    getClearAlpha: () => alpha,
    setClearColor: (c: THREE.Color | number, a = 1) => {
      clear.set(c);
      alpha = a;
    },
    render: (s: THREE.Scene, c: THREE.Camera) => {
      const meshes: Record<string, Seen[]> = {};
      s.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if ((m.isMesh || (o as THREE.Line).isLine) && o.layers.test(c.layers))
          meshes[o.name] = (Array.isArray(m.material) ? m.material : [m.material]).map(seen);
      });
      draws.push({
        target,
        mask: c.layers.mask,
        background: s.background,
        autoClear: renderer.autoClear,
        autoUpdate: renderer.shadowMap.autoUpdate,
        clear: clear.getHexString(),
        alpha,
        meshes,
      });
      if (throwOn === draws.length) throw new Error("lost context");
    },
  };
  return {
    renderer,
    draws,
    clear,
    target: () => target,
    throwAt: (n: number) => {
      throwOn = n;
    },
  };
}

function scene() {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x203040);
  const white = body("white", new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), [-21, 4.5, 9]);
  const glow = body("glow", glowing(0xd9f2b4, 0.7), [37.5, -12, 8.25]);
  (glow.material as THREE.Material).side = THREE.DoubleSide;
  const glass = body("glass", new THREE.MeshPhysicalMaterial({ transmission: 1 }), [8, 30, 11]);
  const faced = body(
    "faced",
    [new THREE.MeshStandardMaterial({ color: 0xc0c0c0 }), glowing(0x40ff20, 1.4)],
    [-44, -27, 6.5],
  );
  const off = body("off", glowing(0xff2010, 1.4), [60, 60, 9]);
  off.visible = false;
  const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
  edges.name = "edges";
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  ground.name = "ground";
  const handle = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  handle.name = "handle";
  handle.layers.set(7);
  s.add(white, glow, glass, faced, off, edges, ground, handle);
  const camera = new THREE.PerspectiveCamera();
  camera.layers.enableAll();
  return { s, camera, white, glow, glass, faced, off, edges, ground, handle };
}

const BLACK: Omit<Seen, "side"> = {
  color: "000000",
  colorWrite: true,
  depthWrite: true,
  transparent: false,
  blending: THREE.NoBlending,
};
const WHITE: Omit<Seen, "side"> = { ...BLACK, color: "ffffff" };

describe("glows", () => {
  it("is true only for a PBR material with both an emissive colour and an intensity", () => {
    const cases: [THREE.Material, boolean][] = [
      [glowing(0xd9f2b4, 0.7), true],
      [glowing(0x010000, 0.7), true],
      [glowing(0x000000, 0.7), false],
      [glowing(0xd9f2b4, 0.01), true],
      [glowing(0xd9f2b4, 0), false],
      [new THREE.MeshPhysicalMaterial({ emissive: 0x2040ff, emissiveIntensity: 1.4 }), true],
      [new THREE.MeshStandardMaterial({ color: 0xffffff }), false],
      [new THREE.MeshBasicMaterial({ color: 0xffffff }), false],
    ];
    expect(cases.map(([m]) => glows(m))).toEqual(cases.map(([, want]) => want));
  });
});

describe("GlowMask", () => {
  it("draws glowing faces white and the other solid bodies black at the bloom's size, then gives everything back", () => {
    const c = scene();
    const f = fakeRenderer();
    const mask = new GlowMask();
    const full = c.camera.layers.mask;
    const own = () => [
      c.white.material,
      c.glow.material,
      c.glass.material,
      c.faced.material,
      ...(c.faced.material as THREE.Material[]),
      c.ground.material,
    ];
    const before = own();
    expect(mask.render(f.renderer as unknown as THREE.WebGLRenderer, c.s, c.camera, 350, 206)).toBe(true);
    expect([mask.target.width, mask.target.height]).toEqual([350, 206]);
    expect(f.draws).toEqual([
      {
        target: mask.target,
        mask: 1,
        background: null,
        autoClear: true,
        autoUpdate: false,
        clear: "000000",
        alpha: 1,
        meshes: {
          white: [{ ...BLACK, side: THREE.FrontSide }],
          glow: [{ ...WHITE, side: THREE.DoubleSide }],
          glass: [{ ...BLACK, colorWrite: false, depthWrite: false, side: THREE.FrontSide }],
          faced: [
            { ...BLACK, side: THREE.FrontSide },
            { ...WHITE, side: THREE.FrontSide },
          ],
        },
      },
    ]);
    expect(own().map((m, i) => m === before[i])).toEqual(before.map(() => true));
    expect([c.edges.visible, c.ground.visible, c.handle.visible, c.off.visible]).toEqual([true, true, true, false]);
    expect(c.camera.layers.mask).toBe(full);
    expect(c.s.background).toEqual(new THREE.Color(0x203040));
    expect([f.target(), f.clear.getHexString(), f.renderer.autoClear, f.renderer.shadowMap.autoUpdate]).toEqual([
      "composer-read",
      "0b0912",
      false,
      true,
    ]);
  });

  it("follows the bloom's size from one frame to the next", () => {
    const c = scene();
    const f = fakeRenderer();
    const mask = new GlowMask();
    const r = f.renderer as unknown as THREE.WebGLRenderer;
    mask.render(r, c.s, c.camera, 350, 206);
    mask.render(r, c.s, c.camera, 613, 287);
    expect([mask.target.width, mask.target.height]).toEqual([613, 287]);
    expect(f.draws).toHaveLength(2);
  });

  it("draws nothing when no body on screen glows, with none, one and many bodies", () => {
    for (const n of [0, 1, 3]) {
      const c = scene();
      for (const o of [c.glow, c.faced, c.white, c.glass]) c.s.remove(o);
      const plain = [
        body(
          "p0",
          new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x000000, emissiveIntensity: 1.4 }),
          [12, -7, 9],
        ),
        body("p1", glowing(0xd9f2b4, 0), [-31, 18, 9]),
        body("p2", new THREE.MeshPhysicalMaterial({ transmission: 1, roughness: 0.1 }), [52, 23, 9]),
      ].slice(0, n);
      c.s.add(...plain);
      const f = fakeRenderer();
      expect(
        new GlowMask().render(f.renderer as unknown as THREE.WebGLRenderer, c.s, c.camera, 350, 206),
        `${n} bodies`,
      ).toBe(false);
      expect(f.draws).toEqual([]);
    }
  });

  it("gives back the materials, the mask, the background, the clear and the target when the draw throws", () => {
    const c = scene();
    const f = fakeRenderer();
    f.throwAt(1);
    const full = c.camera.layers.mask;
    const own = () => [
      c.white.material,
      c.glow.material,
      c.glass.material,
      c.faced.material,
      ...(c.faced.material as THREE.Material[]),
    ];
    const before = own();
    expect(() => new GlowMask().render(f.renderer as unknown as THREE.WebGLRenderer, c.s, c.camera, 350, 206)).toThrow(
      "lost context",
    );
    expect(own().map((m, i) => m === before[i])).toEqual(before.map(() => true));
    expect([c.edges.visible, c.ground.visible]).toEqual([true, true]);
    expect(c.camera.layers.mask).toBe(full);
    expect(c.s.background).toEqual(new THREE.Color(0x203040));
    expect([f.target(), f.clear.getHexString(), f.renderer.autoClear, f.renderer.shadowMap.autoUpdate]).toEqual([
      "composer-read",
      "0b0912",
      false,
      true,
    ]);
  });
});

async function loadPasses() {
  const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { BokehPass }, { OutputPass }] = await Promise.all([
    import("three/examples/jsm/postprocessing/EffectComposer.js"),
    import("three/examples/jsm/postprocessing/RenderPass.js"),
    import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
    import("three/examples/jsm/postprocessing/BokehPass.js"),
    import("three/examples/jsm/postprocessing/OutputPass.js"),
  ]);
  return { EffectComposer, RenderPass, UnrealBloomPass, BokehPass, OutputPass };
}

describe("maskHighPass", () => {
  it("multiplies the high pass's texel by the mask, on the shader of the three this ships", async () => {
    const { UnrealBloomPass } = await loadPasses();
    const bloom = new UnrealBloomPass(new THREE.Vector2(700, 412), 0.11, 0.42, 1.52);
    const m = bloom.materialHighPassFilter;
    const tex = new THREE.Texture();
    expect(maskHighPass(m, tex)).toBe(true);
    const src = m.fragmentShader;
    const at = [
      src.indexOf("uniform sampler2D tMask;"),
      src.indexOf("vec4 texel = texture2D( tDiffuse, vUv );"),
      src.indexOf("texel *= texture2D( tMask, vUv ).r;"),
      src.indexOf("float v = luminance( texel.xyz );"),
    ];
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(m.uniforms["tMask"]!.value).toBe(tex);
  });

  it("changes nothing on a shader without the line it rewrites", () => {
    const fragmentShader =
      "uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }";
    const m = new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: null } }, fragmentShader });
    expect(maskHighPass(m, new THREE.Texture())).toBe(false);
    expect(m.fragmentShader).toBe(fragmentShader);
    expect(Object.keys(m.uniforms)).toEqual(["tDiffuse"]);
  });
});

describe("PostChain bloom", () => {
  async function built() {
    const c = scene();
    const f = fakeRenderer();
    const r = f.renderer as unknown as Record<string, unknown>;
    Object.assign(r, {
      toneMapping: THREE.NeutralToneMapping,
      toneMappingExposure: 1,
      getPixelRatio: () => 2,
      getSize: (v: THREE.Vector2) => v.set(700, 412),
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(1400, 824),
    });
    const spilled: unknown[] = [];
    const passes = await loadPasses();
    class SpyBloom extends passes.UnrealBloomPass {
      override render(_r: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
        spilled.push(read);
      }
    }
    const post = new PostChain(
      f.renderer as unknown as THREE.WebGLRenderer,
      c.s,
      () => false,
      () => false,
    );
    const p = post as unknown as {
      passes: unknown;
      camera: THREE.Camera;
      build(): void;
      bloom: InstanceType<typeof passes.UnrealBloomPass>;
      glowMask: GlowMask;
    };
    p.passes = { ...passes, UnrealBloomPass: SpyBloom };
    post.setSize(700, 412);
    p.build();
    p.camera = c.camera;
    return { ...c, f, p, spilled };
  }

  it("draws the glow mask before the bright pass, and the bright pass reads it", async () => {
    const b = await built();
    const read = new THREE.WebGLRenderTarget(1400, 824);
    b.p.bloom.render(b.f.renderer as unknown as THREE.WebGLRenderer, read, read, 0, false);
    expect(b.f.draws.map((d) => [d.target, Object.keys(d.meshes)])).toEqual([
      [b.p.glowMask.target, ["white", "glow", "glass", "faced"]],
    ]);
    expect([b.p.glowMask.target.width, b.p.glowMask.target.height]).toEqual([
      b.p.bloom.renderTargetBright.width,
      b.p.bloom.renderTargetBright.height,
    ]);
    expect(b.spilled).toEqual([read]);
    expect(b.p.bloom.materialHighPassFilter.uniforms["tMask"]!.value).toBe(b.p.glowMask.target.texture);
  });

  it("skips the bright pass on a frame where nothing glows", async () => {
    const b = await built();
    b.s.remove(b.glow, b.faced);
    const read = new THREE.WebGLRenderTarget(1400, 824);
    b.p.bloom.render(b.f.renderer as unknown as THREE.WebGLRenderer, read, read, 0, false);
    expect(b.f.draws).toEqual([]);
    expect(b.spilled).toEqual([]);
  });
});
