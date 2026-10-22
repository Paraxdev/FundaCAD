// A model behind its document passed for the current one: the deleted body stayed pickable for minutes while the
// build that removed it waited behind an import. It is marked out of date only once something it was built from is
// gone from the document, at once when its build waits on another op, after a short grace while its own build runs.
// An ordinary edit's model stays drawn and pickable until the next one lands.
import { describe, expect, it, vi } from "vitest";
import { OUT_OF_DATE_GRACE_MS, watchOutOfDate } from "../../src/app/staleModel";
import type { BusyState, RebuildState, RunningOp } from "../../src/document/store";

function fakeStore() {
  const builds = new Set<(s: RebuildState) => void>();
  const busies = new Set<(b: BusyState) => void>();
  const s = {
    building: false,
    hasPreview: false,
    drawnBehind: true,
    waiting: null as BusyState["waiting"],
    ops: [] as Pick<RunningOp, "rebuild">[],
    get buildState() {
      return { building: s.building } as RebuildState;
    },
    get busyState() {
      return { waiting: s.waiting } as BusyState;
    },
    get runningOps() {
      return s.ops as RunningOp[];
    },
    onBuild(fn: (st: RebuildState) => void) {
      builds.add(fn);
      return () => builds.delete(fn);
    },
    onBusy(fn: (b: BusyState) => void) {
      busies.add(fn);
      return () => busies.delete(fn);
    },
    emit() {
      for (const fn of builds) fn(s.buildState);
      for (const fn of busies) fn(s.busyState);
    },
  };
  return s;
}

function rig() {
  vi.useFakeTimers();
  const store = fakeStore();
  const marks: boolean[] = [];
  const off = watchOutOfDate(store, (on) => marks.push(on));
  const at = () => marks.at(-1) ?? false;
  return { store, marks, at, off };
}

describe("a model behind its document", () => {
  it("is marked at once when its build waits behind another op of the document, and cleared when it lands", () => {
    const r = rig();
    r.store.ops = [{ rebuild: false }, { rebuild: true }];
    r.store.building = true;
    r.store.emit();
    const waiting = r.at();
    r.store.building = false;
    r.store.drawnBehind = false;
    r.store.ops = [{ rebuild: false }];
    r.store.emit();
    expect({ waiting, landed: r.at() }).toEqual({ waiting: true, landed: false });
    vi.useRealTimers();
  });

  it("is marked at once when another client's job holds its build", () => {
    const r = rig();
    r.store.ops = [{ rebuild: true }];
    r.store.waiting = { who: "assistant", op: "import" };
    r.store.building = true;
    r.store.emit();
    expect(r.at()).toBe(true);
    vi.useRealTimers();
  });

  it("is marked only after the grace while its own build runs, not before", () => {
    const r = rig();
    r.store.ops = [{ rebuild: true }];
    r.store.building = true;
    r.store.emit();
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS - 1);
    const before = r.at();
    vi.advanceTimersByTime(1);
    const after = r.at();
    expect({ before, after }).toEqual({ before: false, after: true });
    vi.useRealTimers();
  });

  it("is never marked when the build lands within the grace, or for a tool's preview build", () => {
    const r = rig();
    r.store.ops = [{ rebuild: true }];
    r.store.building = true;
    r.store.emit();
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS - 100);
    r.store.building = false;
    r.store.drawnBehind = false;
    r.store.ops = [];
    r.store.emit();
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS);
    const fast = r.marks.includes(true);
    r.store.drawnBehind = true;
    r.store.hasPreview = true;
    r.store.building = true;
    r.store.ops = [{ rebuild: false }, { rebuild: true }];
    r.store.emit();
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 2);
    expect({ fast, preview: r.marks.includes(true) }).toEqual({ fast: false, preview: false });
    vi.useRealTimers();
  });

  it("is never marked while nothing it was built from is gone, however long the build runs or waits", () => {
    const r = rig();
    r.store.drawnBehind = false;
    r.store.ops = [{ rebuild: false }, { rebuild: true }];
    r.store.waiting = { who: "assistant", op: "import" };
    r.store.building = true;
    r.store.emit();
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 10);
    r.store.ops = [{ rebuild: true }];
    r.store.waiting = null;
    r.store.emit();
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 10);
    expect(r.marks.includes(true)).toBe(false);
    vi.useRealTimers();
  });

  it("stays marked when the build that would remove the gone feature stops, until one lands", () => {
    const r = rig();
    r.store.ops = [{ rebuild: true }];
    r.store.building = true;
    r.store.emit();
    r.store.building = false;
    r.store.ops = [];
    r.store.emit();
    const stopped = r.at();
    r.store.drawnBehind = false;
    r.store.emit();
    expect({ stopped, landed: r.at() }).toEqual({ stopped: true, landed: false });
    vi.useRealTimers();
  });

  it("stops listening and clears its timer when unwired", () => {
    const r = rig();
    r.store.ops = [{ rebuild: true }];
    r.store.building = true;
    r.store.emit();
    r.off();
    vi.advanceTimersByTime(OUT_OF_DATE_GRACE_MS * 2);
    expect(r.marks.includes(true)).toBe(false);
    vi.useRealTimers();
  });
});
