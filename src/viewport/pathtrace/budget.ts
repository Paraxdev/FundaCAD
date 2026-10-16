// How much work the path tracer is handed per frame, at what resolution, and
// where it stops. Pure, so the controller is tested without a GPU.

/** GPU time per traced frame that leaves the UI near 60 fps. */
export const TARGET_MS = 12;
/** Below this on every recent frame the budget may grow. */
export const LOW_MS = 10;
export const STEP_UP_MS = 500;
const WINDOW = 5;
/** Enough frames for a median that one slow frame cannot move. */
const MIN_FOR_DOWN = 3;
/** The most steps one decision drops, a factor of 4. */
const MAX_DROP = 4;

/** Path slots per frame, powers of the square root of two. Changing the budget
 *  reallocates the tracer's slot buffers, so it only ever moves between these. */
export const BUDGET_STEPS: readonly number[] = Array.from({ length: 15 }, (_, i) => Math.round(2 ** (14 + i / 2)));
export const MIN_SLOTS = BUDGET_STEPS[0]!;
export const MAX_SLOTS = BUDGET_STEPS.at(-1)!;
export const BUDGET_START = 2 ** 18;

/** The tracer never traces more paths than pixels, so the step just past the
 *  pixel count covers the whole image in one frame. */
function stepCovering(n: number): number {
  return BUDGET_STEPS.find((s) => s >= n) ?? MAX_SLOTS;
}

function stepAtMost(n: number): number {
  let best = MIN_SLOTS;
  for (const s of BUDGET_STEPS) if (s <= n) best = s;
  return best;
}

export class FrameBudget {
  budget = BUDGET_START;
  private ceiling = MAX_SLOTS;
  private scale = 1;
  private recent: number[] = [];
  private changedAt = 0;

  /** `pixels` is the trace's pixel count: the tracer never uses more slots than that. */
  constructor(pixels: number) {
    this.setLimit(pixels, 1);
  }

  /** `scale` below 1 shrinks the ceiling and the budget with it, for battery. */
  setLimit(pixels: number, scale: number) {
    if (scale !== this.scale) {
      this.budget = stepAtMost((this.budget * scale) / this.scale);
      this.scale = scale;
    }
    this.ceiling = stepAtMost(stepCovering(pixels) * scale);
    if (this.budget > this.ceiling) this.set(this.ceiling, this.changedAt);
  }

  /** One traced frame took `ms` of GPU time. Returns true when the budget changed. */
  frame(ms: number, now: number): boolean {
    this.recent.push(ms);
    if (this.recent.length > WINDOW) this.recent.shift();
    if (this.recent.length >= MIN_FOR_DOWN) {
      const m = [...this.recent].sort((a, b) => a - b)[this.recent.length >> 1]!;
      if (m > TARGET_MS && this.budget > MIN_SLOTS) {
        const at = BUDGET_STEPS.indexOf(this.budget);
        const fit = Math.max(BUDGET_STEPS.indexOf(stepAtMost((this.budget * TARGET_MS) / m)), at - MAX_DROP);
        return this.set(BUDGET_STEPS[Math.min(fit, at - 1)]!, now);
      }
    }
    if (this.recent.length === WINDOW && Math.max(...this.recent) < LOW_MS && now - this.changedAt >= STEP_UP_MS) {
      const up = BUDGET_STEPS[BUDGET_STEPS.indexOf(this.budget) + 1];
      if (up !== undefined && up <= this.ceiling) return this.set(up, now);
    }
    return false;
  }

  private set(slots: number, now: number): boolean {
    if (slots === this.budget) return false;
    this.budget = slots;
    this.changedAt = now;
    this.recent = [];
    return true;
  }
}

export interface CostProfile {
  cap: number;
  budgetScale: number;
}

export function costProfile(p: { discharging: boolean }): CostProfile {
  return p.discharging ? { cap: 64, budgetScale: 0.5 } : { cap: 256, budgetScale: 1 };
}

/** The tracer's renderScale, against a canvas drawn at CSS size (pixel ratio
 *  at most 1), so the trace lands at 0.75 of the device pixels, or 0.5 on a
 *  dense or very large screen or on battery. */
export function renderScaleFor(p: { cssHeight: number; dpr: number; discharging: boolean }): number {
  const dpr = p.dpr > 0 ? p.dpr : 1;
  const device = p.discharging || dpr > 1.5 || p.cssHeight * dpr > 1440 ? 0.5 : 0.75;
  return Math.min(1, (device * dpr) / Math.min(dpr, 1));
}

/** About a 4K frame: the tracer keeps several float targets of the picture's
 *  size, and the denoiser more. */
export const MAX_PICTURE_PIXELS = 3840 * 2160;

/** The multiple of the view a traced picture is taken at, at most `scale`. */
export function tracedPictureScale(w: number, h: number, scale: number, maxDimension: number): number {
  const k = Math.min(scale, Math.sqrt(MAX_PICTURE_PIXELS / (w * h)), maxDimension / Math.max(w, h));
  return Math.floor(k * 1000) / 1000;
}
