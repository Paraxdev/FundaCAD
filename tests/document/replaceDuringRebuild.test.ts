// A replace load (version restore, plugin doc_set, assistant proposal) while a rebuild runs stops only the build on
// the wire: the rebuild that follows is sent and the model on screen is the replacing document's.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, RebuildReply, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { box } from "./storeKit";

vi.stubGlobal("window", globalThis);

const result = (features: string[]): RebuildResult => ({
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: features.map((id) => ({ id: `${id}-body`, name: id, faceStart: 0, faceCount: 1 })),
});

function heldBackend() {
  const jobs: { id: string; features: string[]; settle: (r: RebuildReply) => void }[] = [];
  const cancels: string[] = [];
  let n = 0;
  const be = {
    rebuild(doc: CadDocument, _tol?: number, onId?: (id: string) => void) {
      const id = `r${++n}`;
      try {
        onId?.(id);
      } catch {
        // What the client does for an op cancelled before its request went out.
        return Promise.resolve<RebuildReply>({
          ok: false,
          cancelled: true,
          error: { message: "cancelled before it was sent" },
        });
      }
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
  return { be, jobs, cancels, renumber: () => (n = 0) };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const later = async () => {
  await new Promise((r) => setTimeout(r, 150));
  await flush();
};

const view = (store: DocumentStore) => ({
  features: store.document.features.map((f) => f.id),
  bodies: store.buildState.result?.bodies?.map((b) => b.id) ?? null,
  building: store.buildState.building,
  error: store.buildState.errorMessage,
  ops: store.runningOps.length,
});

// Each held build is answered with the bodies of the document it was sent, as the engine would.
const answer = (job: { features: string[]; settle: (r: RebuildReply) => void }) =>
  job.settle({ ok: true, result: result(job.features) });

type Replace = (store: DocumentStore, features: string[]) => void;

const REPLACES: Record<string, Replace> = {
  "a replace load": (store, features) =>
    store.load(JSON.stringify({ parameters: {}, features: features.map((id) => box(id, 10)) }), { replace: true }),
  "a plugin doc_set or an assistant proposal": (store, features) =>
    store.loadDocument({ parameters: {}, features: features.map((id) => box(id, 10)) }, { replace: true }),
};

async function heldRebuild() {
  const held = heldBackend();
  const store = new DocumentStore(held.be, { parameters: {}, features: [] });
  await flush();
  held.jobs.splice(0).forEach(answer);
  store.load(JSON.stringify({ parameters: {}, features: [box("a", 10), box("b", 12)] }));
  await flush();
  held.jobs.splice(0).forEach(answer);
  await flush();
  held.renumber();
  store.addFeature(box("c", 4));
  await later();
  return { store, ...held };
}

async function secondDocument(store: DocumentStore, jobs: { features: string[]; settle: (r: RebuildReply) => void }[]) {
  const before = jobs.length;
  store.load(JSON.stringify({ parameters: {}, features: [box("d", 7.25)] }));
  await flush();
  const mine = jobs.slice(before);
  mine.forEach(answer);
  await flush();
  return { sent: mine.map((j) => j.features), ...view(store) };
}

describe("a replace load while a rebuild runs", () => {
  for (const [name, replace] of Object.entries(REPLACES)) {
    it(`${name} builds the replacing document and shows only it`, async () => {
      const { store, jobs, cancels } = await heldRebuild();
      const held = jobs[0]!;
      replace(store, ["a"]);
      await flush();
      const stopped = [...cancels];
      held.settle({ ok: false, cancelled: true, error: { message: "cancelled" } });
      await flush();
      const next = jobs.slice(1).map((j) => j.features);
      jobs.slice(1).forEach(answer);
      await flush();
      expect({
        held: held.features,
        stopped,
        next,
        settled: view(store),
        d: await secondDocument(store, jobs),
      }).toEqual({
        held: ["a", "b", "c"],
        stopped: ["r1"],
        next: [["a"]],
        settled: { features: ["a"], bodies: ["a-body"], building: false, error: null, ops: 0 },
        d: { sent: [["d"]], features: ["d"], bodies: ["d-body"], building: false, error: null, ops: 0 },
      });
    });
  }

  it("a version restored while a rebuild runs builds the version", async () => {
    const { store, jobs } = await heldRebuild();
    jobs.splice(0).forEach(answer);
    await flush();
    const v1 = store.saveVersion("one body")!;
    store.addFeature(box("e", 3));
    await later();
    const held = jobs[0]!;
    store.restoreVersion(v1.id);
    await flush();
    held.settle({ ok: false, cancelled: true, error: { message: "cancelled" } });
    await flush();
    const next = jobs.slice(1).map((j) => j.features);
    jobs.slice(1).forEach(answer);
    await flush();
    expect({ held: held.features, next, settled: view(store), d: await secondDocument(store, jobs) }).toEqual({
      held: ["a", "b", "c", "e"],
      next: [["a", "b", "c"]],
      settled: {
        features: ["a", "b", "c"],
        bodies: ["a-body", "b-body", "c-body"],
        building: false,
        error: null,
        ops: 0,
      },
      d: { sent: [["d"]], features: ["d"], bodies: ["d-body"], building: false, error: null, ops: 0 },
    });
  });

  it("a replace load with nothing building sends one build and stops nothing", async () => {
    const { store, jobs, cancels } = await heldRebuild();
    jobs.splice(0).forEach(answer);
    await flush();
    cancels.length = 0;
    store.load(JSON.stringify({ parameters: {}, features: [box("a", 10)] }), { replace: true });
    await flush();
    const next = jobs.map((j) => j.features);
    jobs.forEach(answer);
    await flush();
    expect({ cancels, next, settled: view(store) }).toEqual({
      cancels: [],
      next: [["a"]],
      settled: { features: ["a"], bodies: ["a-body"], building: false, error: null, ops: 0 },
    });
  });
});
