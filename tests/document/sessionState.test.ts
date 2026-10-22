// A document's busy ops, undo lock and rebuild loop belong to its session: New or Open while an 11 s fillet rebuild
// and an SV08 import are both held cancels each of them by its own id and starts the next document idle.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, RebuildReply, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { box } from "./storeKit";

vi.stubGlobal("window", globalThis);

const result = (tag: string): RebuildResult => ({
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: [{ id: tag, name: tag, faceStart: 0, faceCount: 1 }],
});

interface Job {
  id: string;
  features: string[];
  settle: (r: RebuildReply) => void;
}

function heldBackend() {
  const jobs: Job[] = [];
  const cancels: string[] = [];
  let n = 0;
  const be = {
    rebuild(doc: CadDocument, _tol?: number, onId?: (id: string) => void) {
      const id = `r${++n}`;
      onId?.(id);
      return new Promise<RebuildReply>((settle) => jobs.push({ id, features: doc.features.map((f) => f.id), settle }));
    },
    async cancel(target?: string) {
      cancels.push(String(target));
      return true;
    },
    async init() {},
    onStatus: () => () => {},
    connected: true,
  } as unknown as GeometryBackend;
  return { be, jobs, cancels };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function heldImport(store: DocumentStore, id: string) {
  let finish!: () => void;
  const done = store.runBusy(
    "Importing sv08.step",
    (onStarted) => {
      onStarted(id);
      return new Promise<void>((r) => (finish = r));
    },
    { holdHistory: true },
  );
  return { done, finish: () => finish() };
}

const docA = JSON.stringify({ parameters: {}, features: [box("fillet", 40.5)] });

function snapshot(store: DocumentStore) {
  return {
    busy: store.busyState.active ? store.busyState.id : null,
    canUndo: store.canUndo,
    features: store.document.features.map((f) => f.id),
    result: store.buildState.result?.bodies?.map((b) => b.id) ?? null,
    building: store.buildState.building,
  };
}

async function swapWhileHeld(order: "rebuildFirst" | "importFirst", swap: (s: DocumentStore) => void) {
  const { be, jobs, cancels } = heldBackend();
  const store = new DocumentStore(be, { parameters: {}, features: [] });
  await flush();
  jobs.splice(0).forEach((j) => j.settle({ ok: true, result: result("seed") }));
  await flush();
  let imp: ReturnType<typeof heldImport>;
  if (order === "rebuildFirst") {
    store.load(docA);
    imp = heldImport(store, "rq-import");
  } else {
    imp = heldImport(store, "rq-import");
    store.addFeature(box("fillet", 40.5));
    void store.whenBuilt();
  }
  await flush();
  const old = jobs.find((j) => j.features[0] === "fillet")!;
  const before = { busy: store.busyState.active, canUndo: store.canUndo, cancels: [...cancels] };
  swap(store);
  const sentRightAway = jobs.filter((j) => j !== old).map((j) => j.features);
  const fresh = jobs.at(-1)!;
  const afterSwap = {
    ...snapshot(store),
    cancels: [...cancels].sort(),
    freshIsRunning: store.busyState.id === fresh.id,
  };
  fresh.settle({ ok: true, result: result("b-empty") });
  await flush();
  const settled = snapshot(store);
  old.settle({ ok: true, result: result("ghost") });
  imp.finish();
  await imp.done;
  await flush();
  const afterOldReplies = snapshot(store);
  store.addFeature(box("b1", 2.5));
  await flush();
  const undoWorks = store.canUndo;
  return { before, sentRightAway, afterSwap, settled, afterOldReplies, undoWorks, oldId: old.id, store, jobs, cancels };
}

const expected = (oldId: string, fresh: string[] = []) => ({
  before: { busy: true, canUndo: false, cancels: [] },
  sentRightAway: [fresh],
  afterSwap: {
    busy: expect.stringMatching(/^r\d+$/),
    freshIsRunning: true,
    canUndo: false,
    features: fresh,
    result: null,
    building: true,
    cancels: [oldId, "rq-import"].sort(),
  },
  settled: { busy: null, canUndo: false, features: fresh, result: ["b-empty"], building: false },
  afterOldReplies: { busy: null, canUndo: false, features: fresh, result: ["b-empty"], building: false },
  undoWorks: true,
});

describe("a document session owns the store's busy ops and rebuild loop", () => {
  for (const order of ["rebuildFirst", "importFirst"] as const) {
    it(`New during a held rebuild and import (${order}) cancels both, starts idle, and old replies change nothing`, async () => {
      const r = await swapWhileHeld(order, (s) => s.newDocument());
      const { store, jobs, cancels, oldId, ...whole } = r;
      expect(whole).toEqual(expected(oldId));

      // A second document after the first: nothing of A or B leaks, and B's own build is cancelled by id.
      // b1's build is still held, so b2 queues behind it in B's own loop.
      const bBuild = jobs.at(-1)!;
      const pending = jobs.length;
      store.addFeature(box("b2", 3.5));
      await flush();
      store.load(JSON.stringify({ parameters: {}, features: [box("c1", 7.25)] }));
      await flush();
      const cBuild = jobs.at(-1)!;
      bBuild.settle({ ok: true, result: result("b-late") });
      cBuild.settle({ ok: true, result: result("c") });
      await flush();
      expect({
        newJobs: jobs.slice(pending).map((j) => j.features),
        lastCancel: cancels.at(-1),
        bBuild: bBuild.features,
        ...snapshot(store),
      }).toEqual({
        newJobs: [["c1"]],
        bBuild: ["b1"],
        lastCancel: bBuild.id,
        busy: null,
        canUndo: false,
        features: ["c1"],
        result: ["c"],
        building: false,
      });
    });
  }

  it("Open during a held rebuild and import behaves the same as New", async () => {
    const r = await swapWhileHeld("rebuildFirst", (s) => s.load(JSON.stringify({ parameters: {}, features: [] })));
    const { store: _s, jobs: _j, cancels: _c, oldId, ...whole } = r;
    expect(whole).toEqual(expected(oldId));
  });

  it("a replace load keeps the session: the held import stays and keeps the undo lock", async () => {
    const { be, jobs } = heldBackend();
    const store = new DocumentStore(be, { parameters: {}, features: [] });
    store.load(docA);
    const kept = store.session;
    const imp = heldImport(store, "rq-import");
    await flush();
    store.load(JSON.stringify({ parameters: {}, features: [box("fillet", 41.5)] }), { replace: true });
    await flush();
    const during = { sameSession: store.session === kept, canUndo: store.canUndo, label: store.busyState.label };
    imp.finish();
    await imp.done;
    for (let seen = 0; seen < jobs.length;) {
      jobs.slice(seen).forEach((j) => j.settle({ ok: true, result: result("a") }));
      seen = jobs.length;
      await flush();
    }
    expect({ during, alive: kept.alive, canUndoAfter: store.canUndo, busyAfter: store.busyState.active }).toEqual({
      during: { sameSession: true, canUndo: false, label: "Importing sv08.step" },
      alive: true,
      canUndoAfter: true,
      busyAfter: false,
    });
  });
});
