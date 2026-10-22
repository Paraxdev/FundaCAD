import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  bloomSide,
  TraceBloom,
  traceBloom,
  type FadeMaterial,
  type TraceBloomDeps,
} from "../../src/viewport/pathtrace/tracePost";

describe("traced bloom settings", () => {
  const dark = new THREE.Color(0.01, 0.01, 0.02);

  it("is off at 0 and while nothing can reach the threshold", () => {
    expect(traceBloom(0, dark, true)).toBeNull();
    expect(traceBloom(0.5, dark, false)).toBeNull();
  });

  it("matches the Realtime pass: 0.7 a^2, 0.3 + 0.3 a, 2 - 1.2 a", () => {
    const b = traceBloom(0.6, dark, true)!;
    expect(b.strength).toBeCloseTo(0.252, 6);
    expect(b.radius).toBeCloseTo(0.48, 6);
    expect(b.threshold).toBeCloseTo(1.28, 6);
  });

  it("keeps the threshold above a light ground, so the background never blooms", () => {
    expect(traceBloom(0.6, new THREE.Color(2, 2, 2), true)!.threshold).toBeCloseTo(2.05, 5);
  });

  it("blooms at half the viewport, capped", () => {
    expect(bloomSide(1200, 800)).toBe(600);
    expect(bloomSide(7680, 4320)).toBe(1920);
  });
});

class Mat implements FadeMaterial {
  opacity = 0;
  transition = 0;
  fromTexture: THREE.Texture | null = null;
  texture: THREE.Texture | null = null;
  colorNode: unknown = null;
  _toneMapping = { faded: true };
  needsUpdate = false;
  disposed = false;
  dispose() {
    this.disposed = true;
  }
}

class Quad {
  renders = 0;
  constructor(public material: Mat) {}
  render() {
    this.renders++;
  }
  dispose() {}
}

function rig(drawW = 1200, drawH = 800) {
  const nodes: {
    scale: number;
    disposed: boolean;
    input: unknown;
    strength: { value: number };
    radius: { value: number };
    threshold: { value: number };
  }[] = [];
  const blit = new Quad(new Mat());
  const deps: TraceBloomDeps = {
    renderer: { autoClear: false, setRenderTarget() {}, getDrawingBufferSize: (v) => v.set(drawW, drawH) },
    blitQuad: blit,
    bloom: (input, s, r, t) => {
      const n = {
        scale: 0.5,
        disposed: false,
        input,
        strength: { value: s },
        radius: { value: r },
        threshold: { value: t },
        setResolutionScale(x: number) {
          n.scale = x;
        },
        dispose() {
          n.disposed = true;
        },
      };
      nodes.push(n);
      return n;
    },
    tsl: {
      nodeObject: (n) => ({ rgb: { add: (o: unknown) => ({ sum: [n, o] }) }, a: "a" }),
      vec4: (...a) => ({ vec4: a }),
    },
    size: new THREE.Vector2(),
  };
  return { post: new TraceBloom(deps), blit, nodes };
}

describe("TraceBloom", () => {
  const raw = new THREE.Texture();
  const clean = new THREE.Texture();

  it("is the plain blit while off and builds nothing", () => {
    const { post, blit, nodes } = rig();
    post.draw(raw, clean, 0.5);
    expect(blit.renders).toBe(1);
    expect(blit.material.transition).toBe(0.5);
    expect(nodes).toEqual([]);
  });

  it("draws through a bloom of the faded linear colour and redraws the last frame", () => {
    const { post, blit, nodes } = rig();
    post.setViewSize(1200, 800);
    post.draw(raw, clean, 1);
    post.set({ strength: 0.252, radius: 0.48, threshold: 1.28 });
    expect(nodes).toHaveLength(1);
    expect(post.redraw()).toBe(true);
    expect(blit.renders).toBe(1);
    expect(nodes[0]!.scale).toBeCloseTo(0.5, 6);
    expect(nodes[0]!.threshold.value).toBe(1.28);
    post.set({ strength: 0.7, radius: 0.6, threshold: 0.8 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.strength.value).toBe(0.7);
    post.set(null);
    expect(nodes[0]!.disposed).toBe(true);
    post.redraw();
    expect(blit.renders).toBe(2);
    expect(blit.material.texture).toBe(clean);
  });

  it("keeps the viewport's bloom size for a larger picture, so it glows the same", () => {
    const { post, nodes } = rig(4800, 3200);
    post.setViewSize(1200, 800);
    post.set({ strength: 0.252, radius: 0.48, threshold: 1.28 });
    post.draw(raw, raw, 0);
    expect(nodes[0]!.scale).toBeCloseTo(600 / 4800, 6);
  });
});
