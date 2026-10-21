// Reference images ride the document as a top level list the store keeps whole,
// off the document the engine builds, and an older reader carries as unknown.

import { describe, expect, it, vi } from "vitest";
import { DocumentStore, KNOWN_DOC_KEYS, carriedKeys } from "../../src/document/store";
import { hashShapedStrings } from "../../src/document/geometryRefs";
import type { GeometryBackend } from "../../src/geometry/client";

vi.stubGlobal("window", globalThis);

const HASH = "429c5bc1257ce3bdfc611423f2302bd2";

function stub() {
  const rebuild = vi.fn(async () => ({ ok: false, error: { message: "stub" } }));
  const backend = {
    rebuild,
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
  return { backend, rebuild };
}

const image = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `${id}.png`, image: HASH, mime: "image/png", px: [400, 200],
  plane: "XY", at: [0, 0], width: 100, angle: 0, opacity: 0.5, ...extra,
});

function fresh(): DocumentStore {
  return new DocumentStore(stub().backend, { parameters: {}, features: [] });
}

const saved = (store: DocumentStore) => JSON.parse(store.toJSON()) as Record<string, unknown>;

describe("reference images in the document", () => {
  it("save and reopen give the same list", () => {
    const store = fresh();
    const list = [image("ri1"), image("ri2", { plane: { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] } })];
    store.setReferenceImages(list);
    const text = store.toJSON();
    expect(JSON.parse(text).referenceImages).toEqual(list);
    const again = fresh();
    again.load(text);
    expect(again.referenceImages()).toEqual(list);
    expect(saved(again).referenceImages).toEqual(list);
  });

  it("keeps a field a newer plugin wrote", () => {
    const store = fresh();
    store.load(JSON.stringify({ parameters: {}, features: [], referenceImages: [image("ri1", { futureField: 7 })] }));
    expect((saved(store).referenceImages as Record<string, unknown>[])[0]!.futureField).toBe(7);
  });

  it("is not part of what the engine builds and changes rebuild nothing", () => {
    const { backend, rebuild } = stub();
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    rebuild.mockClear();
    store.setReferenceImages([image("ri1")]);
    expect("referenceImages" in store.document).toBe(false);
    expect(rebuild).not.toHaveBeenCalled();
    expect(store.dirty).toBe(true);
  });

  it("undoes and redoes, and a coalesced drag is one step", () => {
    const store = fresh();
    store.setReferenceImages([image("ri1")]);
    for (let i = 1; i <= 10; i++) store.setReferenceImages([image("ri1", { opacity: i / 10 })], { coalesce: "opacity:ri1" });
    expect(store.referenceImages()[0]!.opacity).toBe(1);
    store.undo();
    expect(store.referenceImages()[0]!.opacity).toBe(0.5);
    store.undo();
    expect(store.referenceImages()).toEqual([]);
    store.redo();
    expect(store.referenceImages()).toEqual([image("ri1")]);
    store.redo();
    expect(store.referenceImages()[0]!.opacity).toBe(1);
  });

  it("tells listeners on a change, an undo and a new document", () => {
    const store = fresh();
    const seen: number[] = [];
    store.onReferenceImagesChange((l) => seen.push(l.length));
    store.setReferenceImages([image("ri1")]);
    store.undo();
    store.redo();
    store.newDocument();
    expect(seen).toEqual([0, 1, 0, 1, 0]);
    expect(saved(store).referenceImages).toBeUndefined();
  });

  it("drops entries with no id and repeated ids", () => {
    const store = fresh();
    store.load(JSON.stringify({ parameters: {}, features: [], referenceImages: [image("a"), { name: "x" }, image("a"), 5] }));
    expect(store.referenceImages().map((e) => e.id)).toEqual(["a"]);
  });

  it("an older reader carries the list and embeds its image", () => {
    const store = fresh();
    store.setReferenceImages([image("ri1")]);
    const raw = saved(store);
    const older = new Set([...KNOWN_DOC_KEYS].filter((k) => k !== "referenceImages"));
    expect(carriedKeys(raw, older).referenceImages).toEqual([image("ri1")]);
    expect([...hashShapedStrings(raw)]).toContain(HASH);
  });
});
