// Which features make an eye toggle a rebuild: the ones that act on whatever
// is shown when they build. The engine keys its cache by the same rule.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readsBodyVisibility } from "../../src/document/readsVisibility";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildReply } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const f = (o: Record<string, unknown>) => o as unknown as Feature;

describe("readsBodyVisibility", () => {
  it("is true for a join, cut or intersect that names no target", () => {
    expect(readsBodyVisibility(f({ id: "r", type: "revolve", operation: "cut" }))).toBe(true);
    expect(readsBodyVisibility(f({ id: "l", type: "loft", operation: "join" }))).toBe(true);
    expect(readsBodyVisibility(f({ id: "b", type: "box", operation: "intersect", targets: [] }))).toBe(true);
    expect(readsBodyVisibility(f({ id: "p", type: "press-pull" }))).toBe(true);
  });

  it("is false once the feature names its targets, or makes a new body", () => {
    expect(readsBodyVisibility(f({ id: "r", type: "revolve", operation: "cut", targets: ["body1"] }))).toBe(false);
    expect(readsBodyVisibility(f({ id: "p", type: "press-pull", targets: ["body1"] }))).toBe(false);
    expect(readsBodyVisibility(f({ id: "l", type: "loft", operation: "new" }))).toBe(false);
    expect(readsBodyVisibility(f({ id: "s", type: "sketch" }))).toBe(false);
    expect(readsBodyVisibility(f({ id: "c", type: "fillet" }))).toBe(false);
  });

  it("follows an extrude's own recorded set, not its operation", () => {
    expect(readsBodyVisibility(f({ id: "e", type: "extrude", operation: "cut", hiddenBodies: [] }))).toBe(false);
    expect(readsBodyVisibility(f({ id: "e", type: "extrude", operation: "cut", hiddenBodies: ["body2"] }))).toBe(false);
    expect(readsBodyVisibility(f({ id: "e", type: "extrude", operation: "cut" }))).toBe(true);
    expect(readsBodyVisibility(f({ id: "e", type: "extrude", operation: "cut", hiddenBodies: null }))).toBe(true);
  });

  it("is always true for a plugin's feature, which picks its own targets", () => {
    expect(readsBodyVisibility(f({ id: "x", type: "acme.gear", operation: "new", targets: ["body1"] }))).toBe(true);
  });
});

describe("an eye toggle", () => {
  let rebuilds: CadDocument[];
  const backend = () => ({
    async rebuild(doc: CadDocument): Promise<RebuildReply> {
      rebuilds.push(doc);
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  }) as unknown as GeometryBackend;
  const base = [
    { id: "s1", type: "sketch", plane: "XY", entities: [] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new", hiddenBodies: [] },
  ];
  const storeOf = async (extra: Record<string, unknown>[]) => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [...base, ...extra] as unknown as Feature[] });
    await vi.runAllTimersAsync();
    rebuilds = [];
    return store;
  };
  beforeEach(() => { vi.useFakeTimers(); rebuilds = []; });
  afterEach(() => void vi.useRealTimers());

  it("is display only when nothing reads the eye states", async () => {
    const store = await storeOf([{ id: "r1", type: "revolve", sketch: "s1", operation: "cut", targets: ["body1"] }]);
    store.setBodyVisibility("body1", false);
    await vi.runAllTimersAsync();
    expect(rebuilds).toHaveLength(0);
  });

  it("rebuilds when a cut acts on whatever is shown, and again on undo and redo", async () => {
    const store = await storeOf([{ id: "r1", type: "revolve", sketch: "s1", operation: "cut" }]);
    store.setBodyVisibility("body1", false);
    await vi.runAllTimersAsync();
    expect(rebuilds).toHaveLength(1);
    expect(rebuilds[0]!.bodyVisibility).toEqual({ body1: false });

    store.undo();
    await vi.runAllTimersAsync();
    expect(rebuilds).toHaveLength(2);
    expect(rebuilds[1]!.bodyVisibility ?? {}).toEqual({});

    store.redo();
    await vi.runAllTimersAsync();
    expect(rebuilds).toHaveLength(3);
    expect(rebuilds[2]!.bodyVisibility).toEqual({ body1: false });
  });
});
