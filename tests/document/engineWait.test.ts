import { describe, expect, it } from "vitest";
import { DocumentStore, type BusyState } from "../../src/document/store";
import type { CadDocument, RebuildReply } from "../../src/types";
import type { EngineWait, GeometryBackend } from "../../src/geometry/client";

// A rebuild of this document that waits behind another client's job on the
// same engine: the busy state says so, only for its own request id, and
// Cancel targets that id and nothing else.

type QueueFn = (id: string, behind: EngineWait | null) => void;

function backend() {
  const queue: QueueFn[] = [];
  const cancels: (string | undefined)[] = [];
  let release: (r: RebuildReply) => void = () => {};
  let n = 0;
  const be = {
    rebuild(_doc: CadDocument, _t?: number, onId?: (id: string) => void): Promise<RebuildReply> {
      onId?.(`rq${++n}`);
      return new Promise((r) => { release = r; });
    },
    async init() {},
    onStatus() { return () => {}; },
    onQueue(fn: QueueFn) { queue.push(fn); return () => {}; },
    async cancel(target?: string) { cancels.push(target); return true; },
    connected: true,
  } as unknown as GeometryBackend;
  return {
    be,
    cancels,
    frame: (id: string, behind: EngineWait | null) => queue.forEach((fn) => fn(id, behind)),
    finish: () => release({ ok: true, result: { mesh: { positions: [], indices: [], normals: [] }, bodies: [] } as never }),
  };
}

const doc = (): CadDocument => ({ parameters: {}, features: [] });
const assistant: EngineWait = { who: "assistant", name: "Claude", op: "import" };

describe("a rebuild queued behind another client's job", () => {
  it("is marked waiting only by its own request's frames", async () => {
    const { be, frame, finish } = backend();
    const store = new DocumentStore(be, doc());
    const seen: BusyState[] = [];
    store.onBusy((b) => seen.push(b));
    const done = store.rebuildNow();
    await Promise.resolve();
    expect(store.busyState).toMatchObject({ active: true, rebuild: true, id: "rq1", waiting: null });

    frame("someone-else", assistant);
    expect(store.busyState.waiting).toBeNull();
    frame("rq1", assistant);
    expect(store.busyState.waiting).toEqual(assistant);
    frame("rq1", null);
    expect(store.busyState.waiting).toBeNull();

    finish();
    await done;
    expect(store.busyState).toMatchObject({ active: false, waiting: null, rebuild: false });
    expect(seen.some((b) => b.waiting?.name === "Claude")).toBe(true);
  });

  it("cancels its own request id, never the most recent one on the wire", async () => {
    const { be, cancels, frame, finish } = backend();
    const store = new DocumentStore(be, doc());
    const done = store.rebuildNow();
    await Promise.resolve();
    frame("rq1", assistant);
    await store.cancelBusy();
    expect(cancels).toEqual(["rq1"]);
    finish();
    await done;
  });

  it("drops a frame that lands when nothing is busy", () => {
    const { be, frame } = backend();
    const store = new DocumentStore(be, doc());
    frame("rq1", assistant);
    expect(store.busyState.active).toBe(false);
    expect(store.busyState.waiting).toBeNull();
  });
});
