// MCP doc_get hands an assistant the geometry alone, so the MCP server keeps the open document's project state
// in what its doc_set pushes (crates/fundacad-mcp/tests/doc_set_keeps.rs). That only works if the window publishes
// that state for the server to keep, and takes it back from a replacing proposal; doc_open still replaces it all.
import { beforeEach, describe, expect, it } from "vitest";
import { DocumentStore, EMPTY_DOCUMENT } from "../../src/document/store";
import { LiveSessionHost } from "../../src/live/liveSession";
import type { CadDocument, StressStudy } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

class StubBackend {
  reply: Record<string, unknown> = { ok: true, guests: [], proposals: [] };
  published: Record<string, unknown>[] = [];
  async session(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (op === "session_host") this.published.push(args.document as Record<string, unknown>);
    return this.reply;
  }
  async rebuild() {
    return { ok: true, result: { bodies: [], errors: [] } } as never;
  }
  async init() {}
  onStatus() {
    return () => {};
  }
  get connected() {
    return true;
  }
}

const load: StressStudy["loads"][number] = {
  id: 2,
  kind: "force",
  faces: [{ kind: "face", by: "nearest", point: [14.5, -2.75, 9], body: "body1" }],
  force: 37.5,
  direction: "custom",
  custom: [0.3, -0.4, -0.866],
  pressure: 0.15,
};
const study: StressStudy = {
  body: "body1",
  supports: [
    { id: 1, type: "fixed", faces: [{ kind: "face", by: "nearest", point: [-6.5, 3.25, 1.5], body: "body1" }] },
  ],
  loads: [load],
  gravity: { on: true, direction: "-Y" },
  material: "PETG",
  custom: { E: 2100, nu: 0.38, yield: 47, density: 1.27 },
  size: 2.5,
};
const environment = { name: "Workshop", settings: { exposure: 1.35, rotation: 37.5 } };
const rubber = { id: "m2", name: "Rubber", color: "#222222", roughness: 0.9 };
const materials = [{ id: "m1", name: "Anodised", color: "#3a6ea5", metalness: 0.7, roughness: 0.35 }, rubber];

const plate = (id: string, width: number): CadDocument =>
  ({
    parameters: {},
    features: [{ id, type: "box", width, depth: 7.25, height: 3.5 }],
  }) as unknown as CadDocument;

const withState = (doc: CadDocument): CadDocument =>
  ({ ...doc, stress: study, environment, materials, bodyMaterial: { body1: "m1" } }) as CadDocument;

const state = (doc: CadDocument | Record<string, unknown>) => {
  const d = doc as Record<string, unknown>;
  return {
    features: (d.features as { id: string }[]).map((f) => f.id),
    stress: d.stress ?? null,
    environment: d.environment ?? null,
    materials: d.materials ?? null,
  };
};

describe("an assistant's doc_set and the open document's project state", () => {
  let geo: StubBackend;
  let store: DocumentStore;
  let host: LiveSessionHost;
  let n = 0;

  const propose = async (note: string, document: CadDocument) => {
    geo.reply = {
      ok: true,
      guests: ["an assistant"],
      proposals: [{ id: `p${++n}`, name: "an assistant", note, document, replaces: true }],
    };
    await host.tick();
    geo.reply = { ok: true, guests: ["an assistant"], proposals: [] };
  };

  beforeEach(async () => {
    geo = new StubBackend();
    store = new DocumentStore(geo as unknown as GeometryBackend, EMPTY_DOCUMENT);
    store.loadDocument(withState(plate("bracket", 12.5)));
    host = new LiveSessionHost(store, geo as unknown as GeometryBackend, () => true);
    host.start();
    await host.tick();
  });

  it("publishes the state for the server to keep, and keeps it from a doc_set that carries it", async () => {
    const published = state(geo.published[0] ?? {});
    await propose("doc_set", withState(plate("lid", 18.75)));
    const afterSet = state(store.toObject());
    await host.stop();
    const full = { stress: study, environment, materials };
    expect({ published, afterSet }).toEqual({
      published: { features: ["bracket"], ...full },
      afterSet: { features: ["lid"], ...full },
    });
  });

  it("replaces the state with one the doc_set names, and doc_open with a bare file clears it all", async () => {
    const other: StressStudy = { ...study, loads: [{ ...load, force: 112.5, direction: "-Z" }] };
    await propose("doc_set", { ...withState(plate("lid", 18.75)), stress: other, materials: [rubber] });
    const replaced = state(store.toObject());
    await propose("doc_open: D:/parts/knob.funda", plate("knob", 9.5));
    const opened = state(store.toObject());
    await host.stop();
    expect({ replaced, opened }).toEqual({
      replaced: { features: ["lid"], stress: other, environment, materials: [rubber] },
      opened: { features: ["knob"], stress: null, environment: null, materials: null },
    });
  });
});
