// Leaving a tool never waits on the kernel (field report 2026-09-18, Linux alpha:
// "until that's done you cannot exit"). A backend whose rebuilds settle only
// when the test says so stands in for a fillet that takes seconds.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildReply, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const result = (tag: string): RebuildResult => ({
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: [{ id: tag, name: tag, faceStart: 0, faceCount: 1 }],
});

interface Job {
  id: string;
  doc: CadDocument;
  settle: (r: RebuildReply) => void;
}

function slowBackend(softCancel = true) {
  const jobs: Job[] = [];
  const cancels: { target: string | undefined; soft: boolean | undefined }[] = [];
  let n = 0;
  const be = {
    softCancel,
    rebuild(doc: CadDocument, _tol?: number, onId?: (id: string) => void) {
      const id = `r${++n}`;
      onId?.(id);
      return new Promise<RebuildReply>((settle) => jobs.push({ id, doc, settle }));
    },
    async cancel(target?: string, opts?: { soft?: boolean }) {
      cancels.push({ target, soft: opts?.soft });
      return true;
    },
    async init() {},
    onStatus() { return () => {}; },
  } as unknown as GeometryBackend;
  return { be, jobs, cancels };
}

const DOC: CadDocument = {
  parameters: {},
  features: [
    { id: "s1", type: "sketch", plane: "XY", entities: [] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" },
    { id: "f1", type: "fillet", edges: { kind: "edge", by: "nearest", point: [0, 0, 0] }, radius: 2 },
  ] as Feature[],
};

const fillet = (radius: number) =>
  ({ id: "f1", type: "fillet", edges: { kind: "edge", by: "nearest", point: [0, 0, 0] }, radius }) as Feature;

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const radiusSent = (j: Job | undefined) =>
  (j?.doc.features.find((f) => f.id === "f1") as { radius?: number } | undefined)?.radius;

/** A store showing the committed model, with the fillet open for edit. */
async function editing(softCancel = true) {
  const h = slowBackend(softCancel);
  const store = new DocumentStore(h.be, DOC);
  const first = store.rebuildNow();
  h.jobs[0]!.settle({ ok: true, result: result("committed") });
  await first;
  store.beginEditPreview("f1", fillet(2));
  await flush();
  h.jobs[1]!.settle({ ok: true, result: result("rolled") });
  await flush();
  return { store, ...h };
}

describe("leaving a tool while its rebuild runs", () => {
  it("shows the committed model again at once when the edit is cancelled", async () => {
    const { store, jobs } = await editing();
    store.setEditPreview(fillet(38));
    await flush();
    expect(store.buildState.building).toBe(true);
    store.endEditPreview();
    await flush();
    expect(store.buildState.building).toBe(false);
    expect(store.buildState.result?.bodies?.[0]?.id).toBe("committed");
    // nothing new was asked of the engine to get there
    expect(jobs).toHaveLength(3);
  });

  it("never publishes the cancelled preview when its reply lands late", async () => {
    const { store, jobs } = await editing();
    store.setEditPreview(fillet(38));
    await flush();
    store.endEditPreview();
    await flush();
    jobs[2]!.settle({ ok: true, result: result("preview38") });
    await flush();
    expect(store.buildState.result?.bodies?.[0]?.id).toBe("committed");
  });

  it("soft cancels the preview it abandons", async () => {
    const { store, cancels } = await editing();
    store.setEditPreview(fillet(38));
    await flush();
    store.endEditPreview();
    await flush();
    expect(cancels).toEqual([{ target: "r3", soft: true }]);
  });

  it("leaves a superseded job alone where the engine can only stop it by restarting", async () => {
    const { store, cancels } = await editing(false);
    store.setEditPreview(fillet(38));
    await flush();
    store.endEditPreview();
    await flush();
    expect(cancels).toEqual([]);
  });

  it("commits without waiting, building the committed document next", async () => {
    const { store, jobs, cancels } = await editing();
    store.setEditPreview(fillet(38));
    await flush();
    store.endEditPreview(false);
    store.replaceFeature("f1", fillet(38));
    await flush();
    expect(cancels).toEqual([{ target: "r3", soft: true }]);
    jobs[2]!.settle({ ok: false, cancelled: true, error: { message: "cancelled" } });
    await flush();
    expect(jobs).toHaveLength(4);
    expect(jobs[3]!.doc.features.map((f) => f.id)).toEqual(["s1", "e1", "f1"]);
    expect(radiusSent(jobs[3])).toBe(38);
    expect(store.buildState.errorMessage).toBeNull();
  });
});

describe("a live drag", () => {
  it("rebuilds only the latest value once the running one returns", async () => {
    const { store, jobs, cancels } = await editing();
    for (const r of [30, 31, 32, 33, 34]) store.setEditPreview(fillet(r));
    await flush();
    // 30 went out, 31 to 34 only replaced each other in the queue
    expect(jobs).toHaveLength(3);
    expect(radiusSent(jobs[2])).toBe(30);
    expect(cancels).toEqual([{ target: "r3", soft: true }]);
    jobs[2]!.settle({ ok: false, cancelled: true, error: { message: "cancelled" } });
    await flush();
    expect(jobs).toHaveLength(4);
    expect(radiusSent(jobs[3])).toBe(34);
    // the stopped draft is never reported as a failure
    expect(store.buildState.errorMessage).toBeNull();
  });
});

describe("a commit the kernel had not answered for", () => {
  it("is undone when the rebuild refuses it", async () => {
    const { store, jobs } = await editing();
    const warnings: string[] = [];
    store.onWarning = (m) => warnings.push(m);
    store.endEditPreview(false);
    store.replaceFeature("f1", fillet(60));
    store.verifyCommit("f1", "Fillet 60 mm");
    await flush();
    const refused = result("partial");
    refused.featureErrors = [{ feature_id: "f1", message: "too large" }];
    jobs[2]!.settle({ ok: true, result: refused });
    await flush();
    expect((store.document.features.find((f) => f.id === "f1") as { radius: number }).radius).toBe(2);
    expect(store.buildState.result?.bodies?.[0]?.id).toBe("committed");
    expect(warnings).toEqual(["Fillet 60 mm was refused, nothing changed: too large"]);
    expect(store.canRedo).toBe(true);
  });

  it("stays when the rebuild builds it", async () => {
    const { store, jobs } = await editing();
    store.endEditPreview(false);
    store.replaceFeature("f1", fillet(20));
    store.verifyCommit("f1", "Fillet 20 mm");
    await flush();
    jobs[2]!.settle({ ok: true, result: result("r20") });
    await flush();
    expect((store.document.features.find((f) => f.id === "f1") as { radius: number }).radius).toBe(20);
    expect(store.buildState.result?.bodies?.[0]?.id).toBe("r20");
  });
});
