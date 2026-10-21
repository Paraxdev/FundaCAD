import { describe, expect, it } from "vitest";
import { STILL_MS, TraceGeneration, traceState, type TraceInputs } from "../../src/viewport/pathtrace/state";

const base: TraceInputs = {
  mode: "pathtraced", visible: true, stillMs: 1000, sectioned: false, xray: false,
  wireframe: false, sketchOpen: false, samples: 3, cap: 256,
};

describe("when the tracer runs", () => {
  it("traces only in Path traced, while visible and still", () => {
    expect(traceState(base)).toBe("trace");
    expect(traceState({ ...base, mode: "realtime" })).toBe("off");
    expect(traceState({ ...base, mode: "matcap" })).toBe("off");
    expect(traceState({ ...base, visible: false })).toBe("hidden");
    expect(traceState({ ...base, stillMs: STILL_MS - 1 })).toBe("moving");
    expect(traceState({ ...base, stillMs: STILL_MS })).toBe("trace");
    expect(STILL_MS).toBe(150);
  });

  it("stops at the sample cap", () => {
    expect(traceState({ ...base, samples: 255 })).toBe("trace");
    expect(traceState({ ...base, samples: 256 })).toBe("done");
    expect(traceState({ ...base, samples: 300 })).toBe("done");
  });

  it("pauses to Realtime for section view, x-ray, wireframe and an open sketch", () => {
    expect(traceState({ ...base, sectioned: true })).toBe("paused:section");
    expect(traceState({ ...base, xray: true })).toBe("paused:xray");
    expect(traceState({ ...base, wireframe: true })).toBe("paused:wireframe");
    expect(traceState({ ...base, sketchOpen: true })).toBe("paused:sketch");
    expect(traceState({ ...base, sectioned: true, samples: 256 })).toBe("paused:section");
    expect(traceState({ ...base, sketchOpen: true, stillMs: 0 })).toBe("paused:sketch");
  });

  it("keeps a hidden window idle whatever else is going on", () => {
    expect(traceState({ ...base, visible: false, sectioned: true, stillMs: 0 })).toBe("hidden");
  });
});

describe("realtime while moving", () => {
  it("draws Realtime while the view moves or a gizmo drags, by default", () => {
    expect(traceState({ ...base, stillMs: 10 })).toBe("moving");
    expect(traceState({ ...base, dragging: true })).toBe("moving");
    expect(traceState({ ...base, stillMs: 10, realtimeWhileMoving: true })).toBe("moving");
  });

  it("keeps tracing through every move when turned off", () => {
    const off = { ...base, realtimeWhileMoving: false };
    expect(traceState({ ...off, stillMs: 10 })).toBe("trace");
    expect(traceState({ ...off, dragging: true })).toBe("trace");
    expect(traceState({ ...off, stillMs: 10, samples: 256 })).toBe("done");
  });

  it("still pauses for a section view when turned off", () => {
    expect(traceState({ ...base, realtimeWhileMoving: false, stillMs: 10, sectioned: true })).toBe("paused:section");
  });
});

describe("trace generation", () => {
  it("drops a result from before the last camera move or scene change", () => {
    const g = new TraceGeneration();
    const first = g.current;
    expect(g.isCurrent(first)).toBe(true);
    g.bump();
    expect(g.isCurrent(first)).toBe(false);
    expect(g.isCurrent(g.current)).toBe(true);
    expect(g.current).toBe(first + 1);
  });
});
