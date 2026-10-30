import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import { usePanelsStore } from "../../src/stores/panels";
import type { StressOptions, StressResult } from "../../src/geometry/client";
import type { CadDocument, StressStudy } from "../../src/types";

// The finer answer of a Run: the engine says a finer mesh is past its limits, the store keeps the offer beside the
// error, and running with it asks for that once.

beforeEach(() => setActivePinia(createPinia()));

const FACES: Record<number, number> = { 1: 0, 2: 10 };
const offer = { elements: 90000, seconds: 120 };

function rig() {
  let selected: number[] = [];
  let settle: (r: StressResult) => void = () => {};
  const calls: StressOptions[] = [];
  const viewport = {
    bodyDisplayMesh: () => null,
    getSelectedBodies: () => [],
    getSelectedFaceIds: () => selected,
    faceIdToBodyId: () => "b1",
    selectedFacesForPressPull: () => ({
      selectors: selected.map((f) => ({ kind: "face", by: "nearest", point: [5, 5, FACES[f]!] })),
      faceIds: selected,
    }),
    faceTriangles: (f: number) => [
      new THREE.Triangle(
        new THREE.Vector3(0, 0, FACES[f]!),
        new THREE.Vector3(10, 0, FACES[f]!),
        new THREE.Vector3(0, 10, FACES[f]!),
      ),
    ],
    bodyProperties: () => ({ com: new THREE.Vector3(5, 5, 5) }),
    faceIdNear: (p: [number, number, number]) => (p[2] === 0 ? 1 : 2),
    clearSelection: () => {
      selected = [];
    },
    setFaceMarks: () => {},
    setStressOverlay: () => {},
    hasStressOverlay: () => false,
  };
  const store = {
    document: { features: [] } as unknown as CadDocument,
    builtDocument: () => ({ features: [] }) as unknown as CadDocument,
    buildState: { result: { bodies: [{ id: "b1", name: "Plate", faceStart: 0, faceCount: 9 }] } },
    onDocChange: () => () => {},
    onOpen: () => () => {},
    isBodyVisible: () => true,
    bodyName: () => undefined,
    loadCount: 1,
    stressStudy: null as StressStudy | null,
    setStressStudy: () => {},
  };
  const geometry = {
    stress: (_doc: CadDocument, _body: string, opts: StressOptions) => {
      calls.push(opts);
      return new Promise<StressResult>((res) => {
        settle = res;
      });
    },
    cancel: async () => true,
  };
  const deps = {
    store,
    viewport,
    geometry,
    hasBody: () => true,
    setStatus: () => {},
    stressGlyphs: () => ({
      setModel: () => {},
      setProbe: () => {},
      setProbePins: () => {},
      setPlacing: () => {},
      setWeakSpot: () => {},
      dispose: () => {},
    }),
  } as unknown as PanelsDeps;
  const ui = createPanels(deps);
  ui.showStress();
  selected = [1];
  ui.setStressFacesFromSelection({ support: 1 });
  selected = [2];
  ui.setStressFacesFromSelection({ load: 1 });
  return { ui, calls, settle: (r: StressResult) => settle(r) };
}

describe("the finer answer of a stress Run", () => {
  it("keeps the offer beside the error, and an ordinary Run does not ask for it", async () => {
    const r = rig();
    const run = r.ui.runStress();
    expect(r.calls[0]!.finer).toBeUndefined();
    r.settle({ ok: false, message: "the mesh would take long", finer: offer });
    await run;
    const s = usePanelsStore().stress!;
    expect(s.error).not.toBeNull();
    expect(s.finer).toEqual(offer);
  });

  it("asks for finer once when run with the offer, and the next Run drops it again", async () => {
    const r = rig();
    const first = r.ui.runStress();
    r.settle({ ok: false, message: "the mesh would take long", finer: offer });
    await first;

    const finer = r.ui.runStress(true);
    expect(r.calls[1]!.finer).toBe(true);
    expect(usePanelsStore().stress!.finer, "cleared while it runs").toBeNull();
    r.settle({ ok: false, message: "out of memory" });
    await finer;
    expect(usePanelsStore().stress!.finer).toBeNull();

    const plain = r.ui.runStress();
    expect(r.calls[2]!.finer).toBeUndefined();
    r.settle({ ok: false, cancelled: true, message: "stress analysis cancelled" });
    await plain;
    expect(usePanelsStore().stress!.finer).toBeNull();
  });
});
