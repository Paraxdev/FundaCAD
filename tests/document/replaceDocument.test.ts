// A document replacement (File → New, File → Open) has to take the old model off
// screen and stop whatever is still building for the document being discarded.
//
// Reported 2026-08-08: File → New during a 3,000-body rebuild left the previous
// model on screen over an empty document, with no message, and hiding the body
// did nothing, because there was no body in the document to hide. Two causes,
// both pinned here. rebuildNow keeps the last good result when a rebuild does not
// produce a new one, which is right within a document and wrong across a
// replacement; and a rebuild already in flight holds the queue, so the
// replacement's own rebuild could not start for as long as the old one ran.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, RebuildResult } from "../../src/types";
import type { GeometryBackend, RebuildChunk } from "../../src/geometry/client";

const RESULT: RebuildResult = {
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: [{ id: "b1", name: "Body1", faceStart: 0, faceCount: 1 }],
};

const DOC: CadDocument = {
  parameters: {},
  features: [{ id: "f1", type: "sketch", plane: "XY", entities: [] } as unknown as CadDocument["features"][number]],
};

/** First rebuild succeeds; every later one hangs, standing in for the long
 *  rebuild that was holding the queue in the field. */
function backend() {
  let calls = 0;
  let cancels = 0;
  const be = {
    async rebuild() {
      calls++;
      if (calls === 1) return { ok: true as const, result: RESULT };
      return new Promise<never>(() => {}); // never settles
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    onProgress() {
      return () => {};
    },
    async cancel() {
      cancels++;
      return true;
    },
  } as unknown as GeometryBackend;
  return { be, calls: () => calls, cancels: () => cancels };
}

async function storeWithModelAndHangingRebuild() {
  const h = backend();
  const store = new DocumentStore(h.be, DOC);
  await store.rebuildNow(); // 1st: lands a real result on screen
  expect(store.buildState.result).not.toBeNull();
  void store.rebuildNow(); // 2nd: hangs, exactly as a huge rebuild would
  await Promise.resolve();
  return { store, h };
}

describe("replacing the document", () => {
  it("takes the old model off screen on File → New", async () => {
    const { store } = await storeWithModelAndHangingRebuild();
    store.newDocument();
    // the shape on screen belonged to the document that was just discarded
    expect(store.buildState.result).toBeNull();
  });

  it("stops the in-flight rebuild on File → New", async () => {
    const { store, h } = await storeWithModelAndHangingRebuild();
    expect(h.cancels()).toBe(0);
    store.newDocument();
    // without this the queued rebuild of the NEW document waits for the old one
    expect(h.cancels()).toBe(1);
  });

  it("does the same on File → Open", async () => {
    const { store, h } = await storeWithModelAndHangingRebuild();
    store.load(JSON.stringify({ parameters: {}, features: [] }));
    expect(store.buildState.result).toBeNull();
    expect(h.cancels()).toBe(1);
  });

  it("clears the progress counters with the model", async () => {
    const { store } = await storeWithModelAndHangingRebuild();
    store.newDocument();
    const s = store.buildState;
    // a stale fraction outliving its document is the same class of bug; building is the new document's own build
    expect(store.busyState).toMatchObject({ active: true, label: "Rebuilding" });
    expect(s.progress).toBeNull();
    expect(s.meshed).toBeNull();
    expect(s.meshTotal).toBeNull();
    expect(s.streamed).toBeNull();
    expect(s.streamTotal).toBeNull();
    expect(s.errorMessage).toBeNull();
    expect(s.errorFeatureId).toBeNull();
  });

  it("is harmless when nothing is building", async () => {
    const h = backend();
    const store = new DocumentStore(h.be, DOC);
    await store.rebuildNow();
    store.newDocument(); // no rebuild in flight
    expect(store.buildState.result).toBeNull();
    // cancelBusy short-circuits when nothing is running, so no pool is killed
    expect(h.cancels()).toBe(0);
  });

  it("leaves nothing of the old document's materials behind on File → New", async () => {
    const h = backend();
    const store = new DocumentStore(h.be, DOC);
    await store.rebuildNow();
    const id = store.addMaterial({ name: "Old red", color: "#ff0000" } as never);
    store.setBodiesMaterial(["b1"], id);
    store.setFacesMaterial([{ body: "b1", face: 0 }], id);
    store.newDocument();
    expect(store.faceMaterialEntries()).toEqual([]);
    expect(store.bodyMaterialId("b1")).toBeUndefined();
    expect(store.materialLibrary.some((m) => m.id === id)).toBe(false);
  });

  // The old document's rebuild can finish before its cancel lands. Its reply
  // must not be published, or the discarded model is drawn again over the new one.
  for (const how of ["New", "Open"] as const) {
    it(`never publishes a late reply for the discarded document after ${how}`, async () => {
      const late = lateReplyBackend();
      const store = new DocumentStore(late.be, DOC);
      await store.rebuildNow();
      void store.rebuildNow();
      await Promise.resolve();
      const seen: (RebuildResult | null)[] = [];
      store.onBuild((s) => seen.push(s.result));
      seen.length = 0;
      if (how === "New") store.newDocument();
      else store.load(JSON.stringify({ parameters: {}, features: [] }));
      late.release({ ok: true, result: { ...RESULT } });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(seen.some((r) => r?.bodies?.[0]?.id === "b1")).toBe(false);
      expect(store.buildState.result).toBeNull();
    });
  }

  it("drops a half streamed model and its late chunks on File → New", async () => {
    const late = lateReplyBackend();
    const store = new DocumentStore(late.be, DOC);
    await store.rebuildNow();
    void store.rebuildNow();
    await Promise.resolve();
    const chunks: number[] = [];
    let aborts = 0;
    store.onBuildChunk((c) => chunks.push(c.done));
    store.onBuildAbort(() => aborts++);
    late.chunk(1);
    expect(chunks).toEqual([1]);
    store.newDocument();
    expect(aborts).toBe(1);
    late.chunk(2);
    expect(chunks).toEqual([1]);
  });
});

/** First rebuild lands RESULT, the second is held until `release`, later ones hang. */
function lateReplyBackend() {
  let calls = 0;
  let release!: (v: unknown) => void;
  const chunkFns: ((c: RebuildChunk) => void)[] = [];
  const be = {
    async rebuild(_doc: unknown, _tol: unknown, onId?: (id: string) => void) {
      calls++;
      onId?.(`rq-${calls}`);
      if (calls === 1) return { ok: true as const, result: RESULT };
      if (calls === 2)
        return new Promise((r) => {
          release = r;
        });
      return new Promise(() => {});
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    onProgress() {
      return () => {};
    },
    onRebuildChunk(fn: (c: RebuildChunk) => void) {
      chunkFns.push(fn);
      return () => {};
    },
    async cancel() {
      return true;
    },
  } as unknown as GeometryBackend;
  // Installments of the held second rebuild, the one that was on the wire when the document was replaced.
  const chunk = (done: number) => {
    const c = {
      id: "rq-2",
      phase: "bodies",
      result: RESULT,
      manifest: [],
      bodies: [],
      edgesByBody: new Map(),
      triRange: { triStart: 0, triEnd: 0 },
      bbox: RESULT.bbox,
      done,
      total: 3,
    } as RebuildChunk;
    chunkFns.forEach((fn) => fn(c));
  };
  return { be, chunk, release: (v: unknown) => release(v) };
}
