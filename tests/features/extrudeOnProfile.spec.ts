import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";

vi.mock("../../src/ui/toast", () => ({ toast: vi.fn(() => 1), dismissToast: vi.fn() }));
vi.mock("../../src/sketch/regionSelect", async (orig) => ({
  ...(await orig<typeof import("../../src/sketch/regionSelect")>()),
  worldPointInRegion: () => true,
}));

function rig(regions: { sketchId: string }[]) {
  const start = vi.fn((_done: unknown, _opts?: unknown) => true);
  const toggleRegionSelection = vi.fn();
  const deps = {
    store: {
      document: {
        parameters: {},
        features: [
          { id: "f1", type: "sketch" },
          { id: "f2", type: "sketch" },
        ],
      },
      buildState: { result: { bodies: [{ id: "b1" }], mesh: { positions: [0] } } },
      addFeature: vi.fn(),
      nextId: () => "f9",
    },
    viewport: { selectedFacesForPressPull: () => null },
    overlay: { regions, selectedRegions: () => [], clearRegionSelection: vi.fn(), toggleRegionSelection },
    extrude: { start },
    pressPull: { start: vi.fn() },
    toolBusy: () => false,
    hasBody: () => true,
    setStatus: vi.fn(),
    selectFeature: vi.fn(),
    noteCommitted: vi.fn(),
    isSketchConsumed: () => false,
    getSelectedFeature: () => null,
    getSelectedFeatureExplicit: () => false,
  } as unknown as FeatureStartersDeps;
  return { starters: createFeatureStarters(deps), start, toggleRegionSelection };
}

beforeEach(() => setActivePinia(createPinia()));

describe("Extrude on the profile a carry on picked", () => {
  const at = { point: [10, 0, 5] as [number, number, number], sketch: "f1" };

  it("takes the picked sketch's area at that point", () => {
    const own = { sketchId: "f1" };
    const r = rig([{ sketchId: "f2" }, own]);
    r.starters.startExtrudeOn("f3", at);
    expect(r.toggleRegionSelection).toHaveBeenCalledWith(own, false);
    expect(r.start.mock.calls[0]![1]).toEqual({ restsOn: "f3" });
  });

  it("never takes another sketch's area at the same point, it opens the picked sketch by name", () => {
    const r = rig([{ sketchId: "f2" }]);
    r.starters.startExtrudeOn("f3", at);
    expect(r.toggleRegionSelection).not.toHaveBeenCalled();
    expect(r.start.mock.calls[0]![1]).toEqual({ restsOn: "f3", sketch: "f1", at: [at.point] });
  });
});
