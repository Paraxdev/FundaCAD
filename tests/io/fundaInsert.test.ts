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
    async rebuild() {
      return new Promise<never>(() => {});
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
    const res = await insertFundaDocument(
      store,
      be,
      { path: "C:/parts/Bracket.funda", text: SOURCE },
      "append",
      "C:/tmp/a.step",
    );
    expect(res.ok).toBe(true);
    expect(exported[0]!.path).toBe("C:/tmp/a.step");
    const f = store.document.features[0] as Feature & { link?: unknown; name: string; geom: string };
    expect(f).toMatchObject({ type: "import", format: "step", name: "Bracket", geom: "hash1" });
    expect(f.link).toBeUndefined();
  });

  it("links it with the file, a stamp and the file's size and time, and an update re-reads it in place", async () => {
    const { be } = backend();
    const store = new DocumentStore(be, empty());
    const first = { size: 120, mtimeMs: 1_700_000_000_000 };
    const res = await insertFundaDocument(
      store,
      be,
      { path: "C:/parts/Bracket.funda", text: SOURCE, stat: first },
      "link",
      "C:/tmp/a.step",
    );
    if (!res.ok) throw new Error(res.message);
    const linked = store.document.features[0] as Feature & { link: unknown };
    expect(linked.link).toEqual({
      path: "C:/parts/Bracket.funda",
      stamp: documentStamp(SOURCE),
      size: 120,
      mtime: 1_700_000_000_000,
    });

    const changed = SOURCE.replace('"length":10', '"length":20');
    const later = { size: 121, mtimeMs: 1_700_000_005_000 };
    await updateFundaLink(
      store,
      be,
      res.id,
      { path: "C:/parts/Bracket.funda", text: changed, stat: later },
      "C:/tmp/b.step",
    );
    const after = store.document.features[0] as Feature & { geom: string; link: unknown };
    expect(store.document.features).toHaveLength(1);
    expect(after.geom).toBe("hash2");
    expect(after.link).toEqual({
      path: "C:/parts/Bracket.funda",
      stamp: documentStamp(changed),
      size: 121,
      mtime: 1_700_000_005_000,
    });
  });

  it("links without a size and time when the file could not be stat'd", async () => {
    const { be } = backend();
    const store = new DocumentStore(be, empty());
    await insertFundaDocument(store, be, { path: "C:/parts/Bracket.funda", text: SOURCE }, "link", "C:/tmp/a.step");
    const linked = store.document.features[0] as Feature & { link: unknown };
    expect(linked.link).toEqual({ path: "C:/parts/Bracket.funda", stamp: documentStamp(SOURCE) });
  });

  it("adds nothing when the source does not build", async () => {
    const { be } = backend({ exportFails: true });
    const store = new DocumentStore(be, empty());
    const res = await insertFundaDocument(store, be, { path: "x.funda", text: SOURCE }, "append", "t.step");
    expect(res.ok).toBe(false);
    expect(store.document.features).toHaveLength(0);
  });
});

describe("staleLinks", () => {
  const link = (id: string, extra: Record<string, unknown>) =>
    ({
      id,
      type: "import",
      format: "step",
      name: id,
      source: `C:/parts/${id}.funda`,
      geom: "0123456789abcdef0123456789abcdef",
      solid: true,
      link: { path: `C:/parts/${id}.funda`, stamp: "s", ...extra },
    }) as unknown as Feature;
  const known = { size: 10, mtime: 5000 };

  it("compares the stored size and time with the file's", async () => {
    const features = [
      link("same", known),
      link("bigger", known),
      link("touched", known),
      link("gone", known),
      link("refused", known),
      link("old", {}),
      { id: "box1", type: "box", length: 1, width: 1, height: 1 } as unknown as Feature,
    ];
    const res = await staleLinks(features, async (path) => {
      if (path.includes("bigger")) return { size: 11, mtimeMs: 5000 };
      if (path.includes("touched")) return { size: 10, mtimeMs: 6000 };
      if (path.includes("gone")) return "missing";
      if (path.includes("refused")) return "unknown";
      return { size: 10, mtimeMs: 5000 };
    });
    expect(res).toEqual({ changed: ["bigger", "touched"], missing: ["gone"], unknown: ["refused", "old"] });
  });

  it("still reports a missing file for a link made before sizes were stored", async () => {
    const res = await staleLinks([link("old", {})], async () => "missing");
    expect(res).toEqual({ changed: [], missing: ["old"], unknown: [] });
  });
});
