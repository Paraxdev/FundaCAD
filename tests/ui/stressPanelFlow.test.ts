import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import { usePanelsStore } from "../../src/stores/panels";
import type { StressOptions, StressReply, StressResult } from "../../src/geometry/client";
import type { CadDocument, StressStudy, Vec3 } from "../../src/types";
import type { StressGlyphHandlers, StressGlyphModel } from "../../src/viewport/stressGlyphs";
import { autoDeformScale, probeLabel, probeValues, swingScale } from "../../src/ui/stress";
import { drawnCorner, engineHit, refineSurface } from "../../src/ui/stressSurface";

// The Stress panel's facade against a hand-made viewport, store and engine:
// faces come from the selection stamped with their body, Run sends what the
// setup says, Cancel names its own request, the colours go on the body, the
// setup is saved with the document, and the view's glyphs follow it.

beforeEach(() => setActivePinia(createPinia()));

type FaceMap = Record<number, { body: string; z: number; n: number; tris?: THREE.Triangle[] }>;
// Face 1 is the bottom of body b1 (normal -Z), face 2 its top (+Z), face 9 on b2.
const FIRST: FaceMap = {
  1: { body: "b1", z: 0, n: -1 },
  2: { body: "b1", z: 10, n: 1 },
  9: { body: "b2", z: 0, n: 1 },
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
  let study: StressStudy | null = null;
  const saved: (StressStudy | null)[] = [];
  const deformations: number[] = [];
  const weakSpots: ({ tri: number; weights: Vec3; label: string } | null)[] = [];
  const glyphModels: StressGlyphModel[] = [];
  const glyphCalls: string[] = [];
  let handlers: StressGlyphHandlers | null = null;
  let pick: { tri: number; weights: Vec3; point: Vec3 } | null = null;

  const viewport = {
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
    faceTriangles: (f: number) => FACES[f]?.tris ?? (FACES[f] ? quad(FACES[f]!.z, FACES[f]!.n) : []),
    bodyProperties: () => ({ com: new THREE.Vector3(5, 5, 5) }),
    setStressDeformation: (k: number) => deformations.push(k),
    pickStressOverlay: () => pick,
    // Every test face spans x, y 0..10, so its height alone finds it.
    faceIdNear: (p: [number, number, number]) => {
      const hit = Object.entries(FACES).find(([, f]) => f.z === p[2]);
      return hit ? Number(hit[0]) : null;
    },
    clearSelection: () => {
      selected = [];
    },
    setFaceMarks: (m: unknown) => marks.push(m),
    setStressOverlay: (o: unknown) => {
      overlays.push(o);
      shown = o !== null;
    },
    hasStressOverlay: () => shown,
  };
  const built = { features: [{ id: "on-screen" }] } as unknown as CadDocument;
  const store = {
    document: { features: [] } as unknown as CadDocument,
    // What the model on screen was built from: rolled back, suppressions out.
    builtDocument: () => built,
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
      fn();
      return () => {};
    },
    onOpen: (fn: () => void) => {
      openListeners.push(fn);
      return () => {};
    },
    isBodyVisible: () => true,
    loadCount: 3,
    get stressStudy() {
      return study;
    },
    setStressStudy: (s: StressStudy | null) => {
      study = s ? structuredClone(s) : null;
      saved.push(study);
    },
  };
  const geometry = {
    stress: (_doc: CadDocument, body: string, opts: StressOptions, onStarted?: (id: string) => void) => {
      calls.push({ body, opts, doc: _doc });
      onStarted?.(`req-${calls.length}`);
      return new Promise<StressResult>((res) => {
        settle = res;
      });
    },
    cancel: async (id?: string) => {
      cancels.push(id);
      return true;
    },
    // One overhang on b1's face 3, for the panels' tints to share the body.
  };
  const deps = {
    store,
    viewport,
    geometry,
    hasBody: () => true,
    setStatus: (t: string) => statuses.push(t),
    stressGlyphs: (h: StressGlyphHandlers) => {
      handlers = h;
      return {
        setModel: (m: StressGlyphModel) => glyphModels.push(m),
        setProbe: (on: boolean) => glyphCalls.push(`probe ${on}`),
        setProbePins: (p: unknown[]) => glyphCalls.push(`pins ${p.length}`),
        setWeakSpot: (w: { tri: number; weights: Vec3; label: string } | null) => weakSpots.push(w),
        dispose: () => glyphCalls.push("dispose"),
      };
    },
  } as unknown as PanelsDeps;
  const ui = createPanels(deps);
  return {
    ui,
    store,
    built,
    marks,
    overlays,
    statuses,
    calls,
    cancels,
    saved,
    deformations,
    weakSpots,
    glyphModels,
    glyphCalls,
    handlers: () => handlers!,
    pickAt: (p: typeof pick) => {
      pick = p;
    },
    study: () => study,
    /** Another state of the same document put in place (a version, an
     *  assistant's edit), with its own study. */
    replaceStudy: (s: StressStudy | null) => {
      study = s;
      docListeners.forEach((f) => f());
    },
    /** The saved study changed with no model edit, as a later panel session or a file would leave it. */
    setStudy: (s: StressStudy | null) => {
      study = s;
    },
    select: (ids: number[]) => {
      selected = ids;
    },
    settle: (r: StressResult) => settle(r),
    editDoc: () => docListeners.forEach((f) => f()),
    /** An assistant's or a plugin's load put in place of the model, keeping the study. */
    replaceLoad: () => {
      store.loadCount++;
      docListeners.forEach((f) => f());
    },
    /** A new build drawn with these faces: the viewport drops its overlays and
     *  the rebuild bridge asks the panel to mark again. */
    rebuild: (faces: FaceMap) => {
      FACES = faces;
      store.buildState = {
        result: {
          bodies: [...new Set(Object.values(faces).map((f) => f.body))].map((id, i) => ({
            id,
            name: id,
            faceStart: 9 * i,
            faceCount: 9,
          })),
        },
      };
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
  r.ui.setStressFacesFromSelection({ support: 1 });
  r.select([2]);
  r.ui.setStressFacesFromSelection({ load: 1 });
}

describe("stress panel flow", () => {
  it("takes faces from the selection with the body stamped, and marks them", () => {
    const r = rig();
    setUp(r);
    const s = usePanelsStore().stress!.setup;
    expect(s.body).toBe("b1");
    expect(s.supports[0]!.faces.selectors).toEqual([{ kind: "face", by: "nearest", point: [5, 5, 0], body: "b1" }]);
    expect(s.loads[0]!.faces.faceIds).toEqual([2]);
    expect(s.loads[0]!.faces.area).toBeCloseTo(100, 9);
    expect(r.marks.at(-1)).toEqual([
      { faceIds: [1], color: 0x4ac6ff },
      { faceIds: [2], color: 0xff9a2e },
    ]);
  });

  it("places a load on the body with a click, with no face of its own, and runs with it", async () => {
    const r = rig();
    r.ui.showStress();
    r.select([1]);
    r.ui.setStressFacesFromSelection({ support: 1 });
    const d = usePanelsStore().stress!;
    const toasts = r.statuses.length;
    r.ui.placeStressSpot({ load: 1 });
    expect(d.placing).toEqual({ load: 1 });
    expect(r.statuses.slice(toasts), "the panel's own hint says it, no toast over it").toEqual([]);
    // A click on another body is told so and places nothing.
    r.handlers().placeSpot!({ at: [1, 1, 0], normal: [0, 0, 1], body: "b2" }, false);
    expect(r.statuses.at(-1)).toMatch(/another body/);
    expect(d.setup.loads[0]!.spots).toBeUndefined();
    r.handlers().placeSpot!({ at: [5.00001, 5, 10], normal: [0, 0, 1], body: "b1" }, false);
    expect(d.placing, "one click, one spot").toBeNull();
    expect(d.setup.loads[0]!.spots).toEqual([{ at: [5, 5, 10], radius: 5, normal: [0, 0, 1] }]);
    await flush();
    const drawn = r.glyphModels.at(-1)!;
    expect(drawn.spots).toEqual([{ target: { load: 1 }, index: 0, at: [5, 5, 10], radius: 5, color: 0xff9a2e }]);
    expect(drawn.forces[0]).toMatchObject({ loadId: 1, anchor: [5, 5, 10], dir: [0, 0, -1] });
    expect(r.study()!.loads[0]!.spots).toEqual([{ at: [5, 5, 10], radius: 5, normal: [0, 0, 1] }]);

    // A drag of the rim sizes it, Esc puts it back, and the next spot starts at the last size.
    r.handlers().spotRadius!({ load: 1 }, 0, 8);
    r.handlers().spotRadiusEnd!({ load: 1 }, 0, true);
    expect(d.setup.loads[0]!.spots![0]!.radius).toBe(5);
    r.handlers().spotRadius!({ load: 1 }, 0, 2);
    r.handlers().spotRadiusEnd!({ load: 1 }, 0, false);
    r.ui.placeStressSpot({ load: 1 });
    r.handlers().placeSpot!({ at: [2, 2, 10], normal: [0, 0, 1], body: "b1" }, true);
    expect(d.placing, "Shift keeps placing").toEqual({ load: 1 });
    r.handlers().leavePlacing!();
    expect(d.placing).toBeNull();
    expect(d.setup.loads[0]!.spots!.map((x) => x.radius)).toEqual([2, 2]);
    r.ui.removeStressSpot({ load: 1 }, 1);

    void r.ui.runStress();
    expect(r.calls[0]!.opts.loads).toEqual([{ spots: [{ at: [5, 5, 10], radius: 2 }], force: [0, 0, -100] }]);
  });

  it("refuses faces on another body than the one analysed", () => {
    const r = rig();
    setUp(r);
    r.select([9]);
    r.ui.setStressFacesFromSelection({ support: 1 });
    expect(r.statuses.at(-1)).toMatch(/another body/);
    expect(usePanelsStore().stress!.setup.supports[0]!.faces.faceIds).toEqual([1]);
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
    // One engine triangle is drawn two levels finer, sixteen triangles, over the engine's own range.
    const drawn = refineSurface(reply.surface!, 2);
    expect(r.overlays.at(-1)).toEqual({
      bodyId: "b1",
      positions: drawn.positions,
      indices: drawn.indices,
      values: drawn.values,
      range: { min: 1, max: 4 },
      colours: true,
    });
    expect(drawn.indices.length / 3).toBe(16);
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
    expect(usePanelsStore().stress!.error).toMatch(/body|support/);
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
    // Plain and still, kept for the weakest spot's pin while the body itself shows.
    expect(r.overlays.at(-1)).toMatchObject({ bodyId: "b1", colours: false });
    expect(r.overlays.at(-1)).not.toHaveProperty("displacement");
    expect(p.stress!.colours).toBe("hidden");
    expect(r.marks.at(-1)).toEqual([
      { faceIds: [1], color: 0x4ac6ff },
      { faceIds: [2], color: 0xff9a2e },
    ]);
    r.select([2]);
    r.ui.setStressFacesFromSelection({ support: 1 });
    expect(p.stress!.setup.supports[0]!.faces.faceIds).toEqual([2]);
    expect(p.stress!.result).not.toBeNull();
    r.ui.setStressColours(true);
    expect(r.overlays.at(-1)).toMatchObject({ bodyId: "b1" });
    expect(Array.from((r.overlays.at(-1) as { values: Float32Array }).values).slice(0, 3)).toEqual([1, 4, 2]);
  });

  it("finds the faces again on a rebuild that renumbers them, and marks the new ids", () => {
    const r = rig();
    setUp(r);
    r.editDoc();
    r.rebuild({ 4: { body: "b1", z: 0, n: -1 }, 7: { body: "b1", z: 10, n: 1 }, 9: { body: "b2", z: 0, n: 1 } });
    const s = usePanelsStore().stress!.setup;
    expect(s.supports[0]!.faces.faceIds).toEqual([4]);
    expect(s.loads[0]!.faces.faceIds).toEqual([7]);
    expect(r.marks.at(-1)).toEqual([
      { faceIds: [4], color: 0x4ac6ff },
      { faceIds: [7], color: 0xff9a2e },
    ]);
  });

  it("keeps a face the edit removed, says so, and will not run until it is back", async () => {
    const r = rig();
    setUp(r);
    const saved = structuredClone(r.study());
    r.editDoc();
    r.rebuild({ 4: { body: "b1", z: 0, n: -1 }, 9: { body: "b2", z: 0, n: 1 } });
    const s = usePanelsStore().stress!.setup;
    expect(s.loads[0]!.faces.selectors).toEqual([{ kind: "face", by: "nearest", point: [5, 5, 10], body: "b1" }]);
    expect(s.loads[0]!.faces.faceIds).toEqual([]);
    expect(s.loads[0]!.faces.missing).toBe(1);
    expect(r.statuses.at(-1)).toBe("Stress: 1 face is not found on the current model, set the faces again");
    await r.ui.runStress();
    expect(r.calls).toEqual([]);
    expect(usePanelsStore().stress!.error).toBe(
      "A face of the load is not found on the current model, set the faces again.",
    );
    // The saved study never lost it: the next build that has the face finds it.
    expect(r.study()).toEqual(saved);
    r.editDoc();
    r.rebuild(FIRST);
    expect(s.loads[0]!.faces.faceIds).toEqual([2]);
    expect(s.loads[0]!.faces.missing).toBe(0);
    expect(r.study()).toEqual(saved);
    void r.ui.runStress();
    expect(r.calls).toHaveLength(1);
  });

  it("keeps the body and every face through a build without the body", () => {
    const r = rig();
    setUp(r);
    const saved = structuredClone(r.study());
    r.editDoc();
    r.rebuild({ 9: { body: "b2", z: 0, n: 1 } });
    const s = usePanelsStore().stress!.setup;
    expect(s.body).toBe("b1");
    expect(s.supports[0]!.faces.missing).toBe(1);
    expect(r.statuses.at(-1)).toMatch(/the body analysed is not on the current model/);
    expect(r.study()).toEqual(saved);
    void r.ui.runStress();
    expect(r.calls).toEqual([]);
    expect(usePanelsStore().stress!.error).toMatch(/^The body analysed is not on the current model\./);
    r.editDoc();
    r.rebuild(FIRST);
    expect(s.supports[0]!.faces.faceIds).toEqual([1]);
    expect(s.loads[0]!.faces.faceIds).toEqual([2]);
    expect(r.study()).toEqual(saved);
  });

  it("opening the panel on a rolled-back model leaves the saved study alone", () => {
    const r = rig();
    setUp(r);
    const saved = structuredClone(r.study());
    r.ui.closeStress();
    r.rebuild({ 4: { body: "b1", z: 0, n: -1 }, 9: { body: "b2", z: 0, n: 1 } });
    r.ui.showStress();
    expect(r.study()).toEqual(saved);
    r.rebuild({ 9: { body: "b2", z: 0, n: 1 } });
    r.ui.closeStress();
    r.ui.showStress();
    expect(r.study()).toEqual(saved);
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

describe("the study saved with the document", () => {
  it("opening the panel saves nothing, an edit saves the study", () => {
    const r = rig();
    r.ui.showStress();
    expect(r.saved).toEqual([]);
    setUp(r);
    const s = r.study()!;
    expect(s.supports).toEqual([
      { id: 1, type: "fixed", faces: [{ kind: "face", by: "nearest", point: [5, 5, 0], body: "b1" }] },
    ]);
    expect(s.loads[0]!.faces).toEqual([{ kind: "face", by: "nearest", point: [5, 5, 10], body: "b1" }]);
    const n = r.saved.length;
    usePanelsStore().stress!.setup.gravity.on = true;
    expect(r.saved).toHaveLength(n + 1);
    expect(r.study()!.gravity.on).toBe(true);
    // Setting a field to what it already is saves nothing.
    usePanelsStore().stress!.setup.gravity.on = true;
    expect(r.saved).toHaveLength(n + 1);
  });

  it("reopening reads the study back and finds its faces on the build", () => {
    const r = rig();
    setUp(r);
    usePanelsStore().stress!.setup.material = "PETG";
    r.ui.closeStress();
    const before = r.saved.length;
    r.ui.showStress();
    const s = usePanelsStore().stress!.setup;
    expect(s.material).toBe("PETG");
    expect(s.supports[0]!.faces.faceIds).toEqual([1]);
    expect(s.loads[0]!.faces.faceIds).toEqual([2]);
    expect(s.loads[0]!.faces.area).toBeCloseTo(100, 9);
    expect(r.saved).toHaveLength(before);
    expect(r.marks.at(-1)).toEqual([
      { faceIds: [1], color: 0x4ac6ff },
      { faceIds: [2], color: 0xff9a2e },
    ]);
  });

  it("says which saved faces are not on the body when it opens", () => {
    const r = rig();
    setUp(r);
    r.ui.closeStress();
    r.rebuild({ 4: { body: "b1", z: 0, n: -1 }, 9: { body: "b2", z: 0, n: 1 } });
    r.ui.showStress();
    expect(r.statuses.at(-1)).toBe("Stress: 1 face is not found on the current model, set the faces again");
    expect(usePanelsStore().stress!.setup.supports[0]!.faces.faceIds).toEqual([4]);
  });

  it("takes up a study the document gained some other way, dropping the old result", async () => {
    const r = rig();
    setUp(r);
    await settled(r);
    const other = structuredClone(r.study()!);
    other.material = "ABS";
    other.supports[0]!.type = "slider";
    r.replaceStudy(other);
    const p = usePanelsStore();
    expect(p.stress!.setup.material).toBe("ABS");
    expect(p.stress!.setup.supports[0]!.type).toBe("slider");
    expect(p.stress!.result).toBeNull();
    expect(r.overlays.at(-1)).toBeNull();
  });

  it("keeps a selector it cannot place for the engine, without counting it lost", async () => {
    const r = rig();
    setUp(r);
    const s = structuredClone(r.study()!);
    s.supports[0]!.faces.push({ kind: "face", by: "normal", dir: [0, 0, -1], body: "b1" });
    r.replaceStudy(s);
    r.editDoc();
    r.rebuild(FIRST);
    expect(r.statuses.at(-1)).not.toMatch(/no longer on the body/);
    const run = r.ui.runStress();
    expect(r.calls.at(-1)!.opts.supports![0]!.faces).toHaveLength(2);
    r.settle({ ok: true, result: reply });
    await run;
  });
});

describe("supports, gravity and the view's glyphs", () => {
  // A bore of radius 3 along Z through (5, 5), on b1.
  function bore(): THREE.Triangle[] {
    const out: THREE.Triangle[] = [];
    const n = 16;
    const p = (t: number, z: number) => new THREE.Vector3(5 + 3 * Math.cos(t), 5 + 3 * Math.sin(t), z);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const b = (2 * Math.PI * (i + 1)) / n;
      out.push(new THREE.Triangle(p(a, 0), p(a, 10), p(b, 0)), new THREE.Triangle(p(b, 0), p(a, 10), p(b, 10)));
    }
    return out;
  }

  it("tints each kind of support its own colour and draws a pinned one's axis", () => {
    const r = rig();
    r.rebuild({ ...FIRST, 5: { body: "b1", z: 5, n: 1, tris: bore() } });
    setUp(r);
    r.ui.addStressSupport("pinned");
    r.select([5]);
    r.ui.setStressFacesFromSelection({ support: 2 });
    expect(r.marks.at(-1)).toEqual([
      { faceIds: [1], color: 0x4ac6ff },
      { faceIds: [5], color: 0xc58cff },
      { faceIds: [2], color: 0xff9a2e },
    ]);
    const pins = r.glyphModels.at(-1)!.pins;
    expect(pins).toHaveLength(1);
    expect(pins[0]!.from[0]).toBeCloseTo(5, 6);
    expect(pins[0]!.to[1]).toBeCloseTo(5, 6);
  });

  it("draws the force arrow at its faces' centre, a gravity arrow at the body's, and sends both", () => {
    const r = rig();
    setUp(r);
    let m = r.glyphModels.at(-1)!;
    expect(m.forces).toEqual([
      {
        loadId: 1,
        anchor: [expect.closeTo(5, 9), expect.closeTo(5, 9), 10],
        dir: [0, 0, -1],
        force: 100,
        direction: "into",
        into: [0, 0, -1],
      },
    ]);
    expect(m.gravity).toBeNull();
    usePanelsStore().stress!.setup.gravity = { on: true, direction: "-X" };
    r.ui.refreshStressMarks();
    m = r.glyphModels.at(-1)!;
    expect(m.gravity).toEqual({ at: [5, 5, 5], dir: [-1, 0, 0] });
    void r.ui.runStress();
    expect(r.calls.at(-1)!.opts.gravity).toEqual([-9.81, 0, 0]);
    expect(r.calls.at(-1)!.opts.supports).toEqual([
      { type: "fixed", faces: [{ kind: "face", by: "nearest", point: [5, 5, 0], body: "b1" }] },
    ]);
  });

  it("draws a pressure as small arrows into its faces", () => {
    const r = rig();
    setUp(r);
    usePanelsStore().stress!.setup.loads[0]!.kind = "pressure";
    r.ui.refreshStressMarks();
    const m = r.glyphModels.at(-1)!;
    expect(m.forces).toEqual([]);
    expect(m.pressures.length).toBeGreaterThan(0);
    expect(m.pressures.every((p) => p.dir[2] === -1)).toBe(true);
  });

  it("a drag of the arrow writes into the load, and Esc puts it back", () => {
    const r = rig();
    setUp(r);
    const l = usePanelsStore().stress!.setup.loads[0]!;
    r.handlers().forceDrag(1, { direction: "+X", custom: null, force: 250 });
    expect([l.direction, l.force]).toEqual(["+X", 250]);
    r.handlers().forceDrag(1, { direction: "custom", custom: [0.6, 0, -0.8], force: 30 });
    expect([l.direction, l.custom, l.force]).toEqual(["custom", [0.6, 0, -0.8], 30]);
    expect(r.study()!.loads[0]!.force).toBe(30);
    r.handlers().forceDragEnd(1, true);
    expect([l.direction, l.custom, l.force]).toEqual(["into", [0, 0, -1], 100]);
    r.handlers().forceDrag(1, { direction: "-Z", custom: null, force: 40 });
    r.handlers().forceDragEnd(1, false);
    expect([l.direction, l.force]).toEqual(["-Z", 40]);
  });

  it("names each support's reaction by its kind in the result", async () => {
    const r = rig();
    r.rebuild({ ...FIRST, 5: { body: "b1", z: 5, n: 1, tris: bore() } });
    setUp(r);
    r.ui.addStressSupport("pinned");
    r.select([5]);
    r.ui.setStressFacesFromSelection({ support: 2 });
    const run = r.ui.runStress();
    r.settle({
      ok: true,
      result: {
        ...reply,
        reactions: [
          [0, 0, 70],
          [0, 0, 30],
        ],
        weight: [0, 0, -0.2],
      },
    });
    await run;
    const rows = usePanelsStore().stress!.result!.details;
    expect(rows.find((x) => x.k === "Support 2, pinned")?.v).toBe("0, 0, 30 N");
    expect(rows.find((x) => x.k === "Weight")?.v).toBe("0, 0, -0.2 N");
  });
});

describe("the deformed shape and the probe", () => {
  const moving: StressReply = {
    ...reply,
    surface: {
      ...reply.surface!,
      positions: [0, 0, 0, 100, 0, 0, 0, 10, 0],
      displacement: [0, 0, 0, 0, 0, -2, 0, 0, -1],
    },
  };

  afterEach(() => vi.unstubAllGlobals());

  async function deformed(r: ReturnType<typeof rig>) {
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: true, result: moving });
    await run;
  }

  it("starts at the automatic scale, and the slider and 1x move the drawn shape", async () => {
    const r = rig();
    await deformed(r);
    const p = usePanelsStore();
    const auto = p.stress!.deform!.auto;
    expect(p.stress!.deform).toEqual({ scale: auto, auto, max: 4 * auto, animate: false, shown: true });
    // The scale is the engine mesh's; the drawn shape bends by the refined displacement.
    expect(auto).toBe(autoDeformScale(moving.surface!.positions, moving.surface!.displacement!));
    expect(r.overlays.at(-1)).toMatchObject({
      displacement: refineSurface(moving.surface!, 2).displacement,
      scale: auto,
    });
    r.ui.setStressDeformation(1);
    expect(r.deformations.at(-1)).toBe(1);
    expect(p.stress!.deform!.scale).toBe(1);
    // Hidden and shown again, the colours come back at the slider's scale.
    r.ui.setStressColours(false);
    r.ui.setStressColours(true);
    expect(r.overlays.at(-1)).toMatchObject({ scale: 1 });
  });

  it("draws a result over the triangle budget as the engine sent it", async () => {
    const r = rig();
    setUp(r);
    const n = 50_001;
    const big: StressReply = {
      ...moving,
      surface: { ...moving.surface!, indices: Array.from({ length: n * 3 }, (_, i) => i % 3) },
    };
    const run = r.ui.runStress();
    r.settle({ ok: true, result: big });
    await run;
    const o = r.overlays.at(-1) as { indices: Uint32Array; positions: Float32Array };
    expect({ triangles: o.indices.length / 3, vertices: o.positions.length / 3 }).toEqual({
      triangles: n,
      vertices: 3,
    });
  });

  it("keeps a pinned point on its drawn triangle when the deformation changes", async () => {
    const r = rig();
    await deformed(r);
    const p = usePanelsStore();
    r.ui.setStressProbe(true);
    const hit = { tri: 13, weights: [0.25, 0.25, 0.5] as Vec3, point: [0, 0, 0] as Vec3 };
    r.handlers().pinProbe(hit);
    const label = p.stress!.pins[0]!.label;
    r.ui.setStressDeformation(37.5);
    expect(p.stress!.pins.map((x) => ({ tri: x.tri, weights: x.weights, label: x.label }))).toEqual([
      { tri: 13, weights: [0.25, 0.25, 0.5], label },
    ]);
  });

  it("animates on frames until the panel closes", async () => {
    const frames: FrameRequestCallback[] = [];
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => cancelled.push(id));
    const r = rig();
    await deformed(r);
    const p = usePanelsStore();
    r.ui.setStressAnimate(true);
    expect(p.stress!.deform!.animate).toBe(true);
    frames.shift()!(performance.now() + 400);
    expect(r.deformations.at(-1)).toBeGreaterThan(0);
    expect(frames).toHaveLength(1);
    r.ui.closeStress();
    expect(cancelled).toHaveLength(1);
  });

  it("stops animating when the result is cleared by a new Run", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 7);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const r = rig();
    await deformed(r);
    r.ui.setStressAnimate(true);
    void r.ui.runStress();
    expect(usePanelsStore().stress!.deform).toBeNull();
  });

  it("reads the probe off the surface, pins it, removes it, and leaves on Esc", async () => {
    const r = rig();
    await deformed(r);
    const p = usePanelsStore();
    r.ui.setStressProbe(true);
    expect(p.stress!.probe).toBe(true);
    expect(r.glyphCalls).toContain("probe true");
    // A hit on the drawn mesh reads the engine's surface: at an engine vertex its own values, between them the
    // engine's interpolation in the engine triangle the drawn one lies in.
    const drawn = refineSurface(moving.surface!, 2);
    const corner = drawnCorner(drawn, 1)!;
    const hit = { ...corner, point: [100, 0, -2] as Vec3 };
    expect(r.handlers().probeLabel(hit)).toBe("4 MPa, 2 mm");
    const inner = { tri: 9, weights: [0.2, 0.5, 0.3] as Vec3, point: [0, 0, 0] as Vec3 };
    const at = engineHit(drawn, inner.tri, inner.weights)!;
    expect(r.handlers().probeLabel(inner)).toBe(probeLabel(probeValues(moving.surface!, at.tri, at.weights)!, "mm"));
    r.handlers().pinProbe(hit);
    expect(p.stress!.pins.map((x) => x.label)).toEqual(["4 MPa, 2 mm"]);
    expect(p.stress!.pins.map((x) => [x.tri, x.weights])).toEqual([[corner.tri, corner.weights]]);
    expect(r.glyphCalls.at(-1)).toBe("pins 1");
    r.ui.removeStressProbe(p.stress!.pins[0]!.id);
    expect(p.stress!.pins).toEqual([]);
    r.handlers().leaveProbe();
    expect(p.stress!.probe).toBe(false);
    // The setup is untouched by any of it.
    expect(p.stress!.setup.supports[0]!.faces.faceIds).toEqual([1]);
  });

  it("will not probe before a Run, and an edit drops the probes with the colours", async () => {
    const r = rig();
    setUp(r);
    r.ui.setStressProbe(true);
    expect(usePanelsStore().stress!.probe).toBe(false);
    expect(r.statuses.at(-1)).toMatch(/run the analysis first/);
    const run = r.ui.runStress();
    r.settle({ ok: true, result: moving });
    await run;
    r.ui.setStressProbe(true);
    r.handlers().pinProbe({ tri: 0, weights: [1, 0, 0], point: [0, 0, 0] });
    r.editDoc();
    r.rebuild(FIRST);
    const p = usePanelsStore();
    expect(p.stress!.colours).toBe("none");
    expect(p.stress!.probe).toBe(false);
    expect(p.stress!.pins).toEqual([]);
    expect(p.stress!.deform).toBeNull();
  });

  it("closing disposes the glyphs", async () => {
    const r = rig();
    await deformed(r);
    r.ui.closeStress();
    expect(r.glyphCalls.at(-1)).toBe("dispose");
  });
});

describe("what the review of the stress tools found", () => {
  it("opens and rebuilds over a study whose selector it cannot read, without throwing", () => {
    const r = rig();
    setUp(r);
    const s = structuredClone(r.study()!) as unknown as { supports: { faces: unknown[] }[] };
    // Past the document's own check, as a study put straight in the store.
    s.supports[0]!.faces = [
      { kind: "face", by: "nearest", point: null },
      { kind: "face", by: "match" },
    ];
    r.ui.closeStress();
    r.replaceStudy(s as unknown as StressStudy);
    expect(() => r.ui.showStress()).not.toThrow();
    expect(() => r.rebuild(FIRST)).not.toThrow();
    expect(usePanelsStore().stress!.setup.supports[0]!.faces.selectors).toHaveLength(2);
  });

  it("draws a negative force along the force applied, and a drag along it keeps that load", () => {
    const r = rig();
    setUp(r);
    const l = usePanelsStore().stress!.setup.loads[0]!;
    l.direction = "-Z";
    l.force = -100;
    r.ui.refreshStressMarks();
    const glyph = r.glyphModels.at(-1)!.forces[0]!;
    void r.ui.runStress();
    const sent = (r.calls.at(-1)!.opts.loads[0] as { force: Vec3 }).force;
    expect(sent).toEqual([0, 0, 100]);
    expect(glyph.dir).toEqual([0, 0, 1]);
    expect(glyph.force).toBe(100);
    // The arrow is named for the way it points, so the snap along it writes +Z.
    expect(glyph.direction).toBe("+Z");
  });

  it("draws a negative pressure leaving its faces", () => {
    const r = rig();
    setUp(r);
    const l = usePanelsStore().stress!.setup.loads[0]!;
    l.kind = "pressure";
    l.pressure = -0.2;
    r.ui.refreshStressMarks();
    const sites = r.glyphModels.at(-1)!.pressures;
    expect(sites.length).toBeGreaterThan(0);
    // Face 2 is the top, normal +Z: a pull points up and out of it.
    expect(sites.every((p) => p.dir[2] === 1 && p.pull)).toBe(true);
  });

  it("runs a body under its own weight from a fresh panel", () => {
    const r = rig();
    r.ui.showStress();
    r.select([1]);
    r.ui.setStressFacesFromSelection({ support: 1 });
    usePanelsStore().stress!.setup.gravity.on = true;
    void r.ui.runStress();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.opts.loads).toEqual([]);
    expect(r.calls[0]!.opts.gravity).toEqual([0, 0, -9.81]);
  });

  it("will not turn probing on over colours the model has made stale", async () => {
    const r = rig();
    setUp(r);
    await settled(r);
    r.ui.setStressColours(false);
    // Edited, and the rebuild has not landed yet.
    r.editDoc();
    r.ui.setStressProbe(true);
    const p = usePanelsStore();
    expect(p.stress!.colours).toBe("none");
    expect(p.stress!.probe).toBe(false);
    expect(r.glyphCalls.at(-1)).not.toBe("probe true");
    expect(r.statuses.at(-1)).toMatch(/run the analysis again to probe it/);
  });

  it('counts a face the view cannot place, sends it, and says so plainly for "into the face"', () => {
    const r = rig();
    setUp(r);
    const s = structuredClone(r.study()!);
    // A fingerprint of a cylinder: the engine finds it, the view cannot.
    s.loads[0]!.faces = [
      {
        kind: "face",
        by: "match",
        fp: { centroid: [5, 5, 5], normal: [1, 0, 0], surface: "cylinder", radius: 3 },
        body: "b1",
      },
    ];
    r.replaceStudy(s);
    r.ui.refreshStressMarks();
    const l = usePanelsStore().stress!.setup.loads[0]!;
    expect(l.faces.unshown).toBe(1);
    expect(l.faces.missing).toBe(0);
    void r.ui.runStress();
    expect(r.calls).toEqual([]);
    expect(usePanelsStore().stress!.error).toMatch(
      /one of its faces is not shown in the view, so "into the face" cannot be worked out; set the faces again/,
    );
    l.direction = "-Z";
    void r.ui.runStress();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.opts.loads[0]!.faces).toEqual(s.loads[0]!.faces);
  });

  it("opening a saved study with no body leaves the document as it was", () => {
    const r = rig();
    const s = { ...studyOf(r), body: null };
    r.replaceStudy(s);
    const before = r.saved.length;
    r.select([1]);
    r.ui.showStress();
    expect(r.saved).toHaveLength(before);
    expect(usePanelsStore().stress!.setup.body).toBeNull();
    // Nor does an outside edit that clears the body get the panel's old one back.
    r.ui.setStressBody("b1");
    const other = { ...r.study()!, body: null };
    r.replaceStudy(other);
    expect(usePanelsStore().stress!.setup.body).toBeNull();
    expect(r.study()!.body).toBeNull();
  });

  it("names the row that took the faces in the status line", () => {
    const r = rig();
    r.ui.showStress();
    r.ui.addStressSupport("slider");
    r.select([1]);
    r.ui.setStressFacesFromSelection({ support: 2 });
    expect(r.statuses.at(-1)).toBe("Stress: Support 2 (slider): 1 face");
    r.select([2]);
    r.ui.setStressFacesFromSelection({ load: 1 });
    expect(r.statuses.at(-1)).toBe("Stress: Load 1: 1 face");
  });

  it("never saves a default the panel does not show for a field being retyped", () => {
    const r = rig();
    setUp(r);
    const s = usePanelsStore().stress!.setup;
    s.material = "Custom";
    s.custom.density = 1.1;
    s.loads[0]!.force = 35;
    s.custom.density = "" as unknown as number;
    s.loads[0]!.force = "" as unknown as number;
    expect(r.study()!.custom.density).toBe(1.1);
    expect(r.study()!.loads[0]!.force).toBe(35);
  });
});

/** A whole study for rig `r`'s body b1, as the panel would save it. */
function studyOf(r: ReturnType<typeof rig>): StressStudy {
  setUp(r);
  const s = structuredClone(r.study()!);
  r.ui.closeStress();
  return s;
}

describe("playing and pausing the deformation", () => {
  const bending: StressReply = {
    ...reply,
    surface: {
      ...reply.surface!,
      positions: [13.5, -7.25, 4.1, 113.5, -2.25, 4.1, 13.5, 2.75, 6.1],
      displacement: [0, 0, 0, 0.25, 0, -2, 0, 0.5, -1],
    },
  };
  let clock = 0;
  let frames: Map<number, FrameRequestCallback>;
  let cancelled: number[];
  let nextId = 0;

  beforeEach(() => {
    clock = 1000;
    frames = new Map();
    cancelled = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
      frames.set(++nextId, f);
      return nextId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      cancelled.push(id);
      frames.delete(id);
    });
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Runs the pending frame at `at` ms on the stubbed clock. */
  function frame(at: number) {
    clock = at;
    const [id, f] = [...frames.entries()][0]!;
    frames.delete(id);
    f(at);
  }

  async function played() {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: true, result: bending });
    await run;
    const scale = usePanelsStore().stress!.deform!.scale;
    return { r, scale };
  }

  const REST = 800;

  it("starts Play at the full pose the still shape shows, so it never jumps", async () => {
    const { r, scale } = await played();
    expect(r.overlays.at(-1)).toMatchObject({ scale });
    r.ui.setStressAnimate(true);
    frame(1000);
    expect(r.deformations.at(-1)).toBe(scale);
    frame(1200);
    expect(r.deformations.at(-1)).toBeCloseTo(swingScale(REST + 200, scale), 12);
  });

  it("pauses where the swing is, cancels the frame, and plays on from that pose", async () => {
    const { r, scale } = await played();
    const p = usePanelsStore();
    r.ui.setStressAnimate(true);
    frame(1000);
    frame(1250);
    clock = 1400;
    r.ui.setStressAnimate(false);
    const held = swingScale(REST + 400, scale);
    expect({ animate: p.stress!.deform!.animate, drawn: r.deformations.at(-1), pending: frames.size }).toEqual({
      animate: false,
      drawn: held,
      pending: 0,
    });
    expect(cancelled).toHaveLength(1);
    clock = 9000;
    r.ui.setStressAnimate(true);
    frame(9000);
    expect(r.deformations.at(-1)).toBeCloseTo(held, 12);
    frame(9100);
    expect(r.deformations.at(-1)).toBeCloseTo(swingScale(REST + 500, scale), 12);
  });

  it("draws the full pose at a slider value set while paused, and plays on from it", async () => {
    const { r } = await played();
    r.ui.setStressAnimate(true);
    frame(1000);
    clock = 1300;
    r.ui.setStressAnimate(false);
    r.ui.setStressDeformation(37.5);
    expect(r.deformations.at(-1)).toBe(37.5);
    clock = 2000;
    r.ui.setStressAnimate(true);
    frame(2000);
    expect(r.deformations.at(-1)).toBe(37.5);
  });

  it("swings to the true size on the next frame after True size while playing", async () => {
    const { r, scale } = await played();
    r.ui.setStressAnimate(true);
    frame(1000);
    frame(1100);
    const drawn = r.deformations.length;
    r.ui.setStressDeformation(1);
    expect(r.deformations.length).toBe(drawn);
    frame(1300);
    expect(r.deformations.at(-1)).toBeCloseTo(swingScale(REST + 300, 1), 12);
    expect(scale).not.toBe(1);
  });

  it("pauses when the tab asks, and when the shape goes, coming back at the held pose", async () => {
    const { r, scale } = await played();
    const p = usePanelsStore();
    r.ui.setStressAnimate(true);
    frame(1000);
    clock = 1200;
    r.ui.pauseStressAnimation();
    const held = swingScale(REST + 200, scale);
    expect({ animate: p.stress!.deform!.animate, drawn: r.deformations.at(-1) }).toEqual({
      animate: false,
      drawn: held,
    });
    clock = 5000;
    r.ui.setStressAnimate(true);
    frame(5000);
    clock = 5300;
    r.ui.setStressColours(false);
    expect(p.stress!.deform!.animate, "the colours no longer carry the shape").toBe(true);
    r.ui.setStressShape(false);
    expect(p.stress!.deform!.animate).toBe(false);
    expect(frames.size).toBe(0);
    r.ui.setStressShape(true);
    expect(r.overlays.at(-1)).toMatchObject({ colours: false, scale: swingScale(REST + 500, scale) });
  });

  it("resets to the full pose and cancels on Close, and a new Run starts still at full", async () => {
    const { r } = await played();
    r.ui.setStressAnimate(true);
    frame(1000);
    clock = 1500;
    r.ui.setStressAnimate(false);
    void r.ui.runStress();
    expect(usePanelsStore().stress!.deform).toBeNull();
    r.settle({ ok: true, result: bending });
    await Promise.resolve();
    await Promise.resolve();
    const again = usePanelsStore().stress!.deform!;
    expect(r.overlays.at(-1)).toMatchObject({ scale: again.scale });
    clock = 3000;
    r.ui.setStressAnimate(true);
    frame(3000);
    expect(r.deformations.at(-1)).toBe(again.scale);
    const pending = [...frames.keys()];
    r.ui.closeStress();
    expect(cancelled.slice(-1)).toEqual(pending);
    expect(frames.size).toBe(0);
  });

  it("starts still at full after a body change dropped a paused result", async () => {
    const { r } = await played();
    r.ui.setStressAnimate(true);
    frame(1000);
    clock = 1500;
    r.ui.setStressAnimate(false);
    r.ui.setStressBody("b2");
    r.ui.setStressBody("b1");
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: true, result: bending });
    await run;
    const scale = usePanelsStore().stress!.deform!.scale;
    expect(r.overlays.at(-1)).toMatchObject({ scale });
    clock = 4000;
    r.ui.setStressAnimate(true);
    frame(4000);
    expect(r.deformations.at(-1)).toBe(scale);
  });
});

describe("the result through a close", () => {
  async function ranAndClosed() {
    const r = rig();
    setUp(r);
    await settled(r);
    const p = usePanelsStore();
    r.handlers().pinProbe({ tri: 0, weights: [0.2, 0.5, 0.3], point: [0.5, 0.3, 0] });
    const before = {
      result: p.stress!.result,
      pins: p.stress!.pins,
      overlay: r.overlays.at(-1),
      weak: r.weakSpots.at(-1),
    };
    r.ui.closeStress();
    expect(r.overlays.at(-1)).toBeNull();
    return { r, p, before };
  }

  it("shows the last result again on reopen, with its colours, pins and weakest spot", async () => {
    const { r, p, before } = await ranAndClosed();
    expect(before.pins).toHaveLength(1);
    r.ui.showStress();
    expect(p.stress!.result).toEqual(before.result);
    expect(p.stress!.colours).toBe("shown");
    expect(p.stress!.pins).toEqual(before.pins);
    expect(r.overlays.at(-1)).toEqual(before.overlay);
    expect(r.weakSpots.at(-1)).toEqual(before.weak);
    expect(r.glyphCalls.at(-1)).toBe("pins 1");
    expect(p.stress!.ranSetup, "nothing changed, so no stale line").toBe(JSON.stringify(p.stress!.setup));
  });

  it("keeps the colours off on reopen when they were off at the close", async () => {
    const r = rig();
    setUp(r);
    await settled(r);
    r.ui.setStressColours(false);
    r.ui.closeStress();
    r.ui.showStress();
    const p = usePanelsStore();
    expect(p.stress!.colours).toBe("hidden");
    expect(r.overlays.at(-1)).toMatchObject({ bodyId: "b1", colours: false });
    r.ui.setStressColours(true);
    expect(p.stress!.colours).toBe("shown");
  });

  it("brings the result back without colours or pins after a model edit while closed", async () => {
    const { r, p } = await ranAndClosed();
    r.editDoc();
    const n = r.weakSpots.length;
    r.ui.showStress();
    expect(p.stress!.result).not.toBeNull();
    expect(p.stress!.colours).toBe("none");
    expect(p.stress!.pins).toEqual([]);
    expect(p.stress!.deform).toBeNull();
    expect(r.overlays.at(-1)).toBeNull();
    expect(r.weakSpots.slice(n).filter(Boolean)).toEqual([]);
  });

  it("says the setup changed when the saved study did while closed", async () => {
    const { r, p } = await ranAndClosed();
    const s = structuredClone(r.study()!);
    s.loads[0]!.force = 250;
    r.setStudy(s);
    r.ui.showStress();
    expect(p.stress!.result).not.toBeNull();
    expect(p.stress!.colours).toBe("shown");
    expect(p.stress!.ranSetup).not.toBe(JSON.stringify(p.stress!.setup));
  });

  it("drops it after a replacing load, the model it ran on is gone, and keeps it again after the next Run", async () => {
    const { r, p } = await ranAndClosed();
    r.replaceLoad();
    r.ui.showStress();
    expect(p.stress!.result).toBeNull();
    expect(p.stress!.colours).toBe("none");
    expect(r.overlays.at(-1)).toBeNull();

    setUp(r);
    await settled(r);
    const again = p.stress!.result;
    r.ui.closeStress();
    r.editDoc();
    r.ui.showStress();
    expect(p.stress!.result).toEqual(again);
  });

  it("drops it for another body, another document, or a Run stopped by the close", async () => {
    const a = await ranAndClosed();
    a.r.setStudy({ ...structuredClone(a.r.study()!), body: "b2" });
    a.r.ui.showStress();
    expect(a.p.stress!.result).toBeNull();

    const b = await ranAndClosed();
    b.r.open();
    b.r.ui.showStress();
    expect(b.p.stress!.result).toBeNull();
    expect(b.r.overlays.at(-1)).toBeNull();

    const c = rig();
    setUp(c);
    await settled(c);
    void c.ui.runStress();
    c.ui.closeStress();
    c.ui.showStress();
    expect(usePanelsStore().stress!.result).toBeNull();
  });

  it("is kept once: a second close after a reopen keeps the result shown then", async () => {
    const { r, p, before } = await ranAndClosed();
    r.ui.showStress();
    r.ui.closeStress();
    r.ui.showStress();
    expect(p.stress!.result).toEqual(before.result);
    expect(r.overlays.at(-1)).toEqual(before.overlay);
  });
});

describe("the weakest spot", () => {
  const bent: StressReply = {
    ...reply,
    safetyFactor: 3.32,
    maxVonMises: { value: 4, at: [100.2, 0.1, -0.05], face: 2 },
    surface: {
      ...reply.surface!,
      positions: [13.5, -7.25, 4.1, 100, 0, 0, 2, 10, 0.5],
      displacement: [0, 0, 0, 0.25, 0, -2, 0, 0.5, -1],
    },
  };

  async function ran(r: ReturnType<typeof rig>, result: StressReply) {
    const run = r.ui.runStress();
    r.settle({ ok: true, result });
    await run;
  }

  it("is pinned at the drawn corner of the vertex nearest the peak, with the safety factor", async () => {
    const r = rig();
    setUp(r);
    await ran(r, bent);
    const corner = drawnCorner(refineSurface(bent.surface!, 2), 1)!;
    expect(r.weakSpots.at(-1)).toEqual({ ...corner, label: "Weakest, 3.3x safe" });
  });

  it("stays through the colours and shape switches, goes on a new Run and a model change, moves with a new peak", async () => {
    const r = rig();
    setUp(r);
    await ran(r, bent);
    const pin = r.weakSpots.at(-1);
    expect(pin).not.toBeNull();
    r.ui.setStressColours(false);
    r.ui.setStressShape(false);
    expect(r.weakSpots.at(-1)).toEqual(pin);
    r.ui.setStressColours(true);
    expect(r.weakSpots.at(-1)).toEqual(pin);
    const run = r.ui.runStress();
    expect(r.weakSpots.at(-1)).toBeNull();
    const moved = { ...bent, safetyFactor: null, maxVonMises: { value: 4, at: [2.5, 9.5, 0.5] as Vec3, face: 2 } };
    r.settle({ ok: true, result: moved });
    await run;
    const corner = drawnCorner(refineSurface(bent.surface!, 2), 2)!;
    expect(r.weakSpots.at(-1)).toEqual({ ...corner, label: "Weakest" });
    r.editDoc();
    r.rebuild(FIRST);
    expect(r.weakSpots.at(-1)).toBeNull();
  });
});

describe("the colours and the deformed shape, each with its own switch", () => {
  const leaning: StressReply = {
    ...reply,
    safetyFactor: 4.57,
    maxVonMises: { value: 4, at: [100.2, 0.1, -0.05], face: 2 },
    surface: {
      ...reply.surface!,
      positions: [13.5, -7.25, 4.1, 100, 0, 0, 2, 10, 0.5],
      displacement: [0, 0, 0, 0.25, 0, -2, 0, 0.5, -1],
    },
  };
  const TINT = [
    { faceIds: [1], color: 0x4ac6ff },
    { faceIds: [2], color: 0xff9a2e },
  ];

  afterEach(() => vi.unstubAllGlobals());

  async function ran() {
    const r = rig();
    setUp(r);
    const run = r.ui.runStress();
    r.settle({ ok: true, result: leaning });
    await run;
    const p = usePanelsStore();
    const drawn = refineSurface(leaning.surface!, 2);
    const still = {
      bodyId: "b1",
      positions: drawn.positions,
      indices: drawn.indices,
      values: drawn.values,
      range: { min: 1, max: 4 },
    };
    const bent = { displacement: drawn.displacement, scale: p.stress!.deform!.auto };
    const pin = r.weakSpots.at(-1)!;
    const seen = () => ({
      overlay: r.overlays.at(-1),
      marks: r.marks.at(-1),
      pin: r.weakSpots.at(-1),
      colours: p.stress!.colours,
      shape: p.stress!.deform!.shown,
    });
    return { r, p, still, bent, pin, seen };
  }

  it("draws each of the four combinations, the weakest pin through all of them", async () => {
    const { r, still, bent, pin, seen } = await ran();
    expect(pin.label).toBe("Weakest, 4.5x safe");
    expect(seen()).toEqual({
      overlay: { ...still, colours: true, ...bent },
      marks: null,
      pin,
      colours: "shown",
      shape: true,
    });
    r.ui.setStressColours(false);
    expect(seen()).toEqual({
      overlay: { ...still, colours: false, ...bent },
      marks: null,
      pin,
      colours: "hidden",
      shape: true,
    });
    r.ui.setStressShape(false);
    // Plain and still: the body itself shows, its faces tinted and pickable.
    expect(seen()).toEqual({
      overlay: { ...still, colours: false },
      marks: TINT,
      pin,
      colours: "hidden",
      shape: false,
    });
    r.ui.setStressColours(true);
    expect(seen()).toEqual({ overlay: { ...still, colours: true }, marks: null, pin, colours: "shown", shape: false });
    r.ui.setStressShape(true);
    expect(seen()).toEqual({
      overlay: { ...still, colours: true, ...bent },
      marks: null,
      pin,
      colours: "shown",
      shape: true,
    });
  });

  it("a shape switch already on draws nothing again, and Close leaves the plain body", async () => {
    const { r } = await ran();
    const n = r.overlays.length;
    r.ui.setStressShape(true);
    expect(r.overlays.length).toBe(n);
    r.ui.setStressColours(false);
    r.ui.closeStress();
    expect({ overlay: r.overlays.at(-1), marks: r.marks.at(-1), panel: usePanelsStore().stress }).toEqual({
      overlay: null,
      marks: null,
      panel: null,
    });
  });

  it("placing a spot takes both off, so the click lands on the body", async () => {
    const { r, p, still, pin, seen } = await ran();
    r.ui.placeStressSpot({ support: p.stress!.setup.supports[0]!.id });
    expect(seen()).toEqual({
      overlay: { ...still, colours: false },
      marks: TINT,
      pin,
      colours: "hidden",
      shape: false,
    });
  });

  it("Play puts a hidden shape back, and the slider moves it only while it is drawn", async () => {
    const { r, p, still, bent, seen } = await ran();
    r.ui.setStressShape(false);
    r.ui.setStressDeformation(2.5);
    expect(r.overlays.at(-1)).toEqual({ ...still, colours: true });
    r.ui.setStressShape(true);
    expect(seen().overlay).toEqual({ ...still, colours: true, ...bent, scale: 2.5 });
    vi.stubGlobal("requestAnimationFrame", () => 7);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    r.ui.setStressShape(false);
    r.ui.setStressAnimate(true);
    expect({ shape: p.stress!.deform!.shown, animate: p.stress!.deform!.animate }).toEqual({
      shape: true,
      animate: true,
    });
  });

  it("an eye toggle keeps the shape and the pin with the colours off, and draws nothing over a hidden body", async () => {
    const { r, still, bent, pin, seen } = await ran();
    r.rebuild(FIRST);
    expect(seen()).toEqual({
      overlay: { ...still, colours: false, ...bent },
      marks: null,
      pin,
      colours: "hidden",
      shape: true,
    });
    r.store.isBodyVisible = () => false;
    r.rebuild(FIRST);
    expect(seen()).toEqual({ overlay: null, marks: null, pin, colours: "hidden", shape: true });
  });

  it("an edit drops the drawing whichever switch is on", async () => {
    const { r } = await ran();
    r.ui.setStressColours(false);
    r.editDoc();
    r.rebuild(FIRST);
    const n = r.overlays.length;
    r.ui.setStressShape(true);
    r.ui.setStressColours(true);
    expect(r.overlays.length).toBe(n);
    expect({ colours: usePanelsStore().stress!.colours, deform: usePanelsStore().stress!.deform }).toEqual({
      colours: "none",
      deform: null,
    });
  });
});
