// The final denoise at the sample cap: one pass over the finished image, then a
// crossfade to it. Pure, so the stale generation rule is tested without a GPU.

import { TraceGeneration } from "./state";

export const CROSSFADE_MS = 120;

/** One denoise over the image as it is now. Resolves true once the result is
 *  complete, false when the pass was dropped. */
export interface DenoisePass {
  run(): Promise<boolean>;
  cancel(): void;
}

export interface DenoiseStep {
  /** The crossfade to draw, 0 the image before the denoise and 1 the denoised
   *  one; null when the screen keeps what it has. */
  mix: number | null;
  /** Another frame is wanted. */
  more: boolean;
}

type Phase = "idle" | "running" | "fading" | "settled";

export class FinalDenoise {
  private gen = new TraceGeneration();
  private phase: Phase = "idle";
  private fadeFrom = -1;
  denoised = false;

  constructor(private pass: DenoisePass | null) {}

  setPass(pass: DenoisePass | null) {
    this.reset();
    this.pass = pass;
  }

  /** A result still in flight lands in an older generation and is dropped. */
  reset() {
    this.gen.bump();
    if (this.phase === "running") this.pass?.cancel();
    this.phase = "idle";
    this.fadeFrom = -1;
    this.denoised = false;
  }

  step(now: number): DenoiseStep {
    if (this.phase === "idle") {
      const pass = this.pass;
      if (!pass) {
        this.phase = "settled";
        return { mix: null, more: false };
      }
      this.phase = "running";
      const g = this.gen.current;
      const land = (ok: boolean) => {
        if (!this.gen.isCurrent(g) || this.phase !== "running") return;
        this.phase = ok ? "fading" : "settled";
      };
      pass.run().then(land, (e: unknown) => {
        console.warn("Path traced denoise failed", e);
        land(false);
      });
      return { mix: null, more: true };
    }
    if (this.phase === "running") return { mix: null, more: true };
    if (this.phase === "fading") {
      if (this.fadeFrom < 0) this.fadeFrom = now;
      const mix = Math.min(1, (now - this.fadeFrom) / CROSSFADE_MS);
      if (mix < 1) return { mix, more: true };
      this.phase = "settled";
      this.denoised = true;
      return { mix, more: false };
    }
    return { mix: null, more: false };
  }
}
