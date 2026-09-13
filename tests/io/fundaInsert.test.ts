import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import {
  buildableSource,
  documentStamp,
  insertFundaDocument,
  staleLinks,
  updateFundaLink,
} from "../../src/io/fundaInsert";
import type { CadDocument, Feature } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

vi.stubGlobal("window", globalThis);

const SOURCE = JSON.stringify({
  parameters: { w: 10 },
  features: [
    { id: "f1", type: "box", length: 10, width: 10, height: 10 },
    { id: "f2", type: "box", length: 5, width: 5, height: 5 },
    { id: "f3", type: "box", length: 1, width: 1, height: 1 },
  ],
  suppressed: ["f2"],
  rollback: 2,
});

function backend(opts: { exportFails?: boolean } = {}) {
  const exported: { doc: CadDocument; path: string }[] = [];
  const be = {
    async rebuild() { return new Promise<never>(() => {}); },
    async init() {},
    onStatus() { return () => {}; },
    onProgress() { return () => {}; },
    async cancel() { return true; },
    async export(doc: CadDocument, _fmt: string, path: string) {
      exported.push({ doc, path });
      return opts.exportFails ? { ok: false, message: "nothing built" } : { ok: true, path };
    },
    async importGeometry() {
      return { ok: true, geom: `hash${exported.length}`, name: "tmp", solid: true, faces: 6 };
    },
  } as unknown as GeometryBackend;
  return { be, exported };
}

const empty = (): CadDocument => ({ parameters: {}, features: [] });

describe("buildableSource", () => {
  it("builds what the source itself would, up to its rollback and without what it suppresses", () => {
    const doc = buildableSource(SOURCE);
    expect(doc.features.map((f) => f.id)).toEqual(["f1"]);
    expect(doc.parameters).toEqual({ w: 10 });
  });
});

describe("documentStamp", () => {
  it("changes with the text and not otherwise", () => {
    expect(documentStamp(SOURCE)).toBe(documentStamp(SOURCE));
    expect(documentStamp(SOURCE)).not.toBe(documentStamp(SOURCE.replace("10", "11")));
  });
});

describe("insertFundaDocument", () => {
  it("appends the source's geometry as one import step with no link", async () => {
    const { be, exported } = backend();
    const store = new DocumentStore(be, empty());
    const res = await insertFundaDocument(store, be, { path: "C:/parts/Bracket.funda", text: SOURCE }, "append", "C:/tmp/a.step");
    expect(res.ok).toBe(true);
    expect(exported[0]!.path).toBe("C:/tmp/a.step");
    const f = store.document.features[0] as Feature & { link?: unknown; name: string; geom: string };
    expect(f).toMatchObject({ type: "import", format: "step", name: "Bracket", geom: "hash1" });
    expect(f.link).toBeUndefined();
  });

  it("links it with the file and a stamp, and an update re-reads it in place", async () => {
    const { be } = backend();
    const store = new DocumentStore(be, empty());
    const res = await insertFundaDocument(store, be, { path: "C:/parts/Bracket.funda", text: SOURCE }, "link", "C:/tmp/a.step");
    if (!res.ok) throw new Error(res.message);
    const linked = store.document.features[0] as Feature & { link: { path: string; stamp: string } };
    expect(linked.link).toEqual({ path: "C:/parts/Bracket.funda", stamp: documentStamp(SOURCE) });

    const changed = SOURCE.replace('"length":10', '"length":20');
    expect((await staleLinks(store.document.features, async () => changed)).changed).toEqual([res.id]);
    expect((await staleLinks(store.document.features, async () => null)).missing).toEqual([res.id]);

    await updateFundaLink(store, be, res.id, { path: "C:/parts/Bracket.funda", text: changed }, "C:/tmp/b.step");
    const after = store.document.features[0] as Feature & { geom: string; link: { stamp: string } };
    expect(store.document.features).toHaveLength(1);
    expect(after.geom).toBe("hash2");
    expect(after.link.stamp).toBe(documentStamp(changed));
    expect((await staleLinks(store.document.features, async () => changed)).changed).toEqual([]);
  });

  it("adds nothing when the source does not build", async () => {
    const { be } = backend({ exportFails: true });
    const store = new DocumentStore(be, empty());
    const res = await insertFundaDocument(store, be, { path: "x.funda", text: SOURCE }, "append", "t.step");
    expect(res.ok).toBe(false);
    expect(store.document.features).toHaveLength(0);
  });
});
