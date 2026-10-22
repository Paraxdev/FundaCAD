import { describe, expect, it } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

// Two busy ops at once, a mesh import started while a large STEP import is
// still running: whichever ends first, the chip and Cancel stay with the op
// that is still running.

function backend() {
  const cancels: (string | undefined)[] = [];
  const be = {
    async init() {},
    onStatus() {
      return () => {};
    },
    async cancel(target?: string) {
      cancels.push(target);
      return true;
    },
    connected: true,
  } as unknown as GeometryBackend;
  return { be, cancels };
}

const doc = (): CadDocument => ({ parameters: {}, features: [] });

function op(store: DocumentStore, label: string, id: string) {
  let finish: () => void = () => {};
  const done = store.runBusy(label, (onStarted) => {
    onStarted(id);
    return new Promise<void>((r) => {
      finish = r;
    });
  });
  return { done, finish: () => finish() };
}

describe("busy ops that overlap", () => {
  it("hand the chip back to the older op when the newer one ends", async () => {
    const { be, cancels } = backend();
    const store = new DocumentStore(be, doc());
    const step = op(store, "Importing frame.step", "rq-step");
    const stl = op(store, "Importing tet.stl", "rq-stl");
    expect(store.busyState).toMatchObject({ active: true, label: "Importing tet.stl", id: "rq-stl" });

    stl.finish();
    await stl.done;
    expect(store.busyState).toMatchObject({ active: true, label: "Importing frame.step", id: "rq-step" });
    await store.cancelBusy();
    expect(cancels).toEqual(["rq-step"]);

    step.finish();
    await step.done;
    expect(store.busyState.active).toBe(false);
  });

  it("keep the newer op's chip when the older one ends first", async () => {
    const { be, cancels } = backend();
    const store = new DocumentStore(be, doc());
    const step = op(store, "Importing frame.step", "rq-step");
    const stl = op(store, "Importing tet.stl", "rq-stl");

    step.finish();
    await step.done;
    expect(store.busyState).toMatchObject({ active: true, label: "Importing tet.stl", id: "rq-stl" });
    await store.cancelBusy();
    expect(cancels).toEqual(["rq-stl"]);

    stl.finish();
    await stl.done;
    expect(store.busyState.active).toBe(false);
  });
});
