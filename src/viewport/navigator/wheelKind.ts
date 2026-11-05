// Browsers send a touchpad scroll and a mouse wheel as the same `wheel` event, so the kind is read off the
// deltas and held until the stream pauses, so one swipe never turns from an orbit into a zoom halfway.

export type WheelKind = "mouse" | "touchpad";

/** A pause this long (ms) between wheel events starts a new stream. */
export const STREAM_GAP_MS = 240;

/** A notch from a mouse wheel moves at least this many pixels in every engine
 *  FundaCAD runs in (WebKit 40, Chromium 100 or 53 on Linux, Firefox ~48). */
const NOTCH_MIN_PX = 30;

/** A notch's legacy wheelDelta. */
const NOTCH_LEGACY = 120;

/** macOS speeds a slow wheel notch up to a fraction of a 40 px line. */
const MAC_LINE_PX = 40;

const onMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

/** A delta macOS made from wheel lines: a non-integer on its 16.16 fixed
 *  point grid of line steps, with a legacy delta in whole steps of 12. */
function macWheelLine(d: number, wd: number): boolean {
  if (d === 0 || Number.isInteger(d) || wd === 0 || Math.abs(wd) % 12 !== 0) return false;
  const steps = (d * 65536) / MAC_LINE_PX;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

/** Room for the engine's single precision zoom in a delta multiplied back up. */
const ZOOM_ROUNDING_PX = 1e-3;

/** Whether a whole pixel `v` is left once a zoom or display scale in `scales` is undone. */
function wholePixels(v: number, scales: readonly number[]): boolean {
  if (Number.isInteger(v)) return true;
  return scales.some((s) => {
    const whole = Math.round(v * s);
    return s !== 1 && whole !== 0 && Math.abs(v * s - whole) <= ZOOM_ROUNDING_PX;
  });
}

/** Whether a legacy delta is whole notches once a scale in `scales` is undone. The engine scales it by 1/scale and
 *  truncates, so under a scale it may fall short of the multiple but never pass it; at scale 1 the match is exact. */
function wholeNotches(wd: number, scales: readonly number[]): boolean {
  const reaches = (x: number, short: number) => {
    const notches = Math.round(x / NOTCH_LEGACY);
    const under = notches * NOTCH_LEGACY - x;
    return notches !== 0 && under >= -ZOOM_ROUNDING_PX && under <= short;
  };
  return scales.some((s) => (s === 1 ? wd % NOTCH_LEGACY === 0 : reaches(wd, 1) || reaches(wd * s, Math.max(s, 1))));
}

interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
}

/** What one event says on its own, or null when it could be either. `scales` are the zoom factors the engine
 *  may have divided the deltas by: the webview zoom of Interface size, or the display scale. */
export function wheelEvidence(e: WheelLike, mac = onMac(), scales: readonly number[] = [1]): WheelKind | null {
  // Lines or pages: only a wheel scrolls by those.
  if (e.deltaMode !== 0) return "mouse";
  const legacy = e as WheelLike & { wheelDeltaX?: number; wheelDeltaY?: number };
  const dx = e.deltaX,
    dy = e.deltaY;
  // Shift turns a wheel sideways in most engines, so sideways means nothing then.
  if (!e.shiftKey && !e.ctrlKey && dx !== 0 && dy !== 0) return "touchpad";
  const wd =
    typeof legacy.wheelDeltaY === "number" && legacy.wheelDeltaY !== 0
      ? legacy.wheelDeltaY
      : typeof legacy.wheelDeltaX === "number"
        ? legacy.wheelDeltaX
        : 0;
  const big = Math.max(Math.abs(dx), Math.abs(dy));
  if (big === 0) return null;
  // A whole notch: a legacy delta that is a multiple of 120 and a notch's worth of pixels.
  if (wd !== 0 && big * Math.max(...scales) >= NOTCH_MIN_PX && wholeNotches(Math.abs(wd), scales)) return "mouse";
  // A slow notch on macOS comes as a few px and a fraction, like a touchpad's.
  if (mac && macWheelLine(dy !== 0 ? dy : dx, wd)) return "mouse";
  // Less than a notch, or a fraction of a pixel. A high resolution wheel reads as a touchpad
  // too, which the navigation setting can overrule.
  if (big < NOTCH_MIN_PX || !wholePixels(dx, scales) || !wholePixels(dy, scales)) return "touchpad";
  return null;
}

export class WheelClassifier {
  private kind: WheelKind = "mouse";
  /** The last kind an event decided, for the next stream's undecided start. */
  private seen: WheelKind | null = null;
  private last = -Infinity;

  classify(e: WheelLike, nowMs: number, scales?: readonly number[]): { kind: WheelKind; fresh: boolean } {
    const fresh = nowMs - this.last > STREAM_GAP_MS || nowMs < this.last;
    this.last = nowMs;
    const told = wheelEvidence(e, undefined, scales);
    if (fresh) this.kind = told ?? this.seen ?? "mouse";
    if (told) this.seen = told;
    return { kind: this.kind, fresh };
  }

  detected(): WheelKind | null {
    return this.seen;
  }
}
