// Cheaper edges while the camera moves, chosen by measured cost so a normal part looks the same: "merged" batches many
// bodies' draws (1310 bodies measured 7.4 ms CPU, 5.3 ms GPU), "thin" draws 1px lines while frames stay slow.

export type EdgeMode = "full" | "merged" | "thin";

/** Visible edge draws at which a gesture draws merged, and under which it stops. */
export const MERGE_ON_DRAWS = 384;
export const MERGE_OFF_DRAWS = 256;
/** A median moving frame above this, under 30 fps, draws the edges thin. Under a software renderer the fat lines' quads
 *  are the frame (1px lines measured 1/47 of their cost); at rest EdgeBlend fades the fat lines back in over them. */
export const THIN_BUDGET_MS = 33;
/** Thin only pays where edges are this share of what is drawn, a fat segment counting as 6 triangles (measured 0.63 on
 *  holed plates, 0.3 on a 1310 body assembly). */
export const THIN_MIN_SHARE = 0.25;
const WINDOW = 4;
/** A thin verdict is kept this long before a gesture tries the fat lines again,
 *  doubled on each try found slow again, up to MAX_BACKOFF doublings. */
const REMEMBER_SLOW_MS = 30_000;
const MAX_BACKOFF = 4;
/** A longer gap is a stall or a suspended window, not a frame. */
const MAX_SAMPLE_MS = 2000;
/** The model changed this share of its edge segments, so a thin verdict on the old one says nothing. */
const SEGMENT_CHANGE = 0.5;
/** The thin lines have to take this share off the median that turned them on,
 *  or the frames were slow for another reason and the fat lines come back for this model. */
const MIN_GAIN = 0.3;
/** Slow windows in a row before the edges draw thin, so a stall of a few frames
 *  on a fast GPU is not taken for the edges. */
const SLOW_WINDOWS = 2;
/** Thin frames left out of the check: the fade frame and two fat frames still in the GPU queue. */
const VERIFY_SKIP = 3;
/** A tick back in under this share of the model's fat frame came from a free slot in the
 *  GPU queue, not a frame: 2 to 8 ms against fat frames of 550 to 1050 ms under SwiftShader. */
const SLOT_SHARE = 1 / 8;
/** The most free slots measured in a row, so more such ticks are frames that got fast. */
const SLOT_RUN = 3;

/** How long the camera has to be still before the fat lines come back, so an
 *  orbit in short bursts does not pulse. */
export const BLEND_DELAY_MS = 100;
/** The fade back to the full edges at rest. */
export const BLEND_MS = 200;
/** The fade to thin lines when a gesture starts or the level turns on mid gesture. */
export const BLEND_OUT_MS = 150;

export interface EdgeLoad {
  /** Visible BodyEdges draws. */
  draws: number;
  segments: number;
  triangles: number;
}

export function edgeShare(l: EdgeLoad): number {
  const e = l.segments * 6;
  return e + l.triangles > 0 ? e / (e + l.triangles) : 0;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export class EdgeMotionRule {
  private merged = false;
  private thin = false;
  private thinSegments = 0;
  private thinUntil = 0;
  private probing = false;
  private fails = 0;
  private window: number[] = [];
  private skip = 0;
  /** The median that turned thin on, until thin frames have shown they pay. */
  private verify = 0;
  /** The median that turned thin on, while that verdict stands. */
  private fatMs = 0;
  private slots = 0;
  private slowRun = 0;
  /** A first thin verdict: a long stall makes thin look like a gain, so the next
   *  gesture measures one window of fat lines before thin is remembered. */
  private provisional = false;
  /** The canvas scale the window and the medians were measured at. */
  private scale = 1;
  /** Segments of a model whose frames thin lines did not speed up. */
  private notEdgeBound = 0;
  private load: EdgeLoad = { draws: 0, segments: 0, triangles: 0 };

  get mode(): EdgeMode {
    return this.thin ? "thin" : this.merged ? "merged" : "full";
  }

  /** At a gesture's first frame. Merging is decided here only, never mid gesture. */
  gestureStart(load: EdgeLoad, now: number): EdgeMode {
    this.load = load;
    this.window.length = 0;
    this.slots = 0;
    this.merged = load.draws >= (this.merged ? MERGE_OFF_DRAWS : MERGE_ON_DRAWS);
    const changed = (n: number) => n > 0 && Math.abs(load.segments - n) > n * SEGMENT_CHANGE;
    if (changed(this.notEdgeBound)) this.notEdgeBound = 0;
    if (changed(this.thinSegments)) {
      this.reset();
      this.merged = load.draws >= MERGE_ON_DRAWS;
    } else if (this.thin && now >= this.thinUntil) {
      this.thin = false;
      this.probing = true;
      this.verify = 0;
    }
    this.skip = this.thin && this.verify > 0 ? VERIFY_SKIP : 0;
    return this.mode;
  }

  /** A moving frame's tick to tick period, drawn at canvas `scale`. */
  sample(ms: number, now: number, scale = 1): EdgeMode {
    if (scale !== this.scale) {
      this.scale = scale;
      this.window.length = 0;
      this.slowRun = this.skip = 0;
      if (this.thin && this.verify > 0) {
        this.verify = 0;
        this.provisional = true;
        this.thinUntil = 0;
      }
    }
    if ((this.thin && this.verify === 0) || ms > MAX_SAMPLE_MS) return this.mode;
    const slot = ms < this.fatMs * SLOT_SHARE;
    this.slots = slot ? this.slots + 1 : 0;
    if (slot && this.slots <= SLOT_RUN) return this.mode;
    if (this.skip > 0) {
      this.skip--;
      return this.mode;
    }
    this.window.push(ms);
    if (this.window.length < WINDOW) return this.mode;
    const m = median(this.window);
    this.window.length = 0;
    if (this.thin) {
      if (m > this.verify * (1 - MIN_GAIN)) {
        this.thin = false;
        this.thinSegments = this.fatMs = 0;
        this.notEdgeBound = this.load.segments;
      }
      this.verify = 0;
      return this.mode;
    }
    const slow = m > THIN_BUDGET_MS && edgeShare(this.load) >= THIN_MIN_SHARE && this.notEdgeBound === 0;
    this.slowRun = slow ? this.slowRun + 1 : 0;
    if (slow && !this.probing && this.slowRun < SLOW_WINDOWS) return this.mode;
    if (slow) {
      this.slowRun = 0;
      if (this.probing && !this.provisional) this.fails = Math.min(this.fails + 1, MAX_BACKOFF);
      this.provisional = !this.probing;
      this.verify = this.fatMs = m;
      this.thin = true;
      this.thinSegments = this.load.segments;
      this.thinUntil = this.provisional ? 0 : now + REMEMBER_SLOW_MS * 2 ** this.fails;
      this.skip = VERIFY_SKIP;
    } else if (this.probing) {
      this.fails = 0;
      this.thinSegments = this.fatMs = 0;
      this.provisional = false;
    }
    this.probing = false;
    return this.mode;
  }

  /** The next sample is a frame that built the batches, not a frame of the level. */
  skipNext() {
    this.skip = 1;
  }

  reset() {
    this.merged = false;
    this.thin = false;
    this.thinSegments = 0;
    this.thinUntil = 0;
    this.probing = false;
    this.fails = 0;
    this.window.length = 0;
    this.skip = 0;
    this.verify = this.fatMs = 0;
    this.slots = 0;
    this.slowRun = 0;
    this.provisional = false;
    this.notEdgeBound = 0;
  }
}

function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const at = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0,
      hi = 1,
      t = x;
    for (let i = 0; i < 30; i++) {
      const cx = at(t, x1, x2);
      if (Math.abs(cx - x) < 1e-6) break;
      if (cx < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return at(t, y1, y2);
  };
}

/** docs/DESIGN.md section 8, the one easing. */
export const ease = bezier(0.2, 0, 0.15, 1);

/** The fat lines' share of the idle edges' look: 0 is all thin, 1 the full set. */
export class EdgeBlend {
  private from = 1;
  private to = 1;
  private t0 = 0;
  private dur = 0;
  private movedAt = -Infinity;
  weight = 1;

  /** `moving` is a frame of a gesture that draws thin. `animate` false
   *  (Animations off) makes each change a step. */
  update(moving: boolean, now: number, animate: boolean): number {
    if (moving) this.movedAt = now;
    const target = moving || now - this.movedAt < BLEND_DELAY_MS ? 0 : 1;
    const w = this.value(now);
    if (!animate) {
      this.from = this.to = target;
      this.dur = 0;
    } else if (target !== this.to) {
      this.from = w;
      this.to = target;
      this.t0 = now;
      this.dur = (target ? BLEND_MS : BLEND_OUT_MS) * Math.abs(target - w);
    }
    return (this.weight = this.value(now));
  }

  /** Still on its way back to the full edges, so the loop has to keep drawing. */
  get pending(): boolean {
    return this.weight < 1;
  }

  private value(now: number): number {
    if (this.dur <= 0) return this.to;
    const t = Math.min(1, Math.max(0, (now - this.t0) / this.dur));
    return t >= 1 ? this.to : this.from + (this.to - this.from) * ease(t);
  }
}
