// A sample is the period AFTER a drawn frame, the gap before one spans idle time.
// The verdict is a median over seconds of drawing, so one long frame never trips it.

/** About 22 fps. A laptop held to 30 fps by a power plan sits at 33 ms and must not be told it is slow. */
export const STUTTER_MS = 45;
/** Below STUTTER_MS so the warning does not flicker, above 33 ms so a 30 fps power plan clears. */
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

  /** Clears on a trimmed mean, not the median: at 60 Hz periods come only as 33 or
   *  50 ms and a median of the two jumps straight across the band. */
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

/** Drops the slowest tenth so a shader compile or a mesh landing cannot hold the warning up. */
function trimmedMean(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const keep = s.slice(0, Math.max(1, Math.ceil(s.length * 0.9)));
  return keep.reduce((a, b) => a + b, 0) / keep.length;
}
