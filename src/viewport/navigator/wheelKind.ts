// Telling a touchpad's two-finger scroll from a mouse wheel.
//
// Browsers deliver both as `wheel` events and say nothing about the device, so
// the kind is read off the deltas: a wheel turns in notches (a whole line, or a
// pixel count whose legacy `wheelDelta` is a multiple of 120), a touchpad
// streams small, uneven pixel deltas that often carry a sideways part. The kind
// is decided on the first event of a stream and held until the stream pauses,
// so one swipe never turns from an orbit into a zoom halfway through. An event
// that says nothing either way takes the kind the last telling event had.

export type WheelKind = "mouse" | "touchpad";

/** A pause this long (ms) between wheel events starts a new stream. */
export const STREAM_GAP_MS = 240;

/** A notch from a mouse wheel moves at least this many pixels in every engine
 *  FundaCAD runs in (WebKit 40, Chromium 100 or 53 on Linux, Firefox ~48). */
const NOTCH_MIN_PX = 30;

/** macOS speeds a slow wheel notch up to a fraction of a 40 px line. */
const MAC_LINE_PX = 40;

const onMac = () =>
  typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

/** A delta macOS made from wheel lines: a non-integer on its 16.16 fixed
 *  point grid of line steps, with a legacy delta in whole steps of 12. */
function macWheelLine(d: number, wd: number): boolean {
  if (d === 0 || Number.isInteger(d) || wd === 0 || Math.abs(wd) % 12 !== 0) return false;
  const steps = (d * 65536) / MAC_LINE_PX;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
}

/** What one event says on its own, or null when it could be either. */
export function wheelEvidence(e: WheelLike, mac = onMac()): WheelKind | null {
  // Lines or pages: only a wheel scrolls by those.
  if (e.deltaMode !== 0) return "mouse";
  const legacy = e as WheelLike & { wheelDeltaX?: number; wheelDeltaY?: number };
  const dx = e.deltaX, dy = e.deltaY;
  // Shift turns a wheel sideways in most engines, so sideways means nothing then.
  if (!e.shiftKey && !e.ctrlKey && dx !== 0 && dy !== 0) return "touchpad";
  const wd = typeof legacy.wheelDeltaY === "number" && legacy.wheelDeltaY !== 0
    ? legacy.wheelDeltaY
    : typeof legacy.wheelDeltaX === "number" ? legacy.wheelDeltaX : 0;
  const big = Math.max(Math.abs(dx), Math.abs(dy));
  if (big === 0) return null;
  // A whole notch: the legacy delta is a multiple of 120 and the move is a
  // notch's worth of pixels.
  if (wd !== 0 && Math.abs(wd) % 120 === 0 && big >= NOTCH_MIN_PX) return "mouse";
  // A slow notch on macOS comes as a few px and a fraction, like a touchpad's.
  if (mac && macWheelLine(dy !== 0 ? dy : dx, wd)) return "mouse";
  // Less than a notch, or a fraction of a pixel: a touchpad's stream.
  // (A high resolution wheel sends small steps too and reads as a touchpad,
  // which the navigation setting can overrule.)
  if (big < NOTCH_MIN_PX || !Number.isInteger(dx) || !Number.isInteger(dy)) return "touchpad";
  return null;
}

/** The kind of each wheel event, held for a stream. */
export class WheelClassifier {
  private kind: WheelKind = "mouse";
  /** The last kind an event decided, for the next stream's undecided start. */
  private seen: WheelKind | null = null;
  private last = -Infinity;

  /** The kind of `e`, arriving at `nowMs`, and whether it starts a new stream. */
  classify(e: WheelLike, nowMs: number): { kind: WheelKind; fresh: boolean } {
    const fresh = nowMs - this.last > STREAM_GAP_MS || nowMs < this.last;
    this.last = nowMs;
    const told = wheelEvidence(e);
    if (fresh) this.kind = told ?? this.seen ?? "mouse";
    if (told) this.seen = told;
    return { kind: this.kind, fresh };
  }

  /** The kind the last stream was read as, null before any wheel. */
  detected(): WheelKind | null {
    return this.seen;
  }
}
