import { describe, expect, it } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend, OpProgressListener } from "../../src/geometry/client";
import { busyLine } from "../../src/ui/buildProgress";

// An import's `importing` frames drive the busy line's bar: the stage name, its
// fraction or an indeterminate bar, only for the busy op's own request, and
// Cancel still targets that request.

function backend() {
  const listeners: OpProgressListener[] = [];
  const cancels: (string | undefined)[] = [];
  const be = {
    async init() {},
    onStatus() { return () => {}; },
    onOpProgress(fn: OpProgressListener) { listeners.push(fn); return () => {}; },
    async cancel(target?: string) { cancels.push(target); return true; },
    connected: true,
  } as unknown as GeometryBackend;
  return {
    be,
    cancels,
    frame: (id: string, pct: number | null, stage: string) => listeners.forEach((fn) => fn(id, pct, stage)),
  };
}

const doc = (): CadDocument => ({ parameters: {}, features: [] });

function importing(store: DocumentStore) {
  let finish: () => void = () => {};
  const done = store.runBusy("Importing sv08.step", (onStarted) => {
    onStarted("imp1");
    return new Promise<void>((r) => { finish = r; });
  });
  return { done, finish: () => finish() };
}

describe("import progress in the busy state", () => {
  it("takes the stage and fraction of its own request and keeps the label", async () => {
    const { be, frame } = backend();
    const store = new DocumentStore(be, doc());
    const run = importing(store);

    frame("imp1", 42, "Transferring shapes");
    expect(store.busyState).toMatchObject({ label: "Importing sv08.step", stage: "Transferring shapes", pct: 42 });
    expect(busyLine(store.busyState)).toEqual({
      text: "Importing sv08.step", detail: "Transferring shapes 42%", bar: true, pct: 42,
    });

    frame("someone-else", 90, "Saving the geometry");
    expect(store.busyState.pct).toBe(42);

    frame("imp1", null, "Colours, names and repairs");
    expect(store.busyState).toMatchObject({ stage: "Colours, names and repairs", pct: null });
    expect(busyLine(store.busyState)).toMatchObject({ detail: "Colours, names and repairs", bar: true, pct: null });

    run.finish();
    await run.done;
    expect(store.busyState).toMatchObject({ active: false, stage: null, pct: null });
  });

  it("ignores a frame with no busy op", () => {
    const { be, frame } = backend();
    const store = new DocumentStore(be, doc());
    frame("imp1", 10, "Reading the file");
    expect(store.busyState).toMatchObject({ active: false, stage: null, pct: null });
  });

  it("keeps Cancel on the import's request", async () => {
    const { be, frame, cancels } = backend();
    const store = new DocumentStore(be, doc());
    const run = importing(store);
    frame("imp1", 5, "Transferring shapes");
    expect(await store.cancelBusy()).toBe(true);
    expect(cancels).toEqual(["imp1"]);
    run.finish();
    await run.done;
  });

  it("shows no bar for an op that reports no stages", () => {
    expect(busyLine({ label: "Exporting part.step", stage: null, pct: null, waiting: null })).toEqual({
      text: "Exporting part.step", detail: null, bar: false, pct: null,
    });
  });
});
