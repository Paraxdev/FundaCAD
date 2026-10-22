// Compute All runs as the document's rebuild: an edit made while it runs is built after it, deleting everything clears
// the view at once, its progress reaches the chip and History lists it with its own Cancel.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, RebuildReply, RebuildResult } from "../../src/types";
import type { GeometryBackend, ProgressListener } from "../../src/geometry/client";
import { box } from "./storeKit";

vi.stubGlobal("window", globalThis);

const result = (tag: string): RebuildResult => ({
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: [{ id: tag, name: tag, faceStart: 0, faceCount: 1 }],
});

function heldBackend() {
  const jobs: { op: string; id: string; features: string[]; settle: (r: RebuildReply) => void }[] = [];
  const cancels: string[] = [];
  const progress: ProgressListener[] = [];
  let n = 0;
  const hold = (op: string) => (doc: CadDocument, _tol?: number, onId?: (id: string) => void) => {
    const id = `${op}${++n}`;
    onId?.(id);
    return new Promise<RebuildReply>((settle) =>
      jobs.push({ op, id, features: doc.features.map((f) => f.id), settle }),
    );
  };
  const be = {
    rebuild: hold("r"),
    computeAll: hold("ca"),
    async cancel(target?: string, opts?: { soft?: boolean }) {
      cancels.push(`${target}${opts?.soft ? ":soft" : ""}`);
      return true;
    },
    onProgress(fn: ProgressListener) {
      progress.push(fn);
      return () => {};
    },
    softCancel: true,
    async init() {},
    onStatus: () => () => {},
    connected: true,
  } as unknown as GeometryBackend;
  const emit = (meshed: number, total: number, id: string) => progress.forEach((fn) => fn(-1, meshed, total, id));
  // Ids count from 1 again once a test's document is built, so each test names its own requests.
  const renumber = () => (n = 0);
  return { be, jobs, cancels, emit, renumber };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// Past the edit debounce, so the rebuild an edit asks for has been asked.
const later = async () => {
  await new Promise((r) => setTimeout(r, 150));
  await flush();
};

const view = (store: DocumentStore) => ({
  features: store.document.features.map((f) => f.id),
  bodies: store.buildState.result?.bodies?.map((b) => b.id) ?? null,
  building: store.buildState.building,
});

async function built(features: string[]) {
  const held = heldBackend();
  const store = new DocumentStore(held.be, { parameters: {}, features: [] });
  await flush();
  held.jobs.splice(0).forEach((j) => j.settle({ ok: true, result: result("seed") }));
  store.load(JSON.stringify({ parameters: {}, features: features.map((id, i) => box(id, 10 + i)) }));
  await flush();
  held.jobs.splice(0).forEach((j) => j.settle({ ok: true, result: result(features.join("+")) }));
  await flush();
  held.renumber();
  return { store, ...held };
}

const sent = (jobs: { id: string; features: string[] }[]) => jobs.map((j) => `${j.id}:${j.features.join(",")}`);

// Document C after the first: its own build goes out and lands, nothing of the earlier one comes back.
async function secondDocument(
  store: DocumentStore,
  jobs: { id: string; features: string[]; settle: (r: RebuildReply) => void }[],
) {
  const before = jobs.length;
  store.load(JSON.stringify({ parameters: {}, features: [box("c1", 7.25)] }));
  await flush();
  const mine = jobs.slice(before);
  mine.forEach((j) => j.settle({ ok: true, result: result("c") }));
  await flush();
  return { sent: sent(mine), ...view(store), ops: store.runningOps.length };
}

describe("Compute All runs as the document's rebuild", () => {
  it("an edit made while it runs is built after it", async () => {
    const { store, jobs, cancels } = await built(["a", "b"]);
    const all = store.computeAllNow();
    await flush();
    store.removeFeature("b");
    await later();
    const whileHeld = { sent: sent(jobs), cancels: [...cancels], ...view(store) };
    jobs[0]!.settle({ ok: true, result: result("a+b") });
    await flush();
    const afterAll = sent(jobs);
    jobs[1]?.settle({ ok: true, result: result("a") });
    await all;
    await flush();
    expect({ whileHeld, afterAll, settled: view(store), c: await secondDocument(store, jobs) }).toEqual({
      whileHeld: { sent: ["ca1:a,b"], cancels: ["ca1:soft"], features: ["a"], bodies: ["a+b"], building: true },
      afterAll: ["ca1:a,b", "r2:a"],
      settled: { features: ["a"], bodies: ["a"], building: false },
      c: { sent: ["r3:c1"], features: ["c1"], bodies: ["c"], building: false, ops: 0 },
    });
  });

  it("deleting every feature while it runs clears the view at once, and its late reply changes nothing", async () => {
    const { store, jobs, cancels } = await built(["a"]);
    const all = store.computeAllNow();
    await flush();
    store.removeFeature("a");
    await later();
    const atOnce = { ...view(store), cancels: [...cancels] };
    jobs[0]!.settle({ ok: true, result: result("ghost") });
    await all;
    await flush();
    expect({ atOnce, late: view(store), sent: sent(jobs), c: await secondDocument(store, jobs) }).toEqual({
      atOnce: { features: [], bodies: [], building: false, cancels: ["ca1:soft"] },
      late: { features: [], bodies: [], building: false },
      sent: ["ca1:a"],
      c: { sent: ["r2:c1"], features: ["c1"], bodies: ["c"], building: false, ops: 0 },
    });
  });

  it("its meshing progress reaches the chip, another request's does not", async () => {
    const { store, jobs, emit } = await built(["a"]);
    const all = store.computeAllNow();
    await flush();
    emit(3, 9, "someone-else");
    const foreign = { meshed: store.buildState.meshed, meshTotal: store.buildState.meshTotal };
    emit(4, 9, jobs[0]!.id);
    const own = { meshed: store.buildState.meshed, meshTotal: store.buildState.meshTotal };
    jobs[0]!.settle({ ok: true, result: result("a") });
    await all;
    await flush();
    expect({ foreign, own, settled: view(store), c: await secondDocument(store, jobs) }).toEqual({
      foreign: { meshed: null, meshTotal: null },
      own: { meshed: 4, meshTotal: 9 },
      settled: { features: ["a"], bodies: ["a"], building: false },
      c: { sent: ["r2:c1"], features: ["c1"], bodies: ["c"], building: false, ops: 0 },
    });
  });

  it("History lists it with a Cancel that stops it and keeps the model it had", async () => {
    const { store, jobs, cancels } = await built(["a"]);
    const all = store.computeAllNow();
    await flush();
    const rows = store.runningOps.map((o) => ({ label: o.label, rebuild: o.rebuild }));
    const key = store.runningOps[0]!.key;
    await store.cancelRunningOp(key);
    jobs[0]!.settle({ ok: false, cancelled: true, error: { message: "cancelled" } });
    await all;
    await flush();
    expect({
      rows,
      cancels: [...cancels],
      sent: sent(jobs),
      after: { ...view(store), ops: store.runningOps.length },
      c: await secondDocument(store, jobs),
    }).toEqual({
      rows: [{ label: "Computing all", rebuild: true }],
      cancels: ["ca1"],
      sent: ["ca1:a"],
      after: { features: ["a"], bodies: ["a"], building: false, ops: 0 },
      c: { sent: ["r2:c1"], features: ["c1"], bodies: ["c"], building: false, ops: 0 },
    });
  });

  it("asked for while a rebuild runs, it runs right after that rebuild", async () => {
    const { store, jobs } = await built(["a"]);
    store.addFeature(box("b", 4));
    await later();
    const all = store.computeAllNow();
    await flush();
    jobs[0]!.settle({ ok: true, result: result("a+b") });
    await flush();
    jobs[1]?.settle({ ok: true, result: result("a+b, all") });
    await all;
    await flush();
    expect({ sent: sent(jobs), settled: view(store), c: await secondDocument(store, jobs) }).toEqual({
      sent: ["r1:a,b", "ca2:a,b"],
      settled: { features: ["a", "b"], bodies: ["a+b, all"], building: false },
      c: { sent: ["r3:c1"], features: ["c1"], bodies: ["c"], building: false, ops: 0 },
    });
  });
});
