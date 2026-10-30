import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import { usePanelsStore } from "../../src/stores/panels";
import type { CadDocument, StressStudy } from "../../src/types";

// The Stress panel's own undo against a hand-made viewport and store: it takes back setup steps while the panel is
// open, says what it took back, and never reaches the model's history.

beforeEach(() => setActivePinia(createPinia()));

// Face 1 is the bottom of body b1, face 2 its top.
const FACES: Record<number, { body: string; z: number; n: number }> = {
  1: { body: "b1", z: 0, n: -1 },
  2: { body: "b1", z: 10, n: 1 },
};

function quad(z: number, n: number): THREE.Triangle[] {
  const a = new THREE.Vector3(0, 0, z),
    b = new THREE.Vector3(10, 0, z),
    c = new THREE.Vector3(10, 10, z),
    d = new THREE.Vector3(0, 10, z);
  return n > 0
    ? [new THREE.Triangle(a, b, c), new THREE.Triangle(a, c, d)]
    : [new THREE.Triangle(a, c, b), new THREE.Triangle(a, d, c)];
}

function rig() {
  let selected: number[] = [];
  let study: StressStudy | null = null;
  const statuses: string[] = [];
  const marks: unknown[] = [];
  const docListeners: (() => void)[] = [];
  const viewport = {
    bodyDisplayMesh: () => null,
    getSelectedBodies: () => [],
    getSelectedFaceIds: () => selected,
    faceIdToBodyId: (f: number) => FACES[f]?.body ?? null,
    selectedFacesForPressPull: () =>
      selected.length
        ? {
            selectors: selected.map((f) => ({ kind: "face", by: "nearest", point: [5, 5, FACES[f]!.z] })),
            faceIds: selected,
          }
        : null,
    faceTriangles: (f: number) => (FACES[f] ? quad(FACES[f]!.z, FACES[f]!.n) : []),
    bodyProperties: () => ({ com: new THREE.Vector3(5, 5, 5) }),
    faceIdNear: (p: [number, number, number]) => {
      const hit = Object.entries(FACES).find(([, f]) => f.z === p[2]);
      return hit ? Number(hit[0]) : null;
    },
    clearSelection: () => {
      selected = [];
    },
    setFaceMarks: (m: unknown) => marks.push(m),
    setStressOverlay: () => {},
    hasStressOverlay: () => false,
  };
  const store = {
    document: { features: [] } as unknown as CadDocument,
    builtDocument: () => ({ features: [] }) as unknown as CadDocument,
    buildState: {
      result: {
        bodies: [
          { id: "b1", name: "Block", faceStart: 0, faceCount: 9 },
          { id: "b2", name: "Lid", faceStart: 9, faceCount: 1 },
        ],
      },
    },
    onDocChange: (fn: () => void) => {
      docListeners.push(fn);
      return () => {};
    },
    onOpen: () => () => {},
    isBodyVisible: () => true,
    bodyName: (): string | undefined => undefined,
    loadCount: 1,
    get stressStudy() {
      return study;
    },
    setStressStudy: (s: StressStudy | null) => {
      study = s ? structuredClone(s) : null;
    },
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const geometry = { stress: vi.fn(), cancel: vi.fn() };
  const deps = {
    store,
    viewport,
    geometry,
    hasBody: () => true,
    setStatus: (t: string) => statuses.push(t),
  } as unknown as PanelsDeps;
  const ui = createPanels(deps);
  return {
    ui,
    store,
    statuses,
    marks,
    study: () => study,
    select: (ids: number[]) => {
      selected = ids;
    },
    /** Another state of the document put in place with its own study, as a version put back. */
    replaceStudy: (s: StressStudy | null) => {
      study = s;
      docListeners.forEach((f) => f());
    },
  };
}

async function open(r: ReturnType<typeof rig>) {
  r.ui.showStress();
  r.ui.setStressBody("b1");
  await nextTick();
  return usePanelsStore().stress!;
}

describe("Stress panel undo", () => {
  it("takes back a support's faces, says so, and leaves the model's history alone", async () => {
    const r = rig();
    const d = await open(r);
    r.select([1]);
    r.ui.setStressFacesFromSelection({ support: 1 });
    await nextTick();
    expect(d.canUndo).toBe(true);

    expect(r.ui.undoStress()).toBe(true);
    expect(d.setup.supports[0]!.faces.selectors).toEqual([]);
    expect(d.setup.supports[0]!.faces.faceIds).toEqual([]);
    expect(r.statuses.at(-1)).toBe("Undid: Support 1 faces");
    expect(r.study()!.supports[0]!.faces, "the saved study follows").toEqual([]);
    expect(r.marks.at(-1)).toEqual([
      { faceIds: [], color: 0x4ac6ff },
      { faceIds: [], color: 0xff9a2e },
    ]);
    expect(r.store.undo).not.toHaveBeenCalled();
    await nextTick();
    expect(d.canUndo, "the body pick is left").toBe(true);
    expect(d.canRedo).toBe(true);

    expect(r.ui.redoStress()).toBe(true);
    expect(d.setup.supports[0]!.faces.faceIds, "the face is found again on the build").toEqual([1]);
    expect(r.statuses.at(-1)).toBe("Redid: Support 1 faces");
    expect(r.store.redo).not.toHaveBeenCalled();
  });

  it("says when nothing is left, still keeping the key from the model", async () => {
    const r = rig();
    r.ui.showStress();
    await nextTick();
    expect(r.ui.undoStress()).toBe(true);
    expect(r.statuses.at(-1)).toBe("Nothing left to undo in Stress");
    expect(r.ui.redoStress()).toBe(true);
    expect(r.statuses.at(-1)).toBe("Nothing to redo in Stress");
    expect(r.store.undo).not.toHaveBeenCalled();
  });

  it("hands the key back to the model once the panel is closed, and starts afresh when opened again", async () => {
    const r = rig();
    await open(r);
    r.ui.addStressLoad();
    await nextTick();
    r.ui.closeStress();
    const count = r.statuses.length;
    expect(r.ui.undoStress()).toBe(false);
    expect(r.ui.redoStress()).toBe(false);
    expect(r.statuses.length, "nothing said while closed").toBe(count);

    r.ui.showStress();
    await nextTick();
    expect(usePanelsStore().stress!.canUndo).toBe(false);
    expect(r.ui.undoStress()).toBe(true);
    expect(r.statuses.at(-1)).toBe("Nothing left to undo in Stress");
  });

  it("names the first face pick on a setup with no body by its row", async () => {
    const r = rig();
    r.ui.showStress();
    await nextTick();
    r.select([2]);
    r.ui.setStressFacesFromSelection({ load: 1 });
    r.ui.undoStress();
    expect(r.statuses.at(-1)).toBe("Undid: Load 1 faces");
    expect(usePanelsStore().stress!.setup.body).toBeNull();
  });

  it("stops placing on a row that undo takes away", async () => {
    const r = rig();
    const d = await open(r);
    r.ui.addStressSupport();
    await nextTick();
    r.ui.placeStressSpot({ support: 2 }, "face");
    expect(d.placing).toEqual({ support: 2 });
    r.ui.undoStress();
    expect(r.statuses.at(-1)).toBe("Undid: Add support");
    expect(d.setup.supports).toHaveLength(1);
    expect(d.placing).toBeNull();
  });

  it("folds typing in one box into one step", async () => {
    const r = rig();
    const d = await open(r);
    const was = d.setup.loads[0]!.force;
    for (const force of [1, 12, 120]) {
      d.setup.loads[0]!.force = force;
      await nextTick();
    }
    r.ui.undoStress();
    expect(r.statuses.at(-1)).toBe("Undid: Load 1 force");
    expect(d.setup.loads[0]!.force).toBe(was);
  });

  it("forgets its steps when the document's study is replaced under the open panel", async () => {
    const r = rig();
    const d = await open(r);
    r.ui.addStressSupport();
    await nextTick();
    const other = structuredClone(r.study()!);
    other.supports = other.supports.slice(0, 1);
    r.replaceStudy(other);
    await nextTick();
    expect(usePanelsStore().stress!.canUndo).toBe(false);
    expect(d).toBeDefined();
    r.ui.undoStress();
    expect(r.statuses.at(-1)).toBe("Nothing left to undo in Stress");
  });
});
