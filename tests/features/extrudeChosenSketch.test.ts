// Create > Extrude on a sketch picked in the tree that an earlier extrude
// consumed and hid: it starts a NEW extrude of that sketch rather than having
// nothing to click (FRAME tester, reusing one profile for a second extrude).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { toast } from "../../src/ui/toast";

vi.mock("../../src/ui/toast", () => ({ toast: vi.fn(() => 1), dismissToast: vi.fn() }));

function rig(opts: { selected?: string | null; explicit?: boolean; regions?: { sketchId: string }[]; startOk?: boolean; f1?: Record<string, unknown> }) {
  const start = vi.fn((_done: unknown, _opts?: unknown) => opts.startOk ?? true);
  const setStatus = vi.fn();
  const addFeature = vi.fn();
  const deps = {
    store: {
      document: {
        parameters: {},
        features: [
          { id: "f1", type: "sketch", ...opts.f1 },
          { id: "f2", type: "sketch" },
          { id: "f3", type: "extrude", sketch: "f1", distance: 20 },
        ],
      },
      buildState: { result: { bodies: [{ id: "b1" }], mesh: { positions: [0] } } },
      addFeature,
      nextId: () => "f9",
    },
    viewport: { selectedFacesForPressPull: () => null },
    overlay: { regions: opts.regions ?? [], selectedRegions: () => [] },
    extrude: { start },
    pressPull: { start: vi.fn() },
    toolBusy: () => false,
    hasBody: () => true,
    setStatus,
    selectFeature: vi.fn(),
    noteCommitted: vi.fn(),
    isSketchConsumed: (id: string) => id === "f1",
    getSelectedFeature: () => opts.selected ?? null,
    getSelectedFeatureExplicit: () => opts.explicit ?? true,
  } as unknown as FeatureStartersDeps;
  return { starters: createFeatureStarters(deps), start, setStatus, addFeature };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(toast).mockClear();
});

describe("Create > Extrude with a consumed sketch chosen in the tree", () => {
  it("starts a new extrude of that sketch", () => {
    const r = rig({ selected: "f1", regions: [{ sketchId: "f2" }] });
    r.starters.startExtrude();
    expect(r.start).toHaveBeenCalledTimes(1);
    expect(r.start.mock.calls[0]![1]).toEqual({ sketch: "f1" });
  });

  it("works when no other sketch is showing, where it used to refuse", () => {
    const r = rig({ selected: "f1" });
    r.starters.startExtrude();
    expect(r.start.mock.calls[0]![1]).toEqual({ sketch: "f1" });
    expect(r.setStatus).not.toHaveBeenCalled();
  });

  it("says so when the chosen sketch has no closed profile", () => {
    const r = rig({ selected: "f1", startOk: false });
    r.starters.startExtrude();
    expect(r.setStatus).toHaveBeenCalledWith("That sketch has no closed profile or curve to extrude", "");
  });

  it("offers Tie Loose Ends for a square with a gap instead of making a thin wall of it", () => {
    const line = (id: string, x1: number, y1: number, x2: number, y2: number) => ({ type: "line", id, x1, y1, x2, y2 });
    const square = [line("a", 0, 0, 20, 0), line("b", 20, 0, 20, 20), line("c", 20, 20, 0, 20), line("d", 0, 20, 0, 0.05)];
    const r = rig({ selected: "f1", startOk: false, f1: { entities: square, constraints: [], plane: "XY" } });
    r.starters.startExtrude();
    expect(r.setStatus.mock.calls[0]![0]).toMatch(/^That sketch has no closed profile to extrude/);
    expect(r.addFeature).not.toHaveBeenCalled();
  });

  it("a sketch that is showing keeps the plain pick", () => {
    const r = rig({ selected: "f2", regions: [{ sketchId: "f2" }] });
    r.starters.startExtrude();
    expect(r.start.mock.calls[0]![1]).toBeUndefined();
  });

  it("the app's own auto-selection is not a choice", () => {
    const r = rig({ selected: "f1", explicit: false, regions: [{ sketchId: "f2" }] });
    r.starters.startExtrude();
    expect(r.start.mock.calls[0]![1]).toBeUndefined();
  });

  it("a selected extrude is not a sketch choice", () => {
    const r = rig({ selected: "f3", regions: [{ sketchId: "f2" }] });
    r.starters.startExtrude();
    expect(r.start.mock.calls[0]![1]).toBeUndefined();
  });
});

describe("Create > Extrude on a sketch with a gap", () => {
  const line = (id: string, x1: number, y1: number, x2: number, y2: number) => ({ type: "line", id, x1, y1, x2, y2 });
  const co = (e1: string, p1: number, e2: string, p2: number) => ({ type: "coincident", e1, p1, e2, p2 });
  const square = [line("a", 0, 0, 50, 0), line("b", 50, 0, 50, 50), line("c", 50, 50, 0, 50), line("d", 0, 50, 0, 3)];
  const corners = [co("a", 1, "b", 0), co("b", 1, "c", 0), co("c", 1, "d", 0)];
  const ell = { entities: [line("a", 0, 0, 50, 0), line("b", 50, 0, 50, 50)], constraints: [co("a", 1, "b", 0)], plane: "XY" };
  const gapped = { entities: square, constraints: corners, plane: "XY" };

  it("a 3 mm gap on a 50 mm square is named and offered a fix, not walled", () => {
    const r = rig({ selected: "f1", startOk: false, f1: gapped });
    r.starters.startExtrude();
    expect(r.addFeature).not.toHaveBeenCalled();
    expect(r.setStatus.mock.calls[0]![0]).toMatch(/3 mm gap/);
    expect(toast).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(toast).mock.calls[0]![1]!;
    expect(opts.action?.label).toBe("Close gap");
  });

  it("pressing Extrude again on the gap makes the thin wall the toast named, with no second toast", () => {
    const r = rig({ selected: "f1", startOk: false, f1: gapped });
    r.starters.startExtrude();
    r.starters.startExtrude();
    expect(r.addFeature).toHaveBeenCalledTimes(1);
    expect(r.addFeature.mock.calls[0]![0]).toMatchObject({ type: "extrude", thin: true, sketch: "f1" });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("once the toast has gone, Extrude on the gap asks again instead of walling it", () => {
    vi.useFakeTimers();
    try {
      const r = rig({ selected: "f1", startOk: false, f1: gapped });
      r.starters.startExtrude();
      vi.advanceTimersByTime(10_000);
      r.starters.startExtrude();
      expect(r.addFeature).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a clearly open L still extrudes as a thin wall at once", () => {
    const r = rig({ selected: "f1", startOk: false, f1: ell });
    r.starters.startExtrude();
    expect(r.addFeature).toHaveBeenCalledTimes(1);
    expect(r.setStatus.mock.calls[0]![0]).toMatch(/^Thin extrude/);
    expect(toast).not.toHaveBeenCalled();
  });
});
