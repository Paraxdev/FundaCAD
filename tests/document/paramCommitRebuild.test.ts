// A parameter typed into the Parameters list is one discrete edit: it rebuilds
// at once, and it ships only the features it changed.
import { describe, it, expect } from "vitest";
import { DocumentStore, withoutDisplayName } from "../../src/document/store";
import type { CadDocument, Feature, RebuildReply, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const okReply: RebuildReply = {
  ok: true,
  result: {
    mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) },
    edges: [],
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  } as RebuildResult,
};

function backend(calls: CadDocument[]): GeometryBackend {
  return {
    rebuild: async (doc: CadDocument) => (calls.push(doc), okReply),
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
}

const doc = (): CadDocument => ({
  parameters: { r: 4, d1: 4 },
  paramDefs: {
    r: { expr: "4", value: 4, unit: "mm" },
    d1: { expr: "r", value: 4, unit: "mm", target: { kind: "feature", feature: "b", field: "length" } },
  },
  features: [
    { id: "a", type: "box", name: "First", length: 10, width: 10, height: 10 },
    { id: "b", type: "box", name: "Second", length: 4, width: 10, height: 10 },
  ] as Feature[],
});

// Zero-delay ticks only: a rebuild still sitting on the 120 ms debounce never lands.
const ticks = () => new Promise<void>((res) => {
  let i = 0;
  const tick = () => (++i > 10 ? res() : void setTimeout(tick, 0));
  tick();
});

describe("parameter commit rebuild", () => {
  it("rebuilds without the debounce and keeps untouched features the same objects", async () => {
    const calls: CadDocument[] = [];
    const store = new DocumentStore(backend(calls), doc());
    await store.rebuildNow();
    const before = calls.length;
    const first = calls.at(-1)!;
    expect(store.setParamExpr("r", "6")).toBeNull();
    await ticks();
    expect(calls.length).toBe(before + 1);
    const sent = calls.at(-1)!;
    expect(sent.features[0]).toBe(first.features[0]);
    expect(sent.features[1]).not.toBe(first.features[1]);
    expect((sent.features[1] as { length: number }).length).toBe(6);
  });

  it("rebuilds once for a burst of parameter commits", async () => {
    const calls: CadDocument[] = [];
    const store = new DocumentStore(backend(calls), doc());
    await store.rebuildNow();
    const before = calls.length;
    store.setParamExpr("r", "5");
    store.setParamExpr("r", "7");
    await ticks();
    expect(calls.length).toBe(before + 1);
    expect((calls.at(-1)!.features[1] as { length: number }).length).toBe(7);
  });

  it("strips a step's name to the same object every time", () => {
    const named = { id: "f1", type: "box", name: "Base" } as unknown as Feature;
    expect(withoutDisplayName(named)).toBe(withoutDisplayName(named));
  });
});
