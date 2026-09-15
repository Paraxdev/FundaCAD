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
/** How much drawing a verdict needs behind it. */
export const STUTTER_WINDOW_MS = 3000;
const MIN_SAMPLES = 12;
/** A longer gap is a suspended window or a debugger pause, not a frame. */
const MAX_SAMPLE_MS = 10_000;

export class StutterWatch {
  private samples: number[] = [];
  private total = 0;

  /** Record one frame period and report whether the recent window is slow. */
  sample(ms: number): boolean {
    if (!(ms > 0) || ms > MAX_SAMPLE_MS) return false;
    this.samples.push(ms);
    this.total += ms;
    while (this.samples.length > MIN_SAMPLES && this.total - this.samples[0]! >= STUTTER_WINDOW_MS) {
      this.total -= this.samples.shift()!;
    }
    if (this.samples.length < MIN_SAMPLES || this.total < STUTTER_WINDOW_MS) return false;
    return median(this.samples) > STUTTER_MS;
  }

  reset(): void {
    this.samples = [];
    this.total = 0;
  }
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
