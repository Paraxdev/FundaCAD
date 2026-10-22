// The browser build saves by download and opens by picking text, with no Rust
// in between, so it has to embed and publish the geometry itself, through the
// engine's blob store, or a reopened file names an import nobody has.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { DocumentStore } from "../../src/document/store";
import { blake2b128Hex } from "../../src/document/blake2b";
import type { GeometryBackend } from "../../src/geometry/client";

// Mocked once for the file: a doMock or doUnmock per test is applied by whichever
// import resolves mocks next, so it can land in the middle of another test.
const ui = vi.hoisted(() => ({ toasts: [] as { message: string; kind: string | undefined }[] }));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, o?: { kind?: string }) => { ui.toasts.push({ message, kind: o?.kind }); return null; },
  dismissToast() {},
}));

const BREP = new Uint8Array([0x44, 0x42, 0x52, 0x45, 0x50, 0x00, 0xff, 0x10, 0x7f, 0x80]);
const HASH = blake2b128Hex(BREP);
const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PICTURE_HASH = blake2b128Hex(PICTURE);
const UNKNOWN_HASH = "0123456789abcdef0123456789abcdef";

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function importDoc(extra: Record<string, unknown> = {}) {
  return {
    version: 10,
    parameters: {},
    features: [{ id: "f1", type: "import", format: "step", name: "bracket.step", geom: HASH }],
    materials: [{ id: "m1", name: "Red", color: "#cc2200" }],
    bodyMaterial: { body1: "m1" },
    faceMaterials: { "body1#2": "m1" },
    importColorSource: { f1: "faces" },
    ...extra,
  };
}

describe("a document with an imported body in the browser build", () => {
  let downloads: { name: string; text: string }[];

  beforeEach(() => {
    downloads = [];
    ui.toasts = [];
    (globalThis as unknown as Record<string, unknown>).window = { addEventListener() {}, removeEventListener() {} };
    let pending: Blob | null = null;
    (globalThis as unknown as Record<string, unknown>).document = {
      createElement: () => {
        const a = { href: "", download: "", click() { const b = pending!; void b.text().then((text) => downloads.push({ name: a.download, text })); } };
        return a;
      },
    };
    URL.createObjectURL = (b: Blob) => { pending = b; return "blob:x"; };
    URL.revokeObjectURL = () => {};
  });

  function engine(blobs: Map<string, Uint8Array>, withBlobs = true) {
    const gets: string[] = [];
    const puts: Uint8Array[] = [];
    const geometry = {
      async rebuild() { return { ok: false, error: { message: "stub" } }; },
      async init() {}, onStatus() { return () => {}; }, connected: true,
      async migrateGeometry() { return []; },
      ...(withBlobs ? {
        async blobGet(h: string) { gets.push(h); return blobs.get(h) ?? null; },
        async blobPut(bytes: Uint8Array) { puts.push(bytes); const h = blake2b128Hex(bytes); blobs.set(h, bytes); return h; },
      } : {}),
    } as unknown as GeometryBackend;
    return { geometry, gets, puts };
  }

  function storeWith(doc: object, geometry: GeometryBackend) {
    const store = new DocumentStore(geometry, { parameters: {}, features: [] });
    store.load(JSON.stringify(doc));
    return store;
  }

  async function settle() {
    for (let i = 0; i < 5 && !downloads.length; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it("embeds the import's geometry, last, under the hash of its bytes, on Save As and on Save", async () => {
    const { saveDocumentAs, saveDocument } = await import("../../src/io/files");
    for (const save of [saveDocumentAs, saveDocument]) {
      downloads = [];
      const { geometry } = engine(new Map([[HASH, BREP]]));
      const store = storeWith(importDoc(), geometry);
      await save(store);
      await settle();
      expect(downloads).toHaveLength(1);
      const obj = JSON.parse(downloads[0]!.text) as Record<string, unknown>;
      expect(Object.keys(obj).at(-1)).toBe("geometry");
      const geom = obj.geometry as Record<string, string>;
      expect(Object.keys(geom)).toEqual([HASH]);
      expect(blake2b128Hex(unb64(geom[HASH]!))).toBe(HASH);
      expect(downloads[0]!.text.startsWith(store.toJSON().trimEnd().slice(0, -1).trimEnd())).toBe(true);
      expect(store.dirty).toBe(false);
    }
    expect(ui.toasts).toEqual([]);
  });

  it("reopens on an engine that never saw the import, with the geometry and the colours", async () => {
    const { saveDocumentAs, openDocumentText } = await import("../../src/io/files");
    const first = engine(new Map([[HASH, BREP]]));
    const saved = storeWith(importDoc(), first.geometry);
    await saveDocumentAs(saved);
    await settle();

    const blank = new Map<string, Uint8Array>();
    const second = engine(blank);
    const store = new DocumentStore(second.geometry, { parameters: {}, features: [] });
    const outcome = await openDocumentText(store, "bracket.funda", downloads[0]!.text);
    expect({ outcome, toasts: ui.toasts }).toEqual({ outcome: "ok", toasts: [] });
    expect(second.puts.map((b) => Array.from(b))).toEqual([Array.from(BREP)]);
    expect(blank.get(HASH)).toEqual(BREP);
    const reopened = store.toObject();
    expect(reopened).not.toHaveProperty("geometry");
    expect(reopened).toEqual(saved.toObject());
    expect(reopened.bodyMaterial).toEqual({ body1: "m1" });
    expect(reopened.faceMaterials).toEqual({ "body1#2": "m1" });
    expect(ui.toasts).toEqual([]);
  });

  it("embeds a picture or an unknown feature's blob the engine has, and skips one it lacks", async () => {
    const { saveDocumentAs } = await import("../../src/io/files");
    const { geometry } = engine(new Map([[HASH, BREP], [PICTURE_HASH, PICTURE]]));
    const store = storeWith(importDoc({
      referenceImages: [{ id: "r1", image: PICTURE_HASH }],
      features: [
        { id: "f1", type: "import", format: "step", name: "bracket.step", geom: HASH },
        { id: "w1", type: "futureWidget", blob: UNKNOWN_HASH },
      ],
    }), geometry);
    await saveDocumentAs(store);
    await settle();
    const geom = (JSON.parse(downloads[0]!.text) as { geometry: Record<string, string> }).geometry;
    expect(Object.keys(geom).sort()).toEqual([HASH, PICTURE_HASH].sort());
    expect(geom[PICTURE_HASH]).toBe(b64(PICTURE));
    expect(ui.toasts).toEqual([]);
  });

  it("refuses to download a file that would open without an import, and says which one", async () => {
    const { saveDocumentAs, saveDocument } = await import("../../src/io/files");
    for (const withBlobs of [true, false]) {
      for (const save of [saveDocumentAs, saveDocument]) {
        ui.toasts = [];
        downloads = [];
        const { geometry } = engine(new Map(), withBlobs);
        const store = storeWith(importDoc(), geometry);
        store.setParam("w", 5);
        expect(store.dirty).toBe(true);
        const name = store.fileName;
        await save(store);
        await settle();
        expect(downloads).toEqual([]);
        expect(store.dirty).toBe(true);
        expect(store.fileName).toBe(name);
        expect(ui.toasts).toHaveLength(1);
        expect(ui.toasts[0]!.kind).toBe("error");
        expect(ui.toasts[0]!.message).toContain("bracket.step");
      }
    }
  });

  it("still downloads plain JSON for a document with no imports on a backend without a blob store", async () => {
    const { saveDocumentAs } = await import("../../src/io/files");
    const { geometry } = engine(new Map(), false);
    const store = storeWith({ version: 10, parameters: { w: 5 }, features: [] }, geometry);
    await saveDocumentAs(store);
    await settle();
    expect(downloads).toEqual([{ name: "Untitled.funda", text: store.toJSON() }]);
    expect(ui.toasts).toEqual([]);
  });

  it("refuses to open a file whose geometry does not match its hash, and publishes nothing", async () => {
    const { openDocumentText } = await import("../../src/io/files");
    const blank = new Map<string, Uint8Array>();
    const { geometry, puts } = engine(blank);
    const store = storeWith({ version: 10, parameters: { kept: 1 }, features: [] }, geometry);
    const text = JSON.stringify({ ...importDoc(), geometry: { [HASH]: b64(new Uint8Array([1, 2, 3])) } });
    expect(await openDocumentText(store, "bad.funda", text)).toBe("unreadable");
    expect(puts).toEqual([]);
    expect(store.document.parameters).toEqual({ kept: 1 });
    expect(ui.toasts).toHaveLength(1);
    expect(ui.toasts[0]!.kind).toBe("error");
  });

  it("opens a dropped file's embedded geometry through the same path", async () => {
    const { openDocumentBytes } = await import("../../src/io/files");
    const blank = new Map<string, Uint8Array>();
    const { geometry } = engine(blank);
    const store = new DocumentStore(geometry, { parameters: {}, features: [] });
    const text = JSON.stringify({ ...importDoc(), geometry: { [HASH]: b64(BREP) } }, null, 2);
    const outcome = await openDocumentBytes(store, new File([text], "bracket.funda"), geometry);
    expect({ outcome, toasts: ui.toasts }).toEqual({ outcome: "ok", toasts: [] });
    expect(blank.get(HASH)).toEqual(BREP);
  });
});
