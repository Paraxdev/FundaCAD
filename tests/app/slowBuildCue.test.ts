// An ordinary slow rebuild keeps the old model drawn and pickable, a light cue says a newer one is coming. The cue
// waits out the grace so a fast build never flashes it, and leaves with the build however that build ends.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUT_OF_DATE_GRACE_MS, watchOutOfDate, watchSlowBuild } from "../../src/app/staleModel";
import type { BusyState, RebuildState } from "../../src/document/store";

function fakeStore() {
  const builds = new Set<(s: RebuildState) => void>();
  const s = {
    building: false,
    cancelled: false,
    progress: null as number | null,
    hasPreview: false,
    drawnBehind: false,
    listeners: () => builds.size,
    get buildState() {
      return { building: s.building, cancelled: s.cancelled, progress: s.progress } as unknown as RebuildState;
    },
    get busyState() {
      return { waiting: null } as BusyState;
    },
    runningOps: [],
    onBuild(fn: (st: RebuildState) => void) {
      builds.add(fn);
      fn(s.buildState);
      return () => builds.delete(fn);
    },
    onBusy() {
      return () => {};
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
});
