// An ordinary slow rebuild keeps the old model drawn and pickable, a light cue says a newer one is coming. The cue
// waits out the grace so a fast build never flashes it, and leaves with the build however that build ends.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUT_OF_DATE_GRACE_MS, watchOutOfDate, watchSlowBuild } from "../../src/app/staleModel";
import type { BusyState, RebuildState } from "../../src/document/store";
import { SessionHost } from "../../src/document/session";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

function fakeStore() {
  const builds = new Set<(s: RebuildState) => void>();
  const previews = new Set<() => void>();
  const s = {
    building: false,
    cancelled: false,
    progress: null as number | null,
    hasPreview: false,
    drawnBehind: false,
    listeners: () => builds.size + previews.size,
    get buildState() {
      return { building: s.building, cancelled: s.cancelled, progress: s.progress } as unknown as RebuildState;
    },
    get busyState() {
      return { waiting: null } as BusyState;
    },
    runningOps: [],
    sessions: new SessionHost(),
    onBuild(fn: (st: RebuildState) => void) {
      builds.add(fn);
      fn(s.buildState);
      return () => builds.delete(fn);
    },
    onBusy() {
      return () => {};
    },
    onPreview(fn: () => void) {
      previews.add(fn);
      return () => previews.delete(fn);
    },
    // Like store.setPreview while a rebuild runs: the preview only queues, no build event says so.
    preview(on: boolean) {
      s.hasPreview = on;
      for (const fn of previews) fn();
    },
    emit(patch: Partial<{ building: boolean; cancelled: boolean; progress: number | null; hasPreview: boolean }>) {
      Object.assign(s, patch);
      for (const fn of builds) fn(s.buildState);
    },
  };
  return s;
}

function rig() {
  vi.useFakeTimers();
  const store = fakeStore();
  const cue: boolean[] = [];
  const off = watchSlowBuild(store, (on) => cue.push(on));
  return { store, cue, off };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the updating cue of a slow rebuild", () => {
  it("shows exactly at the grace, not a millisecond before, and progress frames do not restart the wait", () => {
    const r = rig();
    r.store.emit({ building: true });
    vi.advanceTimersByTime(250);
    r.store.emit({ progress: 3 });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS - 251);
    r.store.emit({ progress: 7 });
    const before = [...r.cue];
    vi.advanceTimersByTime(1);
    expect({ before, after: r.cue }).toEqual({ before: [], after: [true] });
  });

  it("never shows for a fast build, nor for several fast builds in a row", () => {
    const r = rig();
    for (let i = 0; i < 3; i++) {
      r.store.emit({ building: true });
      vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS - 37);
      r.store.emit({ building: false });
      vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 3);
    }
    expect(r.cue).toEqual([]);
  });

  it("hides when the build lands, and the next slow build waits out its own grace", () => {
    const r = rig();
    r.store.emit({ building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS + 900);
    r.store.emit({ building: false });
    r.store.emit({ building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS - 1);
    const between = [...r.cue];
    vi.advanceTimersByTime(1);
    expect({ between, end: r.cue }).toEqual({ between: [true, false], end: [true, false, true] });
  });

  it("hides when the build is cancelled", () => {
    const r = rig();
    r.store.emit({ building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 4);
    r.store.emit({ building: false, cancelled: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 4);
    expect(r.cue).toEqual([true, false]);
  });

  it("hides when the session ends, and a document loaded next starts with no cue", () => {
    const r = rig();
    r.store.emit({ building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 2);
    r.off();
    r.store.emit({ building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 2);
    const ended = { cue: [...r.cue], listeners: r.store.listeners() };

    const next = watchSlowBuild(r.store, (on) => r.cue.push(on));
    r.store.emit({ building: false });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 2);
    next();
    expect({ ended, after: r.cue }).toEqual({ ended: { cue: [true, false], listeners: 0 }, after: [true, false] });
  });

  it("a session ended before the grace never shows the cue", () => {
    const r = rig();
    r.store.emit({ building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS - 120);
    r.off();
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 2);
    expect(r.cue).toEqual([]);
  });

  it("is left to the tool while a preview builds, and hides once one starts", () => {
    const r = rig();
    r.store.emit({ hasPreview: true, building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 3);
    const preview = [...r.cue];
    r.store.emit({ hasPreview: false, building: false });
    r.store.emit({ building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS);
    r.store.emit({ hasPreview: true });
    expect({ preview, after: r.cue }).toEqual({ preview: [], after: [true, false] });
  });

  it("shows with a build already running when it is watched, and does not ghost the model", () => {
    vi.useFakeTimers();
    const store = fakeStore();
    store.building = true;
    const cue: boolean[] = [];
    const ghost: boolean[] = [];
    const offCue = watchSlowBuild(store, (on) => cue.push(on));
    const offGhost = watchOutOfDate(store, (on) => ghost.push(on));
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 5);
    offCue();
    offGhost();
    expect({ cue, ghost }).toEqual({ cue: [true, false], ghost: [] });
  });

  it("never shows for a preview that starts within the grace of a running build, and stays hidden through it", () => {
    for (const at of [1, 250, OUT_OF_DATE_GRACE_MS - 1]) {
      const r = rig();
      r.store.emit({ building: true });
      vi.advanceTimersByTime(at);
      r.store.preview(true);
      vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 3);
      r.off();
      expect({ at, cue: r.cue }).toEqual({ at, cue: [] });
    }
  });

  it("a preview starting exactly as the grace ends still hides the cue", () => {
    const r = rig();
    r.store.emit({ building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS);
    r.store.preview(true);
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 2);
    expect(r.cue).toEqual([true, false]);
  });

  it("hides a shown cue when a preview starts, and a build still running after the preview waits out a new grace", () => {
    const r = rig();
    r.store.emit({ building: true });
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS + 430);
    r.store.preview(true);
    const during = [...r.cue];
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 2);
    r.store.preview(false);
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS - 1);
    const before = [...r.cue];
    vi.advanceTimersByTime(1);
    expect({ during, before, after: r.cue }).toEqual({
      during: [true, false],
      before: [true, false],
      after: [true, false, true],
    });
  });
});

const RESULT: RebuildResult = {
  mesh: { positions: [3, -2, 7], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [-4, 1.5, 2], max: [9, 6.25, 11] },
  bodies: [{ id: "b1", name: "Body1", faceStart: 0, faceCount: 1 }],
};
const DOC = {
  parameters: {},
  features: [{ id: "f1", type: "sketch", plane: "XZ", entities: [] }],
} as unknown as CadDocument;

/** Lands the first build, then holds every later one until `land` answers it. */
function heldEngine() {
  const held: (() => void)[] = [];
  let calls = 0;
  const engine = {
    async rebuild() {
      if (++calls === 1) return { ok: true as const, result: RESULT };
      return new Promise((res) => held.push(() => res({ ok: true as const, result: RESULT })));
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    onProgress() {
      return () => {};
    },
    async cancel() {
      return true;
    },
  } as unknown as GeometryBackend;
  return { engine, land: () => held.splice(0).forEach((f) => f()) };
}

const PREVIEW = { id: "pv", type: "box", width: 37, depth: 12.5, height: 4 } as never;

describe("the updating cue on the real store while a tool previews", () => {
  async function running() {
    vi.useFakeTimers();
    const e = heldEngine();
    const store = new DocumentStore(e.engine, DOC);
    await store.rebuildNow();
    const cue: boolean[] = [];
    const off = watchSlowBuild(store, (on) => cue.push(on));
    void store.rebuildNow();
    await vi.advanceTimersByTimeAsync(0);
    return { store, cue, off, land: e.land };
  }

  it("a preview set within the grace of a committed rebuild never shows the cue", async () => {
    const r = await running();
    const building = r.store.buildState.building;
    await vi.advanceTimersByTimeAsync(210);
    r.store.setPreview(PREVIEW);
    await vi.advanceTimersByTimeAsync(OUT_OF_DATE_GRACE_MS * 3);
    r.off();
    expect({ building, cue: r.cue }).toEqual({ building: true, cue: [] });
  });

  it("a preview set after the cue shows hides it, and a second document loaded next starts with none", async () => {
    const r = await running();
    await vi.advanceTimersByTimeAsync(OUT_OF_DATE_GRACE_MS + 75);
    r.store.setPreview(PREVIEW);
    const during = [...r.cue];
    r.store.setPreview(null);
    r.store.load(JSON.stringify({ parameters: {}, features: [] }));
    r.land();
    await vi.advanceTimersByTimeAsync(OUT_OF_DATE_GRACE_MS * 3);
    r.off();
    expect({ during, after: r.cue, preview: r.store.hasPreview }).toEqual({
      during: [true, false],
      after: [true, false],
      preview: false,
    });
  });
});
