// Bloom on the traced image, the Realtime composer's UnrealBloomPass rebuilt for
// a tracer's linear HDR frame. Any backend that can hand over its frame as a
// texture draws it through TraceBloom.

import type * as THREE from "three";
import { bloomSettings, bloomWanted } from "../../ui/renderPrefs";
import { thresholdAboveGround } from "../composerColor";

export interface TraceBloomSettings {
  strength: number;
  radius: number;
  threshold: number;
}

/** The Realtime rules: nothing at 0 or with nothing able to reach the threshold,
 *  and the threshold kept above the ground so the background never blooms.
 *  `background` is the linear clear, TraceLook.background. */
export function traceBloom(amount: number, background: THREE.Color, bloomable: boolean): TraceBloomSettings | null {
  if (!bloomWanted(amount, bloomable)) return null;
  const b = bloomSettings(amount);
  return { strength: b.strength, radius: b.radius, threshold: thresholdAboveGround(b.threshold, background) };
}

export function bloomKey(b: TraceBloomSettings | null): string {
  return b ? `${b.strength}:${b.radius}:${b.threshold}` : "";
}

/** Longest side of the bloom's input. Above it the glow costs more than it shows. */
export const BLOOM_MAX_SIDE = 1920;

/** Long side of the bloom's input for a viewport drawing buffer: half of it,
 *  as UnrealBloomPass does in Realtime, capped. */
export function bloomSide(width: number, height: number): number {
  return Math.min(BLOOM_MAX_SIDE, Math.max(1, Math.round(Math.max(width, height) / 2)));
}

/** What the tracer's RenderToScreen material exposes; `_toneMapping` is its
 *  faded linear colour before any tone mapping. */
export interface FadeMaterial {
  opacity: number;
  transition: number;
  fromTexture: THREE.Texture | null; texture: THREE.Texture | null;
  colorNode: unknown;
  _toneMapping: unknown;
  needsUpdate: boolean;
  dispose(): void;
}

export interface FadeQuad {
  material: FadeMaterial;
  render(r: unknown): void;
  dispose?(): void;
}

interface BloomNodeLike {
  strength: { value: number };
  radius: { value: number };
  threshold: { value: number };
  setResolutionScale(s: number): unknown;
  dispose(): void;
}

interface Tsl {
  nodeObject(n: unknown): { rgb: { add(o: unknown): unknown }; a: unknown };
  vec4(...a: unknown[]): unknown;
}

interface Renderer {
  autoClear: boolean;
  setRenderTarget(t: null): void;
  getDrawingBufferSize(v: THREE.Vector2): THREE.Vector2;
}

export interface TraceBloomDeps {
  renderer: Renderer;
  /** The plain blit, used as it is while bloom is off. */
  blitQuad: FadeQuad;
  bloom(input: unknown, strength: number, radius: number, threshold: number): BloomNodeLike;
  tsl: Tsl;
  size: THREE.Vector2;
}

export class TraceBloom {
  private settings: TraceBloomSettings | null = null;
  private node: BloomNodeLike | null = null;
  private quad: FadeQuad | null = null;
  /** Kept from the viewport, so a picture larger than it glows the same. */
  private side = 0;
  private last: { from: THREE.Texture; to: THREE.Texture; mix: number } | null = null;

  constructor(private deps: TraceBloomDeps) {}

  get on(): boolean {
    return this.settings !== null;
  }

  setViewSize(width: number, height: number) {
    this.side = bloomSide(width, height);
  }

  /** Takes effect on the next draw; `redraw` draws the last frame again. */
  set(s: TraceBloomSettings | null) {
    this.settings = s;
    if (!s) return this.disposeBloom();
    if (!this.node) this.build(s);
    const n = this.node!;
    n.strength.value = s.strength;
    n.radius.value = s.radius;
    n.threshold.value = s.threshold;
  }

  redraw(): boolean {
    if (!this.last) return false;
    this.draw(this.last.from, this.last.to, this.last.mix);
    return true;
  }

  /** The tracer drew `tex` itself; remembered so a bloom change can redraw it. */
  drewItself(tex: THREE.Texture) {
    this.last = { from: tex, to: tex, mix: 0 };
  }

  /** Draws the crossfade of `from` to `to` on the canvas, with bloom when on.
   *  Tone mapping and the output encoding come after the bloom, from the
   *  renderer's output transform, exactly as for the plain blit. */
  draw(from: THREE.Texture, to: THREE.Texture, mix: number) {
    this.last = { from, to, mix };
    const r = this.deps.renderer;
    const q = this.settings && this.quad ? this.quad : this.deps.blitQuad;
    if (q === this.quad && this.node) {
      const d = r.getDrawingBufferSize(this.deps.size);
      const long = Math.max(d.x, d.y, 1);
      this.node.setResolutionScale(Math.min(1, (this.side || bloomSide(d.x, d.y)) / long));
    }
    const autoClear = r.autoClear;
    r.setRenderTarget(null);
    r.autoClear = true;
    q.material.opacity = 1;
    q.material.transition = mix;
    q.material.fromTexture = from;
    q.material.texture = to;
    q.render(r);
    r.autoClear = autoClear;
  }

  private build(s: TraceBloomSettings) {
    const { blitQuad, bloom, tsl } = this.deps;
    const Material = blitQuad.material.constructor as new () => FadeMaterial;
    const Quad = blitQuad.constructor as new (m: FadeMaterial) => FadeQuad;
    const m = new Material();
    // The high pass samples the tracer's float textures through the fade's own
    // textureLoad filter: a float32 texture cannot take a filtering sampler.
    const node = bloom(m._toneMapping, s.strength, s.radius, s.threshold);
    const faded = tsl.nodeObject(m._toneMapping);
    m.colorNode = tsl.vec4(faded.rgb.add(tsl.nodeObject(node).rgb), faded.a);
    m.needsUpdate = true;
    this.node = node;
    this.quad = new Quad(m);
  }

  private disposeBloom() {
    this.node?.dispose();
    this.node = null;
    if (this.quad) {
      this.quad.material.dispose();
      this.quad.dispose?.();
      this.quad = null;
    }
  }

  dispose() {
    this.disposeBloom();
    this.last = null;
  }
}
