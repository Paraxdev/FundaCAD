// Reading a wheel stream as a mouse wheel or a touchpad, from the deltas the
// engines FundaCAD runs in send for each.

import { describe, expect, it } from "vitest";
import { STREAM_GAP_MS, WheelClassifier, wheelEvidence } from "../../../src/viewport/navigator/wheelKind";

const ev = (
  init: Partial<{
    deltaX: number;
    deltaY: number;
    deltaMode: number;
    shiftKey: boolean;
    ctrlKey: boolean;
    wheelDeltaY: number;
    wheelDeltaX: number;
  }>,
) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, ...init });

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

describe("wheelEvidence under a webview zoom or display scale", () => {
  // Measured in Chromium page zoom: deltaY is 100 / zoom and wheelDeltaY the truncated 120 / zoom.
  const measured: [number, number, number][] = [
    [0.8, 125, -149],
    [1.1, 90.90908893868948, -109],
    [1.25, 80, -96],
    [1.5, 66.66666666666667, -80],
    [1.75, 57.142857142857146, -68],
    [2, 50, -60],
  ];

  it.each(measured)("reads a mouse notch at %s as a mouse", (zoom, deltaY, wheelDeltaY) => {
    expect(wheelEvidence(ev({ deltaY, wheelDeltaY }), false, [1, zoom])).toBe("mouse");
    expect(wheelEvidence(ev({ deltaY: -deltaY, wheelDeltaY: -wheelDeltaY }), false, [zoom])).toBe("mouse");
  });

  it("reads a one line notch at 200 percent as a mouse", () => {
    expect(wheelEvidence(ev({ deltaY: 100 / 6, wheelDeltaY: -60 }), false, [2])).toBe("mouse");
  });

  it("reads a display scaled notch whose legacy delta lost a unit as a mouse", () => {
    expect(wheelEvidence(ev({ deltaY: 100, wheelDeltaY: -119 }), false, [1.1])).toBe("mouse");
  });

  it("still reads a touchpad as a touchpad at any size", () => {
    for (const zoom of [0.8, 1.1, 1.5, 2]) {
      expect(wheelEvidence(ev({ deltaY: 3.7 / zoom, wheelDeltaY: -11 }), false, [1, zoom])).toBe("touchpad");
      expect(wheelEvidence(ev({ deltaY: 37.3 / zoom, wheelDeltaY: -112 }), false, [1, zoom])).toBe("touchpad");
      expect(wheelEvidence(ev({ deltaX: 2.5, deltaY: 60 / zoom }), false, [1, zoom])).toBe("touchpad");
    }
  });

  it("keeps the 100 percent answers exact", () => {
    expect(wheelEvidence(ev({ deltaY: 100, wheelDeltaY: -119 }), false, [1])).toBe(null);
    expect(wheelEvidence(ev({ deltaY: 90.9, wheelDeltaY: -120 }), false, [1])).toBe("mouse");
  });

  it("holds a mouse stream at zoom through the classifier", () => {
    const c = new WheelClassifier();
    const e = ev({ deltaY: 90.90908893868948, wheelDeltaY: -109 });
    expect(c.classify(e, 0, [1, 1.1])).toEqual({ kind: "mouse", fresh: true });
    expect(c.detected()).toBe("mouse");
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
