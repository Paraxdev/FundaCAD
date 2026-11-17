import * as THREE from "three";
import { afterEach } from "vitest";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import type { StressOptions, StressReply, StressResult } from "../../src/geometry/client";
import type { CadDocument, StressStudy, Vec3 } from "../../src/types";
import type { StressGlyphHandlers, StressGlyphModel } from "../../src/viewport/stressGlyphs";
import type { DisplayMesh } from "../../src/ui/stressDrawn";

// The Stress panel's facade against a hand-made viewport, store and engine.

export type FaceMap = Record<number, { body: string; z: number; n: number; tris?: THREE.Triangle[] }>;
// Face 1 is the bottom of body b1 (normal -Z), face 2 its top (+Z), face 9 on b2.
export const FIRST: FaceMap = {
  1: { body: "b1", z: 0, n: -1 },
  2: { body: "b1", z: 10, n: 1 },
  9: { body: "b2", z: 0, n: 1 },
};

export function quad(z: number, n: number): THREE.Triangle[] {
  const a = new THREE.Vector3(0, 0, z),
    b = new THREE.Vector3(10, 0, z),
    c = new THREE.Vector3(10, 10, z),
    d = new THREE.Vector3(0, 10, z);
  return n > 0
    ? [new THREE.Triangle(a, b, c), new THREE.Triangle(a, c, d)]
    : [new THREE.Triangle(a, c, b), new THREE.Triangle(a, d, c)];
}

export const reply: StressReply = {
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

// Each rig's language listener goes with its test, so a later switch runs no old rig's closures.
const made: { dispose: () => void }[] = [];
afterEach(() => made.splice(0).forEach((ui) => ui.dispose()));

export function rig(opts: { hasBody?: boolean; engine?: boolean } = {}) {
  // The current tessellation's display faces; a rebuild may renumber them.
  let FACES: FaceMap = FIRST;
  let selected: number[] = [];
  let shown = false;
  const openListeners: (() => void)[] = [];
  const marks: unknown[] = [];
  const overlays: unknown[] = [];
  const frames: { at: [number, number, number]; size: number }[] = [];
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
  const pinLabels: string[][] = [];
  let handlers: StressGlyphHandlers | null = null;
  let pick: { tri: number; weights: Vec3; point: Vec3 } | null = null;
  let display: DisplayMesh | null = null;

  const viewport = {
    bodyDisplayMesh: () => display,
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
    // A point on the face off its middle, as a triangle centroid is.
    faceSelectorOf: (f: number) => {
      const t = (FACES[f]?.tris ?? quad(FACES[f]!.z, FACES[f]!.n))[0]!;
      const c = t.getMidpoint(new THREE.Vector3());
      return { kind: "face", by: "nearest", point: [c.x, c.y, c.z], body: FACES[f]!.body };
    },
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
    frameAround: (at: [number, number, number], size: number) => frames.push({ at, size }),
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
    onBuild: () => () => {},
    isBodyVisible: (_id: string) => true,
    bodyName: (_id: string): string | undefined => undefined,
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
    geometry: opts.engine === false ? {} : geometry,
    hasBody: () => opts.hasBody ?? true,
    setStatus: (t: string) => statuses.push(t),
    stressGlyphs: (h: StressGlyphHandlers) => {
      handlers = h;
      return {
        setModel: (m: StressGlyphModel) => glyphModels.push(m),
        setProbe: (on: boolean) => glyphCalls.push(`probe ${on}`),
        setProbePins: (p: { label: string }[]) => {
          glyphCalls.push(`pins ${p.length}`);
          pinLabels.push(p.map((x) => x.label));
        },
        setPlacing: (p: { radius: number | null } | null) => glyphCalls.push(`placing ${p ? p.radius : "off"}`),
        setWeakSpot: (w: { tri: number; weights: Vec3; label: string } | null) => weakSpots.push(w),
        dispose: () => glyphCalls.push("dispose"),
      };
    },
  } as unknown as PanelsDeps;
  const ui = createPanels(deps);
  made.push(ui);
  return {
    ui,
    store,
    built,
    marks,
    overlays,
    frames,
    statuses,
    calls,
    cancels,
    saved,
    deformations,
    weakSpots,
    glyphModels,
    glyphCalls,
    pinLabels,
    viewport,
    handlers: () => handlers!,
    showDisplay: (m: DisplayMesh | null) => {
      display = m;
    },
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
