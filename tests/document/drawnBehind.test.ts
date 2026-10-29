// The model on screen is behind its document only when a feature it was built from is gone: a delete or a replace
// load. An ordinary edit's model is still the user's model, drawn and pickable until the next one lands.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, RebuildReply, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { box } from "./storeKit";

vi.stubGlobal("window", globalThis);

const result = (): RebuildResult => ({
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: [{ id: "body1", name: "b", faceStart: 0, faceCount: 1 }],
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function rig() {
  const jobs: ((r: RebuildReply) => void)[] = [];
  const be = {
    rebuild(_doc: CadDocument, _tol?: number, onId?: (id: string) => void) {
      onId?.(`r${jobs.length}`);
      return new Promise<RebuildReply>((settle) => jobs.push(settle));
    },
    async cancel() {
      return true;
    },
    async init() {},
    onStatus: () => () => {},
    connected: true,
  } as unknown as GeometryBackend;
  const store = new DocumentStore(be, { parameters: {}, features: [box("a", 10), box("b", 20)] });
  // Waits for the rebuild request itself, ten zero ticks raced the store's 120 ms rebuild debounce on a loaded CI runner.
  const sent = () => vi.waitFor(() => expect(jobs.length).toBeGreaterThan(0), { timeout: 5000 });
  const land = async (expectJob = true) => {
    await (expectJob ? sent() : flush());
    jobs.splice(0).forEach((s) => s({ ok: true, result: result() }));
    await flush();
  };
  return { store, land, sent };
}

describe("a drawn model behind its document", () => {
  it("is behind after a delete or a replace load until its build lands, never after an edit", async () => {
    const { store, land, sent } = rig();
    await land(false);
    const first = store.drawnBehind;
    store.updateFeature("a", { length: 12 } as never);
    await sent();
    const edited = { building: store.buildState.building, behind: store.drawnBehind };
    await land();
    store.removeFeature("b");
    await sent();
    const deleted = { building: store.buildState.building, behind: store.drawnBehind };
    await land();
    const afterDelete = store.drawnBehind;
    store.loadDocument({ parameters: {}, features: [box("a", 30)] }, { replace: true });
    const replaced = store.drawnBehind;
    await land();
    expect({ first, edited, deleted, afterDelete, replaced, landed: store.drawnBehind }).toEqual({
      first: false,
      edited: { building: true, behind: false },
      deleted: { building: true, behind: true },
      afterDelete: false,
      replaced: true,
      landed: false,
    });
  });

  it("counts each load that drops the model, a replacing one too, and no edit", async () => {
    const { store, land } = rig();
    await land(false);
    const counts = [store.loadCount];
    store.updateFeature("a", { length: 12.5 } as never);
    await land();
    counts.push(store.loadCount);
    store.loadDocument({ parameters: {}, features: [box("a", 30)] }, { replace: true });
    counts.push(store.loadCount);
    store.loadDocument({ parameters: {}, features: [box("c", 7)] }, { replace: true });
    counts.push(store.loadCount);
    store.loadDocument({ parameters: {}, features: [box("d", 41)] });
    counts.push(store.loadCount);
    await land();
    const c0 = counts[0]!;
    expect(counts).toEqual([c0, c0, c0 + 1, c0 + 2, c0 + 3]);
  });
});
