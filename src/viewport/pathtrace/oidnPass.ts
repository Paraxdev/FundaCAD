// Driven by FinalDenoise instead of by the tracer, so the app decides when the pass starts and when
// its result is shown.

import type * as THREE from "three";
import type { DenoisePass } from "./denoise";

export interface OidnLike {
  readonly complete: boolean;
  readonly running: boolean;
  readonly texture: THREE.Texture | null;
  setScene(scene: THREE.Scene, camera: THREE.Camera): void;
  denoise(color: THREE.Texture, albedo?: THREE.Texture | null, normal?: THREE.Texture | null): Promise<void>;
  reset(): void;
  dispose(): void;
}

interface AuxRenderer {
  _renderAuxiliaryBuffers(w: number, h: number): { textures: THREE.Texture[] };
}

export interface OidnSource {
  scene: THREE.Scene;
  camera: THREE.Camera | null;
  /** The accumulated image, linear HDR. */
  color: THREE.Texture | null;
}

const nextFrame = (fn: () => void) =>
  typeof requestAnimationFrame === "undefined" ? setTimeout(fn, 16) : requestAnimationFrame(fn);

export class OidnPass implements DenoisePass {
  private cancelled = false;

  constructor(
    readonly oidn: OidnLike,
    private source: () => OidnSource,
  ) {}

  async run(): Promise<boolean> {
    this.cancelled = false;
    const { scene, camera, color } = this.source();
    if (!camera || !color) return false;
    const o = this.oidn;
    o.reset();
    // The tracer swaps camera objects when depth of field toggles and never
    // tells the denoiser, so the guides are drawn from the camera of this run.
    o.setScene(scene, camera);
    const { width, height } = color.image as { width: number; height: number };
    const aux = (o as unknown as AuxRenderer)._renderAuxiliaryBuffers(width, height);
    await o.denoise(color, aux.textures[0], aux.textures[1]);
    return new Promise<boolean>((resolve) => {
      const watch = () => {
        if (this.cancelled) resolve(false);
        else if (o.complete) resolve(true);
        else if (!o.running) resolve(false);
        else nextFrame(watch);
      };
      watch();
    });
  }

  cancel() {
    this.cancelled = true;
    this.oidn.reset();
  }

  get texture(): THREE.Texture | null {
    return this.oidn.complete ? this.oidn.texture : null;
  }

  dispose() {
    this.cancel();
    this.oidn.dispose();
  }
}
