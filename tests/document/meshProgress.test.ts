// The meshing phase reports feature = -1 for its whole duration, so the timeline
// chip has to get its fraction from the separate meshed/meshTotal channel. Before
// that channel existed the bar sat at 0% for the entire phase, measured at 136 s
// on the 3,071-body reference assembly, the largest feel defect on the open path.
// These tests pin the store half of that contract: the counts reach RebuildState,
// the "not meshing" sentinel (-1) is normalised to null, and they are cleared when
// a build ends so a finished rebuild can't leave a stale fraction on screen.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, RebuildReply } from "../../src/types";
import { Geometry, type GeometryBackend } from "../../src/geometry/client";
import { buildProgress } from "../../src/ui/buildProgress";
import { APPLY_LABEL_AFTER_MS, BUILD_PHASE } from "../../src/geometry/buildPhase";
import { box } from "./storeKit";

type ProgressFn = (feature: number, meshed: number, meshTotal: number, id?: string, phase?: number) => void;

function backend(onRebuild?: () => void) {
  const listeners: ProgressFn[] = [];
  const be = {
    async rebuild(): Promise<RebuildReply> {
      onRebuild?.();
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    onProgress(fn: ProgressFn) {
      listeners.push(fn);
      return () => {};
    },
    async cancel() {
      return true;
    },
    connected: true,
  } as unknown as GeometryBackend;
  return {
    be,
    emit: (f: number, m: number, t: number, p: number) => listeners.forEach((fn) => fn(f, m, t, undefined, p)),
  };
}

const emptyDoc = (): CadDocument => ({ parameters: {}, features: [] });

describe("meshing progress reaches the build state", () => {
  it("records meshed/meshTotal while building", () => {
    const { be, emit } = backend();
    const store = new DocumentStore(be, emptyDoc());
    // emit is ignored unless a build is in flight, so fake that flag
    (store as unknown as { build: { building: boolean } }).build.building = true;
    emit(-1, 812, 3071, BUILD_PHASE.meshing);
    expect(store.buildState.meshed).toBe(812);
    expect(store.buildState.meshTotal).toBe(3071);
    expect(store.buildState.progress).toBe(-1);
    expect(store.buildState.phase).toBe(BUILD_PHASE.meshing);
  });

  it("normalises the -1/-1 'not meshing' sentinel to null", () => {
    const { be, emit } = backend();
    const store = new DocumentStore(be, emptyDoc());
    (store as unknown as { build: { building: boolean } }).build.building = true;
    emit(-1, 5, 10, BUILD_PHASE.meshing);
    expect(store.buildState.meshed).toBe(5);
    emit(3, -1, -1, BUILD_PHASE.feature); // back to a real feature index; no meshing in flight
    expect(store.buildState.meshed).toBeNull();
    expect(store.buildState.meshTotal).toBeNull();
    expect(store.buildState.progress).toBe(3);
  });

  it("ignores progress when no build is in flight", () => {
    const { be, emit } = backend();
    const store = new DocumentStore(be, emptyDoc());
    emit(-1, 900, 3071, BUILD_PHASE.meshing);
    expect(store.buildState.meshed).toBeNull();
  });

  it("clears the counts when the rebuild finishes", async () => {
    const { be, emit } = backend(() => emit(-1, 400, 3071, BUILD_PHASE.meshing));
    const store = new DocumentStore(be, emptyDoc());
    await store.rebuildNow();
    expect(store.buildState.building).toBe(false);
    expect(store.buildState.meshed).toBeNull();
    expect(store.buildState.meshTotal).toBeNull();
    expect(store.buildState.phase).toBeNull();
  });
});

describe("a long rebuild is cancellable", () => {
  it("marks the store busy for the duration of a rebuild", async () => {
    let busyDuring = false;
    const { be } = backend();
    const store = new DocumentStore(be, emptyDoc());
    store.onBusy((b) => {
      if (b.active) busyDuring = true;
    });
    await store.rebuildNow();
    // busy.active must have been true at some point (that is what gates the
    // Cancel button in timeline.ts) and must be cleared afterwards
    expect(busyDuring).toBe(true);
    expect(store.busyState.active).toBe(false);
  });

  it("cancelBusy still works without a request id (rebuild never learns one)", async () => {
    const { be } = backend();
    const store = new DocumentStore(be, emptyDoc());
    let cancelled = false;
    await store.runBusy("Rebuilding", async () => {
      cancelled = await store.cancelBusy();
    });
    expect(cancelled).toBe(true);
  });
});

describe("the app labels its own commit before it freezes the page", () => {
  const seen = async (replyAfterMs: number) => {
    const { be } = backend();
    be.rebuild = async () => {
      await new Promise((r) => setTimeout(r, replyAfterMs));
      return { ok: true, result: { bodies: [] } } as unknown as RebuildReply;
    };
    const store = new DocumentStore(be, emptyDoc());
    const states: [boolean, number | null][] = [];
    store.onBuild((b) => states.push([b.building, b.phase]));
    await store.rebuildNow();
    return states.slice(1);
  };

  it("shows Applying while still building after a slow reply, then settles", async () => {
    const states = await seen(APPLY_LABEL_AFTER_MS + 60);
    expect(states).toEqual([
      [true, null],
      [true, BUILD_PHASE.applying],
      [false, null],
    ]);
  });

  it("commits at once after a quick reply", async () => {
    const states = await seen(5);
    expect(states).toEqual([
      [true, null],
      [false, null],
    ]);
  });
});

describe("the chip over the engine's own frames", () => {
  it("says meshing only in the frames that count a body being meshed", () => {
    const g = new Geometry();
    const inner = g as unknown as { pending: Map<string, () => void>; onMessage(data: string): void };
    inner.pending.set("r1", () => {});
    const store = new DocumentStore(g, {
      parameters: {},
      features: ["Sketch", "Extrude", "Fillet"].map((n, i) => ({ id: `f${i}`, type: "box", name: n })),
    } as unknown as CadDocument);
    // The frames are this document's own rebuild, so they count only while it is the one in flight.
    const faked = store as unknown as { build: { building: boolean }; st: { inflight: { id: string | null } | null } };
    faked.build.building = true;
    faked.st.inflight = { id: "r1" };
    const frames = [
      { phase: 0, feature: -1, meshed: -1, meshTotal: -1 },
      { phase: 1, feature: 2, meshed: -1, meshTotal: -1 },
      { phase: 2, feature: -1, meshed: -1, meshTotal: -1 },
      { phase: 4, feature: -1, meshed: -1, meshTotal: -1 },
      { phase: 3, feature: -1, meshed: 0, meshTotal: 1 },
      { phase: 4, feature: -1, meshed: -1, meshTotal: -1 },
    ];
    const names = store.document.features.map((f) => (f as { name: string }).name);
    const labels = frames.map((f) => {
      inner.onMessage(JSON.stringify({ id: "r1", status: "building", ...f }));
      return buildProgress(store.buildState, names).label;
    });
    expect(labels).toEqual([
      "preparing…",
      "Fillet 3/3",
      "saving a checkpoint…",
      "collecting the result…",
      "meshing 1 part",
      "collecting the result…",
    ]);
  });
});

describe("build progress belongs to the rebuild this document has on the wire", () => {
  it("takes a status of its own rebuild id and ignores one of any other request", async () => {
    const listeners: ((f: number, m: number, t: number, id?: string) => void)[] = [];
    const be = {
      rebuild(_d: CadDocument, _t?: number, onId?: (id: string) => void) {
        onId?.("r-own");
        return new Promise<RebuildReply>(() => {});
      },
      async init() {},
      onStatus: () => () => {},
      onProgress(fn: (f: number, m: number, t: number, id?: string) => void) {
        listeners.push(fn);
        return () => {};
      },
      async cancel() {
        return true;
      },
      connected: true,
    } as unknown as GeometryBackend;
    const store = new DocumentStore(be, { parameters: {}, features: [box("plate", 40)] });
    void store.rebuildNow();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const seen = () => ({ progress: store.buildState.progress, meshed: store.buildState.meshed });
    listeners.forEach((fn) => fn(-1, 40, 90, "r-import-of-the-last-document"));
    const other = seen();
    listeners.forEach((fn) => fn(-1, 7, 90, "r-own"));
    expect({ building: store.buildState.building, other, own: seen() }).toEqual({
      building: true,
      other: { progress: null, meshed: null },
      own: { progress: -1, meshed: 7 },
    });
  });
});
