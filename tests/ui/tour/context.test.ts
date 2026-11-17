import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useExportDialogStore } from "../../../src/stores/exportDialog";
import type { Feature } from "../../../src/types";
import { tourContext, type TourHost } from "../../../src/ui/tour/context";

beforeEach(() => {
  setActivePinia(createPinia());
});

const line = (construction = false) => ({
  type: "line",
  x1: 0,
  y1: 0,
  x2: 1,
  y2: 0,
  ...(construction ? { construction } : {}),
});

interface World {
  planePick?: boolean;
  sketch?: { tool: string; entities: object[]; regions: number } | null;
  running?: string | null;
  features?: Feature[];
  bodies?: number | null;
  building?: boolean;
}

function host(w: World = {}): TourHost {
  const sk = w.sketch ?? null;
  return {
    planePick: w.planePick ?? false,
    sketch: {
      active: !!sk,
      tool: sk?.tool ?? "select",
      snapshotFeature: () => (sk ? { id: "f9", type: "sketch", plane: "XZ", entities: sk.entities } : null),
    },
    overlay: { activeRegionCount: sk?.regions ?? 3 },
    // runningTool reads each tool's `active` in turn, the one named is running.
    tools: new Proxy({}, { get: (_, k) => ({ active: k === w.running, cancel: () => {} }) }),
    store: {
      document: { features: w.features ?? [] },
      buildState: {
        building: w.building ?? false,
        result:
          w.bodies == null ? null : { bodies: Array.from({ length: w.bodies }, (_, i) => ({ id: `body${i + 1}` })) },
      },
    },
  } as unknown as TourHost;
}

describe("tourContext", () => {
  it("reads a closed sketch as no sketch, no entities and no areas", () => {
    const c = tourContext(host());
    expect([c.planePick(), c.sketchOpen(), c.tool(), c.entities(), c.entities("line"), c.regions()]).toEqual([
      false,
      false,
      null,
      0,
      0,
      0,
    ]);
    expect(tourContext(host({ planePick: true })).planePick()).toBe(true);
  });

  it("reads an open sketch with nothing drawn", () => {
    const c = tourContext(host({ sketch: { tool: "line", entities: [], regions: 0 } }));
    expect([c.sketchOpen(), c.tool(), c.entities(), c.entities("line"), c.regions()]).toEqual([true, "line", 0, 0, 0]);
  });

  it("counts an open sketch's entities by type, construction left out, and its closed areas", () => {
    const entities = [...Array.from({ length: 6 }, () => line()), line(true), { type: "circle", radius: 3 }];
    const c = tourContext(host({ sketch: { tool: "select", entities, regions: 1 } }));
    expect([c.tool(), c.entities(), c.entities("line"), c.entities("circle"), c.entities("arc"), c.regions()]).toEqual([
      "select",
      7,
      6,
      1,
      0,
      1,
    ]);
  });

  it("names the running model tool by its action, and none when nothing runs", () => {
    expect(tourContext(host({ running: "extrude" })).tool()).toBe("extrude");
    expect(tourContext(host({ running: "edgeFeature" })).tool()).toBe("fillet");
    expect(tourContext(host({ running: "hole" })).tool()).toBe("hole");
    expect(tourContext(host({ running: null })).tool()).toBeNull();
  });

  it("counts features by type and gives the newest of a type", () => {
    const features = [
      { id: "f1", type: "sketch" },
      { id: "f2", type: "extrude", distance: 25 },
      { id: "f3", type: "fillet" },
      { id: "f4", type: "extrude", distance: 10 },
    ] as unknown as Feature[];
    const c = tourContext(host({ features }));
    expect([c.features(), c.features("extrude"), c.features("hole")]).toEqual([4, 2, 0]);
    expect(c.latest("extrude")).toMatchObject({ id: "f4", distance: 10 });
    expect(c.latest("hole")).toBeNull();
    expect(tourContext(host()).features()).toBe(0);
  });

  it("reads bodies and whether a build runs", () => {
    expect([tourContext(host()).bodies(), tourContext(host({ bodies: 0 })).bodies()]).toEqual([0, 0]);
    const c = tourContext(host({ bodies: 2, building: true }));
    expect([c.bodies(), c.building()]).toEqual([2, true]);
    expect(tourContext(host()).building()).toBe(false);
  });

  it("sees the Export dialog open and closed", () => {
    const c = tourContext(host());
    expect(c.exportOpen()).toBe(false);
    const dialog = useExportDialogStore();
    void dialog.open({ bodies: [] });
    expect(c.exportOpen()).toBe(true);
    dialog.finish(null);
    expect(c.exportOpen()).toBe(false);
  });
});
