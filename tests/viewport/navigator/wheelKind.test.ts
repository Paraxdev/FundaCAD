// Reading a wheel stream as a mouse wheel or a touchpad, from the deltas the
// engines FundaCAD runs in send for each.

import { describe, expect, it } from "vitest";
import { STREAM_GAP_MS, WheelClassifier, wheelEvidence } from "../../../src/viewport/navigator/wheelKind";

const ev = (init: Partial<{ deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean; ctrlKey: boolean; wheelDeltaY: number; wheelDeltaX: number }>) =>
  ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, ...init });

describe("wheelEvidence", () => {
  it("reads whole notches as a mouse", () => {
    expect(wheelEvidence(ev({ deltaY: 100, wheelDeltaY: -120 }))).toBe("mouse"); // Chromium
    expect(wheelEvidence(ev({ deltaY: 53.33, wheelDeltaY: -120 }))).toBe("mouse"); // Chromium on Linux
    expect(wheelEvidence(ev({ deltaY: -40, wheelDeltaY: 120 }))).toBe("mouse"); // WebKit
    expect(wheelEvidence(ev({ deltaY: 3, deltaMode: 1 }))).toBe("mouse"); // Firefox, in lines
  });

  it("reads small, fractional or two-axis deltas as a touchpad", () => {
    expect(wheelEvidence(ev({ deltaY: 4, wheelDeltaY: -12 }))).toBe("touchpad");
    expect(wheelEvidence(ev({ deltaY: 37.5, wheelDeltaY: -112 }))).toBe("touchpad");
    expect(wheelEvidence(ev({ deltaX: 2, deltaY: 60 }))).toBe("touchpad");
  });

  it("reads a slow macOS wheel notch as a mouse, on macOS only", () => {
    expect(wheelEvidence(ev({ deltaY: 4.000244140625, wheelDeltaY: -12 }), true)).toBe("mouse");
    expect(wheelEvidence(ev({ deltaY: -8.00048828125, wheelDeltaY: 24 }), true)).toBe("mouse");
    expect(wheelEvidence(ev({ deltaY: 4, wheelDeltaY: -12 }), true)).toBe("touchpad");
    expect(wheelEvidence(ev({ deltaY: 4.5, wheelDeltaY: -13 }), true)).toBe("touchpad");
    expect(wheelEvidence(ev({ deltaY: 4.000244140625, wheelDeltaY: -12 }), false)).toBe("touchpad");
  });

  it("says nothing about a sideways Shift scroll or an empty event", () => {
    expect(wheelEvidence(ev({ deltaX: 100, shiftKey: true, wheelDeltaX: -120 }))).toBe("mouse");
    expect(wheelEvidence(ev({ deltaX: 60, deltaY: 60, shiftKey: true }))).toBe(null);
    expect(wheelEvidence(ev({}))).toBe(null);
  });
});

describe("WheelClassifier", () => {
  it("holds a stream's kind until it pauses", () => {
    const c = new WheelClassifier();
    expect(c.classify(ev({ deltaY: 3.5 }), 0)).toEqual({ kind: "touchpad", fresh: true });
    // A fast swipe's big step mid-stream does not turn it into a zoom.
    expect(c.classify(ev({ deltaY: 40, wheelDeltaY: -120 }), 16)).toEqual({ kind: "touchpad", fresh: false });
    expect(c.classify(ev({ deltaY: 100, wheelDeltaY: -120 }), 16 + STREAM_GAP_MS + 1).kind).toBe("mouse");
  });

  it("starts an undecided stream as the last decided one", () => {
    const c = new WheelClassifier();
    expect(c.classify(ev({ deltaY: 60 }), 0).kind).toBe("mouse");
    c.classify(ev({ deltaY: 2.25 }), 1000);
    expect(c.classify(ev({ deltaY: 60 }), 2000).kind).toBe("touchpad");
    expect(c.detected()).toBe("touchpad");
  });
});
