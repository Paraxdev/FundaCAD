import { describe, it, expect, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { ensureBodyIds, forgetFeature, joinSignature, joinWentStale } from "../../src/document/bodyIds";
import { appHost } from "../../src/plugins/broker/appHost";
import { testHost } from "../../src/plugins/broker/testing";
import { createBroker } from "../../src/plugins/broker/broker";
import { allOpGrants } from "../../src/plugins/broker/ops";
import RAW from "../vectors/join_edits.json";
import HANDED from "../vectors/handed_over.json";

interface JoinVectors {
  stale: { name: string; before: Feature | null; after: Feature; stale: boolean }[];
  forget: { feature: string; map: Record<string, string>; left: Record<string, string> };
}
const JOINS = RAW as unknown as JoinVectors;

interface HandedVectors {
  cases: { name: string; document: { bodyIds?: unknown }; bodyIds: Record<string, string>; filled: boolean }[];
}
const HANDED_OVER = HANDED as unknown as HandedVectors;

vi.stubGlobal("window", globalThis);

const box = (id: string) => ({ id, type: "box", length: 1, width: 1, height: 1 }) as unknown as Feature;

function backend(bodyIds: () => Record<string, string> | undefined) {
  const sent: CadDocument[] = [];
  const be = {
    async rebuild(doc: CadDocument) {
      sent.push(doc);
      const result: RebuildResult = { mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: { min: [0, 0, 0], max: [0, 0, 0] } };
      const ids = bodyIds();
      return { ok: true as const, result: ids ? { ...result, bodyIds: ids } : result };
    },
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
  } as unknown as GeometryBackend;
  return { be, sent };
}

describe("the body id map", () => {
  it("is kept from a build without an undo step or an unsaved mark, sent with the next build, and saved", async () => {
    const h = backend(() => ({ "a:0": "body1" }));
    const store = new DocumentStore(h.be, { parameters: {}, features: [box("a")], bodyIds: {} });
    await store.rebuildNow();
    expect(store.document.bodyIds).toEqual({ "a:0": "body1" });
    expect(store.canUndo).toBe(false);
    expect(store.dirty).toBe(false);
    await store.rebuildNow();
    expect(h.sent.at(-1)!.bodyIds).toEqual({ "a:0": "body1" });
    expect(JSON.parse(store.toJSON()).bodyIds).toEqual({ "a:0": "body1" });
  });

  it("stays absent on an old file until a build reports one, and a new document starts with one", async () => {
    const h = backend(() => undefined);
    const store = new DocumentStore(h.be, { parameters: {}, features: [] });
    store.load(JSON.stringify({ parameters: {}, features: [box("a")] }));
    await store.rebuildNow();
    expect(h.sent.at(-1)!.bodyIds).toBeUndefined();
    store.newDocument();
    await store.rebuildNow();
    expect(h.sent.at(-1)!.bodyIds).toEqual({});
  });

  it("is not written onto a different document than the one that was built", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const be = {
      async rebuild(doc: CadDocument) {
        await gate;
        const bodyIds = { ...doc.bodyIds, [`${doc.features[0]!.id}:0`]: "body1" };
        return { ok: true as const, result: { mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: { min: [0, 0, 0], max: [0, 0, 0] }, bodyIds } };
      },
      async init() {},
      onStatus() { return () => {}; },
      onProgress() { return () => {}; },
      async cancel() { return true; },
    } as unknown as GeometryBackend;
    const store = new DocumentStore(be, { parameters: {}, features: [box("a")], bodyIds: {} });
    const building = store.rebuildNow();
    store.load(JSON.stringify({ parameters: {}, features: [box("other")] }));
    release();
    await building;
    expect(store.document.bodyIds).toEqual({ "other:0": "body1" });
  });
});

describe("a feature that becomes a join (vectors shared with fundacad-core)", () => {
  it("is stale exactly when the engine's twin says so", () => {
    for (const c of JOINS.stale) {
      const before = c.before ? joinSignature(c.before) : undefined;
      expect(joinWentStale(before, c.after), c.name).toBe(c.stale);
    }
  });

  it("forgets only that feature's keys", () => {
    const map = { ...JOINS.forget.map };
    expect(forgetFeature(map, JOINS.forget.feature)).toBe(true);
    expect(map).toEqual(JOINS.forget.left);
    expect(forgetFeature(map, JOINS.forget.feature)).toBe(false);
  });

  it("loses the id it had as a new body when an edit turns it into a join", async () => {
    const h = backend(() => undefined);
    const rv = { id: "rv", type: "revolve", sketch: "s", axis: "Z", angle: 360, operation: "new" } as unknown as Feature;
    const store = new DocumentStore(h.be, { parameters: {}, features: [box("a"), rv], bodyIds: { "a:0": "body1", "rv:0": "body3" } });
    store.updateFeature("rv", { operation: "join", targets: ["body1"] } as Partial<Feature>);
    expect(store.document.bodyIds).toEqual({ "a:0": "body1" });
    store.updateFeature("rv", { angle: 180 } as Partial<Feature>);
    store.document.bodyIds!["rv:0"] = "body1";
    store.updateFeature("rv", { angle: 90 } as Partial<Feature>);
    expect(store.document.bodyIds).toEqual({ "a:0": "body1", "rv:0": "body1" });
  });
});

describe("a document handed over whole (vectors shared with fundacad-core)", () => {
  it("gets the map the engine's twin gives it", () => {
    for (const c of HANDED_OVER.cases) {
      const doc = structuredClone(c.document);
      expect(ensureBodyIds(doc), c.name).toBe(c.filled);
      expect(doc.bodyIds, c.name).toEqual(c.bodyIds);
    }
  });

  it("is built with a map through a plugin's doc_set, and keeps the one doc_get handed out", async () => {
    const h = backend(() => undefined);
    const store = new DocumentStore(h.be, { parameters: {}, features: [], bodyIds: {} });
    const b = createBroker({ plugin: "under-test", grants: allOpGrants(), host: appHost({ store }) });
    await b.call("doc_set", { document: { parameters: {}, features: [box("a")] } });
    await store.rebuildNow();
    expect(h.sent.at(-1)!.bodyIds).toEqual({});

    store.document.bodyIds = { "a:0": "body1" };
    const got = await b.call("doc_get");
    await b.call("doc_set", { document: got.ok ? got.value : null });
    await store.rebuildNow();
    expect(h.sent.at(-1)!.bodyIds).toEqual({ "a:0": "body1" });
  });

  it("gets the same map from the test double", async () => {
    const fake = testHost();
    await createBroker({ plugin: "under-test", grants: allOpGrants(), host: fake }).call("doc_set", {
      document: { parameters: {}, features: [box("a")] },
    });
    expect(fake.document().bodyIds).toEqual({});
  });

  it("stays unmapped when opened as a file, which may predate the map", async () => {
    const h = backend(() => undefined);
    const store = new DocumentStore(h.be, { parameters: {}, features: [] });
    store.load(JSON.stringify({ version: 9, parameters: {}, features: [box("a")] }));
    await store.rebuildNow();
    expect(h.sent.at(-1)!.bodyIds).toBeUndefined();
  });
});
