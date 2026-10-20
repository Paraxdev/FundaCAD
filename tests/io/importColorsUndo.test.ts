import { describe, it, expect, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { adoptImportedColors, recolorOnRedo } from "../../src/io/files";

vi.stubGlobal("window", globalThis);

const IMP = "imp1";
const box = (id: string) => ({ id, type: "box", length: 1, width: 1, height: 1 }) as unknown as Feature;
const imp = () => ({ id: IMP, type: "import", format: "step", source: "a.step", data: "" }) as unknown as Feature;

function backend(): GeometryBackend {
  return {
    async rebuild(doc: CadDocument) {
      const ours = doc.features.some((f) => f.id === IMP);
      const result: RebuildResult = {
        mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: { min: [0, 0, 0], max: [0, 0, 0] },
        bodies: ours ? [{ id: "body9", name: "Part", faceStart: 0, faceCount: 1, faceOwners: [IMP] }] : [],
      };
      return { ok: true as const, result };
    },
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
  } as unknown as GeometryBackend;
}

const RED = { color: "#ff0000" };
const has = (store: DocumentStore, id: string) => store.document.features.some((f) => f.id === id);

describe("an import's colours and undo", () => {
  it("one undo takes back the import and its colours", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(box("b"));
    store.addFeature(imp());
    expect(await adoptImportedColors(store, IMP, RED, { joinImport: true })).toBe(true);
    expect(store.bodyMaterialId("body9")).toBeDefined();
    store.undo();
    expect(has(store, IMP)).toBe(false);
    expect(store.bodyMaterialId("body9")).toBeUndefined();
    expect(has(store, "b")).toBe(true);
  });

  it("an import undone during its rebuild gets its colours back with its redo", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(box("b"));
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true });
    store.undo();
    expect(await adopting).toBe(false);
    expect(has(store, "b")).toBe(true);
    recolorOnRedo(store, IMP, RED);

    store.redo();
    await vi.waitFor(() => expect(store.bodyMaterialId("body9")).toBeDefined());
    store.undo();
    expect(has(store, IMP)).toBe(false);
    expect(store.bodyMaterialId("body9")).toBeUndefined();
    expect(has(store, "b")).toBe(true);
  });

  it("an import undone during its rebuild and then replaced by an edit puts no colours on later", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true });
    store.undo();
    expect(await adopting).toBe(false);
    recolorOnRedo(store, IMP, RED);
    store.addFeature(box("c"));
    expect(store.canRedo).toBe(false);
    store.addFeature(imp());
    await store.rebuildNow();
    await Promise.resolve();
    expect(store.bodyMaterialId("body9")).toBeUndefined();
  });
});
