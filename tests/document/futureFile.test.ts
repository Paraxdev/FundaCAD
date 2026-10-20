// A file from a newer version (tests/fixtures/future/v99.funda) opened and saved
// here: every part this version does not know comes back as it was.
import { describe, it, expect } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { FORMAT_VERSION } from "../../src/document/migrate";
import { openNotices } from "../../src/document/openNotice";
import type { GeometryBackend } from "../../src/geometry/client";
import v99 from "../fixtures/future/v99.funda?raw";

const backend = {
  async rebuild() {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus() {
    return () => {};
  },
  connected: true,
} as unknown as GeometryBackend;

type Doc = Record<string, unknown> & { features: Record<string, unknown>[] };

// Rust takes `geometry` off before the frontend sees the document.
const { geometry: _geometry, ...input } = JSON.parse(v99) as Doc & { geometry: unknown };

function openAndSave(): { store: DocumentStore; saved: Doc } {
  const store = new DocumentStore(backend, { parameters: {}, features: [] });
  store.load(JSON.stringify(input));
  return { store, saved: JSON.parse(store.toJSON()) as Doc };
}

describe("a file from a newer version", () => {
  it("writes back every part this version does not know", () => {
    const { saved } = openAndSave();
    expect(saved["futureKey"]).toEqual(input["futureKey"]);
    expect(saved["stress"]).toEqual(input["stress"]);
    expect(saved["elements"]).toEqual(input["elements"]);
    expect(saved.features.find((f) => f["id"] === "w1")).toEqual(input.features.find((f) => f["id"] === "w1"));
    expect(saved.features.find((f) => f["id"] === "e1")?.["futureFlag"]).toBe(true);
    // Known features may gain defaults on the way, as any file's do.
    expect(saved.features).toMatchObject(input.features);
    expect(saved["bodyIds"]).toEqual(input["bodyIds"]);
    expect(saved["geometry"]).toBeUndefined();
  });

  it("is stamped with this version, the shapes it wrote", () => {
    expect(openAndSave().saved["version"]).toBe(FORMAT_VERSION);
  });

  it("says what was left out", () => {
    const { store } = openAndSave();
    expect(store.openedVersion).toBe(99);
    expect(openNotices(store.document, store.openedVersion).map((n) => n.message)).toEqual([
      "Opened a file from a newer version of FundaCAD. 1 feature was not included because this version does not know it: futureWidget. It is kept and saved with the file. Bodies after it may differ.",
    ]);
  });
});
