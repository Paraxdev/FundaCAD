import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import { usePanelsStore } from "../../src/stores/panels";
import type { CadDocument } from "../../src/types";

// The Properties readout against a hand-made build: a body the engine says is
// not a sound solid gets the engine's reason in place of a volume and a mass,
// the viewport mesh it would have been summed from has no inside to measure.

beforeEach(() => setActivePinia(createPinia()));

const OPEN = "is not a closed solid, 4 of its edges bound only one face, so it has no inside";

function rig(bodies: { id: string; name: string; fault?: string }[], selected: string[] = []) {
  const setComMarker = vi.fn();
  const deps = {
    store: {
      document: { features: [] } as unknown as CadDocument,
      buildState: { result: { bodies } },
      onDocChange: () => {},
      onOpen: () => {},
    },
    viewport: {
      getSelectedBodies: () => selected,
      bodyProperties: (ids: string[] | null) => {
        const measured = ids ?? bodies.map((b) => b.id);
        return {
          volume: 833.333,
          area: 500,
          com: new THREE.Vector3(0, 0, 4.5),
          bbox: new THREE.Box3(new THREE.Vector3(-5, -5, 0), new THREE.Vector3(5, 5, 10)),
          ids: measured,
          names: bodies.filter((b) => measured.includes(b.id)).map((b) => b.name),
        };
      },
      setComMarker,
    },
    geometry: {},
    hasBody: () => true,
    setStatus: () => {},
  } as unknown as PanelsDeps;
  return { panels: createPanels(deps), setComMarker };
}

const keys = () => usePanelsStore().properties?.rows.map((r) => r.k);

describe("the Properties panel", () => {
  it("gives a sound body its volume and the numbers for its mass", () => {
    const { panels, setComMarker } = rig([{ id: "body1", name: "Casing" }]);
    panels.showProperties();
    const p = usePanelsStore().properties!;
    expect(keys()).toEqual(["Volume", "Surface area", "Center of mass", "Bounding box"]);
    expect(p.raw).toEqual({ volumeMm3: 833.333, areaMm2: 500 });
    expect(p.faults).toEqual([]);
    expect(setComMarker).toHaveBeenCalledWith(expect.any(THREE.Vector3));
  });

  it("says a body is not a sound solid and why, with no volume or mass", () => {
    const { panels, setComMarker } = rig([{ id: "body1", name: "Casing", fault: OPEN }]);
    panels.showProperties();
    const p = usePanelsStore().properties!;
    expect(keys()).toEqual(["Surface area", "Bounding box"]);
    expect(p.raw).toBeNull();
    expect(p.faults).toEqual([`Casing ${OPEN}`]);
    expect(setComMarker).not.toHaveBeenCalledWith(expect.any(THREE.Vector3));
  });

  it("gives no total when one of the bodies it sums is not sound", () => {
    const { panels } = rig([
      { id: "body1", name: "Casing" },
      { id: "body2", name: "Lid", fault: "is inside out, its faces point into the material" },
    ]);
    panels.showProperties();
    const p = usePanelsStore().properties!;
    expect(p.raw).toBeNull();
    expect(p.faults).toEqual(["Lid is inside out, its faces point into the material"]);
  });

  it("measures a selected sound body beside an unsound one it was not asked about", () => {
    const { panels } = rig(
      [
        { id: "body1", name: "Casing" },
        { id: "body2", name: "Lid", fault: OPEN },
      ],
      ["body1"],
    );
    panels.showProperties();
    const p = usePanelsStore().properties!;
    expect(p.raw).toEqual({ volumeMm3: 833.333, areaMm2: 500 });
    expect(p.faults).toEqual([]);
  });
});
