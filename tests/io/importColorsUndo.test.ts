import { describe, it, expect, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { adoptImportedColors, importPath, recolorOnRedo } from "../../src/io/files";

vi.stubGlobal("window", globalThis);

const IMP = "imp1";
const box = (id: string) => ({ id, type: "box", length: 1, width: 1, height: 1 }) as unknown as Feature;
const imp = () => ({ id: IMP, type: "import", format: "step", source: "a.step", data: "" }) as unknown as Feature;

function backend(): GeometryBackend {
  return {
    async rebuild(doc: CadDocument) {
      const ours = doc.features.some((f) => f.id === IMP);
      const result: RebuildResult = {
        mesh: { positions: [], indices: [], faceIds: [] },
        edges: [],
        bbox: { min: [0, 0, 0], max: [0, 0, 0] },
        bodies: ours ? [{ id: "body9", name: "Part", faceStart: 0, faceCount: 1, faceOwners: [IMP] }] : [],
      };
      return { ok: true as const, result };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    onProgress() {
      return () => {};
    },
    async cancel() {
      return true;
    },
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
    recolorOnRedo(store, imp(), RED);

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
    recolorOnRedo(store, imp(), RED);
    store.addFeature(box("c"));
    expect(store.canRedo).toBe(false);
    store.addFeature(imp());
    await store.rebuildNow();
    await Promise.resolve();
    expect(store.bodyMaterialId("body9")).toBeUndefined();
  });

  it("an import undone during its rebuild puts no colours on a new feature that gets its id", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true });
    store.undo();
    expect(await adopting).toBe(false);
    recolorOnRedo(store, imp(), RED);
    store.addFeature(box(IMP));
    await store.rebuildNow();
    await Promise.resolve();
    expect(store.bodyMaterialId("body9")).toBeUndefined();
  });

  it("an import whose rebuild a document open cut short puts no colours on the opened one", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true });
    store.load(JSON.stringify({ parameters: {}, features: [imp()], materials: store.materialLibrary }));
    await adopting;
    await store.rebuildNow();
    expect(store.bodyMaterialId("body9")).toBeUndefined();
    expect(store.canUndo).toBe(false);
  });

  it("an import undone during its rebuild puts no colours on a feature drawn before the rebuild ends", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true, source: "a.step" });
    store.undo();
    store.addFeature(box(IMP));
    expect(await adopting).toBe(false);
    expect(store.bodyMaterialId("body9")).toBeUndefined();
    store.undo();
    expect(store.document.features.map((f) => f.id)).toEqual(["a"]);
  });

  it("an import undone during its rebuild puts no colours on another file's import that gets its id", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true, source: "a.step" });
    store.undo();
    store.addFeature({ ...imp(), source: "b.step" } as Feature);
    expect(await adopting).toBe(false);
    expect(store.bodyMaterialId("body9")).toBeUndefined();
  });

  it("keeps an edit made during the import's rebuild its own step, and the colours one of their own", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true, source: "a.step" });
    store.addFeature(box("z"));
    expect(await adopting).toBe(true);
    store.undo();
    expect(store.bodyMaterialId("body9")).toBeUndefined();
    expect(has(store, "z")).toBe(true);
    store.undo();
    expect(has(store, "z")).toBe(false);
    expect(has(store, IMP)).toBe(true);
  });

  it("puts no colours on with a redo that an edit followed before its rebuild ended", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true });
    store.undo();
    expect(await adopting).toBe(false);
    recolorOnRedo(store, imp(), RED);
    store.redo();
    await Promise.resolve();
    store.addFeature(box("z"));
    await store.rebuildNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.bodyMaterialId("body9")).toBeUndefined();
  });

  it("puts no colours on the same file imported again as a new edit", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true });
    store.undo();
    expect(await adopting).toBe(false);
    recolorOnRedo(store, imp(), RED);
    store.addFeature(imp());
    await store.rebuildNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.bodyMaterialId("body9")).toBeUndefined();
  });

  it("puts no colours on another file's import that an undo brings back under the same id", async () => {
    const store = new DocumentStore(backend(), { parameters: {}, features: [box("a")] });
    store.addFeature({ ...imp(), source: "b.step" } as Feature);
    store.removeFeature(IMP);
    store.addFeature(imp());
    const adopting = adoptImportedColors(store, IMP, RED, { joinImport: true });
    store.undo();
    expect(await adopting).toBe(false);
    recolorOnRedo(store, imp(), RED);
    store.undo();
    await store.rebuildNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.bodyMaterialId("body9")).toBeUndefined();
  });
});

describe("one undo after a whole import", () => {
  function importingBackend(): GeometryBackend {
    return {
      ...backend(),
      async rebuild(doc: CadDocument) {
        const own = doc.features.find((f) => f.type === "import");
        const bodies = own ? [{ id: "body9", name: "Part", faceStart: 0, faceCount: 1, faceOwners: [own.id] }] : [];
        const result: RebuildResult = {
          mesh: { positions: [], indices: [], faceIds: [] },
          edges: [],
          bbox: { min: [0, 0, 0], max: [0, 0, 0] },
          bodies,
        };
        return { ok: true as const, result };
      },
      async importGeometry() {
        return { ok: true, geom: "h", name: "part", solid: true, faces: 6, color: "#ff0000" };
      },
    } as unknown as GeometryBackend;
  }

  it("takes back the import with one undo, colours included, and one redo brings both back", async () => {
    const be = importingBackend();
    const store = new DocumentStore(be, { parameters: {}, features: [box("a")] });
    await importPath(store, be, "C:/m/part.step");
    const feature = store.document.features.find((f) => f.type === "import")!;
    expect(store.bodyMaterialId("body9")).toBeDefined();
    store.undo();
    expect(store.document.features.map((f) => f.id)).toEqual(["a"]);
    expect(store.bodyMaterialId("body9")).toBeUndefined();
    expect(store.canUndo).toBe(false);
    store.redo();
    await vi.waitFor(() => expect(store.bodyMaterialId("body9")).toBeDefined());
    expect(has(store, feature.id)).toBe(true);
    expect(store.canRedo).toBe(false);
  });

  it("keeps an Undo pressed while the file is read from taking back the step before it", async () => {
    let release!: () => void;
    const be = importingBackend();
    const read = new Promise<void>((r) => (release = r));
    (be as unknown as { importGeometry: () => Promise<unknown> }).importGeometry = async () => {
      await read;
      return { ok: true, geom: "h", name: "part", solid: true, faces: 6, color: "#ff0000" };
    };
    const store = new DocumentStore(be, { parameters: {}, features: [] });
    store.addFeature(box("a"));
    const importing = importPath(store, be, "C:/m/part.step");
    store.undo();
    expect(has(store, "a")).toBe(true);
    release();
    await importing;
    store.undo();
    expect(store.document.features.map((f) => f.id)).toEqual(["a"]);
    expect(store.canRedo).toBe(true);
  });
});
