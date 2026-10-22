// Deleting every History entry while an SV08 import held the engine left the deleted body drawn and pickable: the
// empty document's build queued behind the import. With nothing left to build, the store settles empty itself.
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

function heldBackend() {
  const jobs: { id: string; features: string[]; settle: (r: RebuildReply) => void }[] = [];
  const cancels: string[] = [];
  let n = 0;
  const be = {
    rebuild(doc: CadDocument, _tol?: number, onId?: (id: string) => void) {
      const id = `r${++n}`;
      onId?.(id);
      return new Promise<RebuildReply>((settle) => jobs.push({ id, features: doc.features.map((f) => f.id), settle }));
    },
    async cancel(target?: string, opts?: { soft?: boolean }) {
      cancels.push(`${target}${opts?.soft ? ":soft" : ""}`);
      return true;
    },
    softCancel: true,
    async init() {},
    onStatus: () => () => {},
    connected: true,
  } as unknown as GeometryBackend;
  return { be, jobs, cancels };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function heldImport(store: DocumentStore) {
  let finish!: () => void;
  const done = store.runBusy(
    "Importing sv08.step",
    (onStarted) => {
      onStarted("rq-import");
      return new Promise<void>((r) => (finish = r));
    },
    { holdHistory: true },
  );
  return { done, finish: () => finish() };
}

const view = (store: DocumentStore) => ({
  features: store.document.features.map((f) => f.id),
  bodies: store.buildState.result?.bodies?.map((b) => b.id) ?? null,
  building: store.buildState.building,
});

async function built(features: string[]) {
  const { be, jobs, cancels } = heldBackend();
  const store = new DocumentStore(be, { parameters: {}, features: [] });
  await flush();
  jobs.splice(0).forEach((j) => j.settle({ ok: true, result: result("seed") }));
  store.load(JSON.stringify({ parameters: {}, features: features.map((id, i) => box(id, 10 + i)) }));
  await flush();
  jobs.splice(0).forEach((j) => j.settle({ ok: true, result: result("fillet") }));
  await flush();
  return { store, jobs, cancels };
}

// Document C after the first: its own build goes to the engine and lands, nothing of the earlier one comes back.
async function secondDocument(store: DocumentStore, jobs: { features: string[]; settle: (r: RebuildReply) => void }[]) {
  const before = jobs.length;
  store.load(JSON.stringify({ parameters: {}, features: [box("c1", 7.25)] }));
  await flush();
  jobs.slice(before).forEach((j) => j.settle({ ok: true, result: result("c") }));
  await flush();
  return { sent: jobs.slice(before).map((j) => j.features), ...view(store) };
}

describe("a document left with nothing to build", () => {
  it("settles empty at once while an import runs, without asking the engine", async () => {
    const { store, jobs, cancels } = await built(["fillet"]);
    const imp = heldImport(store);
    await flush();
    store.removeFeature("fillet");
    await store.whenBuilt();
    const atOnce = { ...view(store), sent: jobs.length, cancels: [...cancels] };
    imp.finish();
    await imp.done;
    await flush();
    expect({ atOnce, afterImport: view(store), c: await secondDocument(store, jobs) }).toEqual({
      atOnce: { features: [], bodies: [], building: false, sent: 0, cancels: [] },
      afterImport: { features: [], bodies: [], building: false },
      c: { sent: [["c1"]], features: ["c1"], bodies: ["c"], building: false },
    });
  });

  it("drops an older build still on its way and stops it, its late reply changes nothing", async () => {
    const { store, jobs, cancels } = await built(["fillet", "remove"]);
    const imp = heldImport(store);
    store.removeFeature("remove");
    void store.whenBuilt();
    await flush();
    const held = jobs.at(-1)!;
    store.removeFeature("fillet");
    await flush();
    const atOnce = { ...view(store), held: held.features, cancels: [...cancels] };
    held.settle({ ok: true, result: result("ghost") });
    imp.finish();
    await imp.done;
    await flush();
    expect({ atOnce, late: view(store), c: await secondDocument(store, jobs) }).toEqual({
      atOnce: { features: [], bodies: [], building: false, held: ["fillet"], cancels: [`${held.id}:soft`] },
      late: { features: [], bodies: [], building: false },
      c: { sent: [["c1"]], features: ["c1"], bodies: ["c"], building: false },
    });
  });

  it("asks the engine as before when nothing of the document is running", async () => {
    const { store, jobs } = await built(["fillet"]);
    store.removeFeature("fillet");
    void store.whenBuilt();
    await flush();
    const sent = jobs.map((j) => j.features);
    const waiting = view(store);
    jobs
      .at(-1)!
      .settle({ ok: true, result: { ...result("x"), mesh: { positions: [], indices: [], faceIds: [] }, bodies: [] } });
    await flush();
    expect({ sent, waiting, settled: view(store), c: await secondDocument(store, jobs) }).toEqual({
      sent: [[]],
      waiting: { features: [], bodies: ["fillet"], building: true },
      settled: { features: [], bodies: [], building: false },
      c: { sent: [["c1"]], features: ["c1"], bodies: ["c"], building: false },
    });
  });
});
