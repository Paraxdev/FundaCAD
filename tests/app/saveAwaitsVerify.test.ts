import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildReply, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const host = vi.hoisted(() => ({ invoked: [] as { cmd: string; args: Record<string, unknown> }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    host.invoked.push({ cmd, args });
    return undefined;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: async () => {}, save: async () => "D:/parts/a.funda" }));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));
vi.mock("../../src/io/recentFiles", () => ({ noteRecent() {}, forgetRecent() {}, getRecentFiles: () => [] }));
vi.mock("../../src/ui/choice", () => ({ choose: async () => "save" }));

const { saveWork, saveWorkAs, SAVE_VERIFY_CAP_MS } = await import("../../src/app/documentActions");
const { saveFirst } = await import("../../src/app/unsavedGuard");

const result = (tag: string): RebuildResult => ({
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: [{ id: tag, name: tag, faceStart: 0, faceCount: 1 }],
});
const fillet = (radius: number) =>
  ({ id: "f1", type: "fillet", edges: { kind: "edge", by: "nearest", point: [3, 7, 2] }, radius }) as Feature;
const DOC: CadDocument = {
  parameters: {},
  features: [
    { id: "s1", type: "sketch", plane: "XY", entities: [] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" },
    fillet(2.5),
  ] as Feature[],
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function setup() {
  const jobs: ((r: RebuildReply) => void)[] = [];
  const be = {
    softCancel: true,
    rebuild(_d: CadDocument, _t?: number, onId?: (id: string) => void) {
      onId?.(`r${jobs.length}`);
      return new Promise<RebuildReply>((s) => jobs.push(s));
    },
    async cancel() {
      return true;
    },
    async init() {},
    onStatus() {
      return () => {};
    },
  } as unknown as GeometryBackend;
  const store = new DocumentStore(be, DOC);
  const first = store.rebuildNow();
  jobs[0]!({ ok: true, result: result("committed") });
  await first;
  store.markSaved("D:/parts/a.funda");
  const commit = (r: number) => {
    store.replaceFeature("f1", fillet(r));
    store.verifyCommit("f1", `Fillet ${r} mm`);
  };
  const held = {
    pending: true,
    onHeldChange: () => () => {},
    confirmHeld() {
      if (!this.pending) return;
      this.pending = false;
      commit(60.5);
    },
  };
  const answer = (refuse: boolean) => {
    const r = result("verified");
    if (refuse) r.featureErrors = [{ feature_id: "f1", message: "too large" }];
    jobs[jobs.length - 1]!({ ok: true, result: r });
  };
  return {
    store,
    jobs,
    held,
    commit,
    answer,
    e: { store, tools: { edgeFeature: held } } as never,
    plain: { store, tools: {} } as never,
  };
}

const saves = () => host.invoked.filter((c) => c.cmd === "container_save");
const written = () =>
  saves().map(
    (c) => JSON.parse(String(c.args.documentJson)).features.find((f: { id: string }) => f.id === "f1").radius,
  );
const radius = (s: DocumentStore) => (s.document.features.find((f) => f.id === "f1") as { radius: number }).radius;

describe("a save waits for the kernel's verdict on a commit", () => {
  beforeEach(() => {
    host.invoked = [];
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  });
  afterEach(() => vi.useRealTimers());

  const routes = {
    Save: (e: never) => saveWork(e),
    "Save on close": async (e: never) => {
      expect(await saveFirst(e, "Save?", "lose")).toBe(true);
    },
  };

  for (const [via, run] of Object.entries(routes)) {
    it(`${via}: a held edit refused after a delay is not written`, async () => {
      const { store, answer, e } = await setup();
      const saving = run(e);
      await flush();
      expect(saves()).toEqual([]);
      await new Promise((r) => setTimeout(r, 30));
      expect(saves()).toEqual([]);
      answer(true);
      await saving;
      expect(written()).toEqual([2.5]);
      expect(radius(store)).toBe(2.5);
      expect(store.dirty).toBe(false);
    });

    it(`${via}: a held edit the kernel accepts is written`, async () => {
      const { store, answer, e } = await setup();
      const saving = run(e);
      await flush();
      expect(saves()).toEqual([]);
      answer(false);
      await saving;
      expect(written()).toEqual([60.5]);
      expect(radius(store)).toBe(60.5);
      expect(store.dirty).toBe(false);
    });
  }

  it("Enter then Save at once, with no held edit left, waits the same", async () => {
    const { store, commit, answer, plain } = await setup();
    commit(41.25);
    const saving = saveWork(plain);
    await flush();
    expect(saves()).toEqual([]);
    answer(true);
    await saving;
    expect(written()).toEqual([2.5]);
    expect(radius(store)).toBe(2.5);
  });

  it("Save As takes the same path", async () => {
    const { answer, e } = await setup();
    const saving = saveWorkAs(e);
    await flush();
    expect(saves()).toEqual([]);
    answer(true);
    await saving;
    expect(written()).toEqual([2.5]);
  });

  it("a verdict that never comes is capped, the save writes the store and a late refusal leaves it dirty", async () => {
    vi.useFakeTimers();
    const { store, answer, e } = await setup();
    const saving = saveWork(e);
    await vi.advanceTimersByTimeAsync(SAVE_VERIFY_CAP_MS - 1);
    expect(saves()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await saving;
    expect(written()).toEqual([60.5]);
    expect(store.dirty).toBe(false);
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(radius(store)).toBe(2.5);
    expect(store.dirty).toBe(true);
  });

  it("with nothing awaiting the kernel the save does not wait", async () => {
    const { store, plain } = await setup();
    store.replaceFeature("f1", fillet(9));
    await saveWork(plain);
    expect(written()).toEqual([9]);
  });

  it("a document opened during the wait is not written under the old path", async () => {
    const { store, e } = await setup();
    const saving = saveWork(e);
    await flush();
    store.newDocument();
    await saving;
    expect(saves()).toEqual([]);
  });
});
