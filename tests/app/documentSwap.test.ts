// File → New after a big import left the old model drawn and pickable until the
// engine answered the empty document's rebuild, most of a second at 1,000 bodies.
// The view has to let go in the same call as the replacement, in this order.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { wireDocumentSwap } from "../../src/app/documentSwap";
import type { CadDocument, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const RESULT: RebuildResult = {
  mesh: { positions: [0, 0, 0], indices: [0], faceIds: [0] },
  edges: [],
  bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  bodies: [{ id: "b1", name: "Body1", faceStart: 0, faceCount: 1 }],
};
const DOC = { parameters: {}, features: [{ id: "f1", type: "sketch", plane: "XY", entities: [] }] } as unknown as CadDocument;

/** Lands RESULT once, then never answers again, like an engine still busy freeing the old build. */
function slowEngine() {
  let calls = 0;
  return {
    async rebuild() {
      return ++calls === 1 ? { ok: true as const, result: RESULT } : new Promise<never>(() => {});
    },
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
  } as unknown as GeometryBackend;
}

function harness() {
  const store = new DocumentStore(slowEngine(), DOC);
  const calls: string[] = [];
  const sketch = { active: true, cancel: () => calls.push("sketch.cancel") };
  wireDocumentSwap(store, {
    sketch,
    dropBodyGizmo: () => calls.push("dropBodyGizmo"),
    viewport: {
      clearSelection: () => calls.push("clearSelection"),
      setSelectedBodies: () => calls.push("setSelectedBodies"),
      clearModel: () => calls.push("clearModel"),
    },
  });
  store.onBuild((s) => { if (!s.building) calls.push(`build:${s.result ? "old" : "none"}`); });
  return { store, calls };
}

describe("New and Open clear the view at once", () => {
  for (const how of ["New", "Open"] as const) {
    it(`clears the model in the same call as ${how}, before any build tick and without the engine`, async () => {
      const { store, calls } = harness();
      await store.rebuildNow();
      calls.length = 0;
      if (how === "New") store.newDocument();
      else store.load(JSON.stringify({ parameters: {}, features: [] }));
      expect(calls.slice(0, 5)).toEqual([
        "sketch.cancel", "dropBodyGizmo", "clearSelection", "setSelectedBodies", "clearModel",
      ]);
      expect(calls).not.toContain("build:old");
    });
  }

  it("keeps the model for a replace, which is the same document", async () => {
    const { store, calls } = harness();
    await store.rebuildNow();
    calls.length = 0;
    store.load(JSON.stringify(DOC), { replace: true });
    expect(calls).not.toContain("clearModel");
  });
});
