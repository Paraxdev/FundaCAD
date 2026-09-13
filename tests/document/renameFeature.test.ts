import { describe, expect, it, vi } from "vitest";
import { DocumentStore, withoutDisplayName } from "../../src/document/store";
import type { CadDocument, Feature } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const DOC: CadDocument = {
  parameters: {},
  features: [{ id: "f1", type: "box", length: 10, width: 10, height: 10 } as unknown as Feature],
};

vi.stubGlobal("window", globalThis);

function store() {
  const be = {
    async rebuild() { return new Promise<never>(() => {}); },
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
  } as unknown as GeometryBackend;
  return new DocumentStore(be, DOC);
}

describe("renaming a history step", () => {
  it("names it, undoes, and a blank name goes back to the default", () => {
    const s = store();
    s.renameFeature("f1", "  Base plate ");
    expect((s.document.features[0] as { name?: string }).name).toBe("Base plate");
    s.undo();
    expect("name" in s.document.features[0]!).toBe(false);
    s.redo();
    s.renameFeature("f1", "");
    expect("name" in s.document.features[0]!).toBe(false);
  });

  it("keeps the name out of what is built, except on an import", () => {
    const named = { id: "f1", type: "box", name: "Base" } as unknown as Feature;
    expect("name" in withoutDisplayName(named)).toBe(false);
    const imported = { id: "f2", type: "import", name: "Bracket" } as unknown as Feature;
    expect(withoutDisplayName(imported)).toBe(imported);
  });
});
