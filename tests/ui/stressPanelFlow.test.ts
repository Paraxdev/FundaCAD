import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import { usePanelsStore } from "../../src/stores/panels";
import type { StressOptions, StressReply, StressResult } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";

// The Stress panel's facade against a hand-made viewport, store and engine:
// faces come from the selection stamped with their body, Run sends what the
// setup says, Cancel names its own request, and the colours go on the body.

beforeEach(() => setActivePinia(createPinia()));

type FaceMap = Record<number, { body: string; z: number; n: number }>;
// Face 1 is the bottom of body b1 (normal -Z), face 2 its top (+Z), face 9 on b2.
const FIRST: FaceMap = {
  1: { body: "b1", z: 0, n: -1 },
  2: { body: "b1", z: 10, n: 1 },
  9: { body: "b2", z: 0, n: 1 },
};

function quad(z: number, n: number): THREE.Triangle[] {
  const a = new THREE.Vector3(0, 0, z), b = new THREE.Vector3(10, 0, z), c = new THREE.Vector3(10, 10, z), d = new THREE.Vector3(0, 10, z);
  return n > 0 ? [new THREE.Triangle(a, b, c), new THREE.Triangle(a, c, d)] : [new THREE.Triangle(a, c, b), new THREE.Triangle(a, d, c)];
}

const reply: StressReply = {
  body: "b1",
  name: "Block",
  material: { name: "PLA", E: 3500, nu: 0.36, yield: 50 },
  mesh: { nodes: 10, elements: 20, size: 2, minDihedral: 12 },
  maxVonMises: { value: 4, at: [0, 0, 0], face: 0 },
  maxDisplacement: { value: 0.01, at: [5, 5, 10], vector: [0, 0, -0.01] },
  safetyFactor: 12.5,
  applied: [0, 0, -100],
  reaction: [0, 0, 100],
  surface: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], vonMises: [1, 4, 2] },
};

function rig() {
  // The current tessellation's display faces; a rebuild may renumber them.
  let FACES: FaceMap = FIRST;
  let selected: number[] = [];
  let shown = false;
  const openListeners: (() => void)[] = [];
  const marks: unknown[] = [];
  const overlays: unknown[] = [];
  const statuses: string[] = [];
  const calls: { body: string; opts: StressOptions; doc: CadDocument }[] = [];
  const cancels: (string | undefined)[] = [];
  const docListeners: (() => void)[] = [];
  let settle: (r: StressResult) => void = () => {};

  const viewport = {
    getSelectedBodies: () => [],
    getSelectedFaceIds: () => selected,
    faceIdToBodyId: (f: number) => FACES[f]?.body ?? null,
    selectedFacesForPressPull: () =>
      selected.length
        ? { selectors: selected.map((f) => ({ kind: "face", by: "nearest", point: [5, 5, FACES[f]!.z] })), faceIds: selected }
        : null,
    faceTriangles: (f: number) => quad(FACES[f]!.z, FACES[f]!.n),
    // Every test face spans x, y 0..10, so its height alone finds it.
    faceIdNear: (p: [number, number, number]) => {
      const hit = Object.entries(FACES).find(([, f]) => f.z === p[2]);
      return hit ? Number(hit[0]) : null;
    },
    clearSelection: () => { selected = []; },
    setFaceMarks: (m: unknown) => marks.push(m),
    setStressOverlay: (o: unknown) => { overlays.push(o); shown = o !== null; },
    hasStressOverlay: () => shown,
  };
  const built = { features: [{ id: "on-screen" }] } as unknown as CadDocument;
  const store = {
    document: { features: [] } as unknown as CadDocument,
    // What the model on screen was built from: rolled back, suppressions out.
    builtDocument: () => built,
    buildState: { result: { bodies: [{ id: "b1", name: "Block" }, { id: "b2", name: "Lid" }] } },
    onDocChange: (fn: () => void) => { docListeners.push(fn); fn(); return () => {}; },
    onOpen: (fn: () => void) => { openListeners.push(fn); return () => {}; },
    isBodyVisible: () => true,
  };
  const geometry = {
    stress: (_doc: CadDocument, body: string, opts: StressOptions, onStarted?: (id: string) => void) => {
      calls.push({ body, opts, doc: _doc });
      onStarted?.(`req-${calls.length}`);
      return new Promise<StressResult>((res) => { settle = res; });
    },
    cancel: async (id?: string) => { cancels.push(id); return true; },
  };
  const deps = {
    store, viewport, geometry,
    hasBody: () => true,
    setStatus: (t: string) => statuses.push(t),
  } as unknown as PanelsDeps;
  const ui = createPanels(deps);
  return {
    ui, built, marks, overlays, statuses, calls, cancels,
    select: (ids: number[]) => { selected = ids; },
    settle: (r: StressResult) => settle(r),
    editDoc: () => docListeners.forEach((f) => f()),
    /** A new build drawn with these faces: the viewport drops its overlays and
     *  the rebuild bridge asks the panel to mark again. */
    rebuild: (faces: FaceMap) => {
      FACES = faces;
      store.buildState = { result: { bodies: [...new Set(Object.values(faces).map((f) => f.body))].map((id) => ({ id, name: id })) } };
      shown = false;
      overlays.push(null);
      marks.push(null);
      ui.refreshStressMarks();
    },
    open: () => openListeners.forEach((f) => f()),
  };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

function setUp(r: ReturnType<typeof rig>) {
  r.ui.showStress();
  r.select([1]);
  r.ui.setStressFacesFromSelection("fixed");
  r.select([2]);
  r.ui.setStressFacesFromSelection(1);
}

describe("stress panel flow", () => {
  it("takes faces from the selection with the body stamped, and marks them", () => {
    const r = rig();
    setUp(r);
    const s = usePanelsStore().stress!.setup;
    expect(s.body).toBe("b1");
    expect(s.fixed.selectors).toEqual([{ kind: "face", by: "nearest", point: [5, 5, 0], body: "b1" }]);
    expect(s.loads[0]!.faces.faceIds).toEqual([2]);
    expect(s.loads[0]!.faces.area).toBeCloseTo(100, 9);
    expect(r.marks.at(-1)).toEqual([
      { faceIds: [1], color: 0x4ac6ff },
      { faceIds: [2], color: 0xff9a2e },
    ]);
  });

  it("refuses faces on another body than the one analysed", () => {
    const r = rig();
    setUp(r);
    r.select([9]);
    r.ui.setStressFacesFromSelection("fixed");
    expect(r.statuses.at(-1)).toMatch(/another body/);
    expect(usePanelsStore().stress!.setup.fixed.faceIds).toEqual([1]);
  });

  it("runs with a force into the face and paints the result on the body", async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.body).toBe("b1");
    expect(r.calls[0]!.doc, "the model on screen, not the whole timeline").toBe(r.built);
    expect(r.calls[0]!.opts.loads).toEqual([
      { faces: [{ kind: "face", by: "nearest", point: [5, 5, 10], body: "b1" }], force: [0, 0, -100] },
    ]);
    expect(usePanelsStore().stress!.requestId).toBe("req-1");
    r.settle({ ok: true, result: reply });
    await run;
    expect(usePanelsStore().stress!.running).toBe(false);
    expect(usePanelsStore().stress!.result?.rows.find((x) => x.k === "Safety factor")?.v).toBe("12.5");
    expect(r.overlays.at(-1)).toEqual({
      bodyId: "b1", positions: reply.surface!.positions, indices: [0, 1, 2], values: [1, 4, 2], range: { min: 1, max: 4 },
    });
  });

  it("cancels by its own request id and stays quiet about it", async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    await r.ui.cancelStress();
    expect(r.cancels).toEqual(["req-1"]);
    r.settle({ ok: false, cancelled: true, message: "stress analysis cancelled" });
    await run;
    expect(usePanelsStore().stress!.error).toBeNull();
    expect(r.statuses.at(-1)).toBe("Stress analysis cancelled");
  });

  it("leaves the colours off a model edited while it ran", async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.editDoc();
    r.settle({ ok: true, result: reply });
    await run;
    expect(r.overlays.every((o) => o === null)).toBe(true);
    expect(usePanelsStore().stress!.result).not.toBeNull();
  });

  it("closing stops a Run in flight and drops its late reply", async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.ui.closeStress();
    await flush();
    expect(r.cancels).toEqual(["req-1"]);
    expect(usePanelsStore().stress).toBeNull();
    r.settle({ ok: true, result: reply });
    await run;
    expect(r.overlays.at(-1)).toBeNull();
    expect(r.marks.at(-1)).toBeNull();
  });

  it("does not send a setup that is not ready", async () => {
    const r = rig();
    r.ui.showStress();
    await r.ui.runStress();
    expect(r.calls).toEqual([]);
    expect(usePanelsStore().stress!.error).toMatch(/body|fixed/);
  });
});

describe("stress panel across changes", () => {
  it("changing the body during a Run stops it and drops its reply", async () => {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.ui.setStressBody("b2");
    await flush();
    expect(r.cancels).toEqual(["req-1"]);
    expect(usePanelsStore().stress!.running).toBe(false);
    r.settle({ ok: true, result: reply });
    await run;
    expect(usePanelsStore().stress!.result).toBeNull();
    expect(r.overlays.every((o) => o === null)).toBe(true);
  });

  it("takes the colours off so the body's faces can be set again, and puts them back", async () => {
    const r = rig();
    setUp(r);
    await settled(r);
    const p = usePanelsStore();
    expect(p.stress!.colours).toBe("shown");
    // No tint over the colours.
    expect(r.marks.at(-1)).toBeNull();
    r.ui.setStressColours(false);
    expect(r.overlays.at(-1)).toBeNull();
    expect(p.stress!.colours).toBe("hidden");
    expect(r.marks.at(-1)).toEqual([{ faceIds: [1], color: 0x4ac6ff }, { faceIds: [2], color: 0xff9a2e }]);
    r.select([2]);
    r.ui.setStressFacesFromSelection("fixed");
    expect(p.stress!.setup.fixed.faceIds).toEqual([2]);
    expect(p.stress!.result).not.toBeNull();
    r.ui.setStressColours(true);
    expect(r.overlays.at(-1)).toMatchObject({ bodyId: "b1", values: [1, 4, 2] });
  });

  it("finds the faces again on a rebuild that renumbers them, and marks the new ids", () => {
    const r = rig();
    setUp(r);
    r.editDoc();
    r.rebuild({ 4: { body: "b1", z: 0, n: -1 }, 7: { body: "b1", z: 10, n: 1 }, 9: { body: "b2", z: 0, n: 1 } });
    const s = usePanelsStore().stress!.setup;
    expect(s.fixed.faceIds).toEqual([4]);
    expect(s.loads[0]!.faces.faceIds).toEqual([7]);
    expect(r.marks.at(-1)).toEqual([{ faceIds: [4], color: 0x4ac6ff }, { faceIds: [7], color: 0xff9a2e }]);
  });

  it("drops a face the edit removed, says so, and will not run on what is left", async () => {
    const r = rig();
    setUp(r);
    r.editDoc();
    r.rebuild({ 4: { body: "b1", z: 0, n: -1 }, 9: { body: "b2", z: 0, n: 1 } });
    const s = usePanelsStore().stress!.setup;
    expect(s.loads[0]!.faces.selectors).toEqual([]);
    expect(r.statuses.at(-1)).toMatch(/1 face is no longer on the body/);
    await r.ui.runStress();
    expect(r.calls).toEqual([]);
  });

  it("an edit after a Run leaves no colours to show again", async () => {
    const r = rig();
    setUp(r);
    await settled(r);
    r.editDoc();
    r.rebuild(FIRST);
    expect(usePanelsStore().stress!.colours).toBe("none");
    const before = r.overlays.length;
    r.ui.setStressColours(true);
    expect(r.overlays).toHaveLength(before);
  });

  it("an eye toggle only takes the colours off", async () => {
    const r = rig();
    setUp(r);
    await settled(r);
    // Same document, drawn again: the overlay is gone but still valid.
    r.rebuild(FIRST);
    expect(usePanelsStore().stress!.colours).toBe("hidden");
  });

  it("closes on opening another document", () => {
    const r = rig();
    setUp(r);
    r.open();
    expect(usePanelsStore().stress).toBeNull();
    expect(r.marks.at(-1)).toBeNull();
  });
});

async function settled(r: ReturnType<typeof rig>) {
  const run = r.ui.runStress();
  r.settle({ ok: true, result: reply });
  await run;
}
