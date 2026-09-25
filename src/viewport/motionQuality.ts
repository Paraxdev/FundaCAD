// Cheaper frames while the camera moves, on a machine too slow to move it at full
// quality. A reduced level draws the canvas at a lower pixel ratio, with 1px edge
// lines and without the bloom and blur passes (PostChain). When the canvas
// shrinks and grows back is the viewport's call (Viewport.applyMotionScale).
//
// Note: it is the canvas that shrinks, not an offscreen target. Under SwiftShader
// the frame period follows the canvas size far more than the draw: a half size
// target copied onto a full size canvas measured no faster at all.
//
// Driven by measurement only: a sample is the tick to tick period after a drawn
// camera frame. A GPU that keeps up never leaves full quality.

/** Pixel ratio multipliers, level 0 first. */
export const MOTION_LEVELS = [1, 0.75, 0.5] as const;
/** A median camera frame period above this, under 25 fps, steps a level down.
 *  Above a 30 fps power-plan cap (33 ms), which a lower resolution cannot help. */
export const MOTION_BUDGET_MS = 40;
/** Frames per verdict. */
const WINDOW = 4;
/** A level measured over budget is not probed again for this long. */
const REMEMBER_SLOW_MS = 30_000;
/** A step down has to take at least this share off the median, or the frame is
 *  not bound by pixels and the step is undone for good. */
const MIN_GAIN = 0.1;
/** A longer gap is a stall or a suspended window, not a frame. */
const MAX_SAMPLE_MS = 2000;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export class MotionQuality {
  private lvl = 0;
  private maxLevel = MOTION_LEVELS.length - 1;
  private window: number[] = [];
  private skip = 0;
  private lastMedian = 0;
  /** The median that caused the last step down, until the next verdict checks it paid off. */
  private stepFrom = 0;
  private stepLevel = 0;
  private slowLevel = -1;
  private slowUntil = 0;
  private fullMedian = 0;

  /** The last median measured at full quality, 0 before there is one. */
  get fullPeriod(): number {
    return this.fullMedian;
  }

  get level(): number {
    return this.lvl;
  }

  /** The pixel ratio multiplier for a camera frame. */
  get scale(): number {
    return MOTION_LEVELS[this.lvl]!;
  }

  /** Record one camera frame period. True when the level changed. */
  sample(ms: number, now: number): boolean {
    if (!(ms > 0) || ms > MAX_SAMPLE_MS) return false;
    if (this.skip > 0) {
      this.skip--;
      return false;
    }
    this.window.push(ms);
    if (this.window.length < WINDOW) return false;
    const med = median(this.window);
    this.window = [];
    this.lastMedian = med;
    if (this.lvl === 0) this.fullMedian = med;

    if (this.stepFrom > 0) {
      const from = this.stepFrom;
      this.stepFrom = 0;
      if (med > from * (1 - MIN_GAIN)) {
        this.maxLevel = this.stepLevel;
        return this.setLevel(this.stepLevel);
      }
    }
    if (med > MOTION_BUDGET_MS && this.lvl < this.maxLevel) {
      // Straight to the level the pixel count says will fit: every change resizes
      // the canvas, which waits for the GPU to drain.
      const at = MOTION_LEVELS[this.lvl]!;
      let next = this.lvl + 1;
      while (next < this.maxLevel && med * (MOTION_LEVELS[next]! / at) ** 2 > MOTION_BUDGET_MS * 0.75) next++;
      this.slowLevel = next - 1;
      this.slowUntil = now + REMEMBER_SLOW_MS;
      this.stepFrom = med;
      this.stepLevel = this.lvl;
      return this.setLevel(next);
    }
    if (this.lvl > 0 && this.mayRise(now)) {
      const up = MOTION_LEVELS[this.lvl - 1]! / MOTION_LEVELS[this.lvl]!;
      // Priced as if all of the frame were pixels, which overstates it, so a
      // rise that passes this does not bounce straight back.
      if (med * up * up < MOTION_BUDGET_MS * 0.75) return this.setLevel(this.lvl - 1);
    }
    return false;
  }

  /** The camera came to rest. A gesture that had plenty of headroom lets the
   *  next one try a level up. True when the level changed. */
  settle(now: number): boolean {
    this.window = [];
    this.stepFrom = 0;
    const med = this.lastMedian;
    this.lastMedian = 0;
    if (this.lvl > 0 && med > 0 && med < MOTION_BUDGET_MS / 2 && this.mayRise(now)) {
      return this.setLevel(this.lvl - 1);
    }
    return false;
  }

  /** Drop the next frame period: it paid for a resize, not for a draw. */
  skipNext(): void {
    this.skip = 1;
  }

  /** Start over, for a change of machine tier (potato mode, performance mode). */
  reset(): void {
    this.lvl = 0;
    this.maxLevel = MOTION_LEVELS.length - 1;
    this.window = [];
    this.skip = 0;
    this.lastMedian = 0;
    this.stepFrom = 0;
    this.stepLevel = 0;
    this.slowLevel = -1;
    this.slowUntil = 0;
    this.fullMedian = 0;
  }

  private mayRise(now: number): boolean {
    return !(this.lvl - 1 === this.slowLevel && now < this.slowUntil);
  }

  private setLevel(l: number): boolean {
    const next = Math.max(0, Math.min(MOTION_LEVELS.length - 1, l));
    if (next === this.lvl) return false;
    this.lvl = next;
    this.window = [];
    this.skip = 1;
    return true;
  }
}
