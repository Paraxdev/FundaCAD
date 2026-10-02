// Decides whether the viewport is too slow to be comfortable, so the chrome can
// offer performance mode.
//
// A sample is the tick to tick period that followed a drawn frame, which is what
// the draw cost the display. The gap BEFORE a drawn frame would be useless: after
// an idle stretch it is minutes long. The verdict is a median over a few seconds
// of drawing, so a single long frame (a shader compile, a mesh landing) never
// trips it on its own.

/** A median frame period above this is a stutter, about 22 fps. A laptop held
 *  to 30 fps by a power plan sits at 33 ms and must not be told it is slow. */
export const STUTTER_MS = 45;
/** A median back under this clears the verdict. Below STUTTER_MS so a view
 *  hovering around the line does not flicker the warning on and off, and above
 *  a 30 fps power plan so a machine that has recovered to it is cleared. */
export const STUTTER_CLEAR_MS = 36;
/** How much drawing a verdict needs behind it. */
export const STUTTER_WINDOW_MS = 3000;
const MIN_SAMPLES = 12;
/** A longer gap is a suspended window or a debugger pause, not a frame. */
const MAX_SAMPLE_MS = 10_000;

export class StutterWatch {
  private samples: number[] = [];
  private total = 0;
  private slow = false;
  /** Drawing time the median has spent under the clear line without a break. */
  private underMs = 0;

  /** Record one frame period and report whether the view is stuttering: set by a
   *  window over STUTTER_MS, cleared once the window has stayed under
   *  STUTTER_CLEAR_MS for a whole window, held between. Cleared on a trimmed mean
   *  rather than the median, because at 60 Hz periods come only as 33 or 50 ms
   *  and a median of the two jumps straight across the band. */
  sample(ms: number): boolean {
    if (!(ms > 0) || ms > MAX_SAMPLE_MS) return this.slow;
    this.samples.push(ms);
    this.total += ms;
    while (this.samples.length > MIN_SAMPLES && this.total - this.samples[0]! >= STUTTER_WINDOW_MS) {
      this.total -= this.samples.shift()!;
    }
    if (this.samples.length < MIN_SAMPLES || this.total < STUTTER_WINDOW_MS) return this.slow;
    const med = median(this.samples);
    if (med > STUTTER_MS) this.slow = true;
    this.underMs = trimmedMean(this.samples) < STUTTER_CLEAR_MS ? this.underMs + ms : 0;
    if (this.underMs >= STUTTER_WINDOW_MS) this.slow = false;
    return this.slow;
  }

  reset(): void {
    this.samples = [];
    this.total = 0;
    this.slow = false;
    this.underMs = 0;
  }
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The mean of all but the slowest tenth: steady like a mean, but a shader
 *  compile or a mesh landing does not hold the warning up on its own. */
function trimmedMean(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const keep = s.slice(0, Math.max(1, Math.ceil(s.length * 0.9)));
  return keep.reduce((a, b) => a + b, 0) / keep.length;
}
