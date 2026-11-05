// The window's half of a material tool in a live session: an edit of the open document, one undo step, never a load.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore, EMPTY_DOCUMENT } from "../../src/document/store";
import { STARTER_LIBRARY } from "../../src/document/materials";
import { LiveSessionHost, REFUSED_STALE } from "../../src/live/liveSession";
import type { CadDocument, SectionView } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

class StubBackend {
  sent: { op: string; payload: Record<string, unknown> }[] = [];
  reply: Record<string, unknown> | null = { ok: true, guests: [], proposals: [] };

  async session(op: string, payload: object = {}): Promise<Record<string, unknown> | null> {
    this.sent.push({ op, payload: payload as Record<string, unknown> });
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

const CUT: SectionView = { origin: [1, 2, 3], normal: [0, 0, 1], offset: 2, side: 1, ghost: "soft" };
const ALLOY = { id: "m-alloy", name: "Alloy", color: "#b5a642", metalness: 1 };
const PRINT = {
  centroid: [0, 0, 5],
  normal: [0, 0, 1],
  area: 600,
  surface: "plane",
  points: [0, 0, 5],
  faces: 6,
};
const doc = (n: number) =>
  ({
    parameters: {},
    features: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, type: "box" })),
  }) as unknown as CadDocument;

describe("a material edit from an assistant", () => {
  let geo: StubBackend;
  let store: DocumentStore;
  let host: LiveSessionHost;

  const saved = () => {
    const { materials, bodyMaterial, faceMaterials, facePrints } = store.toObject() as unknown as Record<
      string,
      unknown
    >;
    return { materials, bodyMaterial, faceMaterials, facePrints };
  };
  const offer = async (...proposals: object[]) => {
    geo.reply = { ok: true, guests: ["an assistant"], proposals };
    await host.tick();
    geo.reply = { ok: true, guests: [], proposals: [] };
  };
  const proposal = (id: string, edit: unknown, document: CadDocument = doc(9)) => ({
    id,
    name: "an assistant",
    note: "a note",
    document,
    edit,
  });
  const library = [...STARTER_LIBRARY, ALLOY];

  beforeEach(async () => {
    geo = new StubBackend();
    store = new DocumentStore(geo as unknown as GeometryBackend, EMPTY_DOCUMENT);
    store.loadDocument(doc(2));
    store.setSectionView(structuredClone(CUT));
    host = new LiveSessionHost(store, geo as unknown as GeometryBackend, () => true);
    host.start();
    await host.tick();
  });

  it("applies to the open document without loading the one beside it, and one undo takes it all back", async () => {
    const load = vi.spyOn(store, "loadDocument");
    const before = saved();
    const undoable = store.canUndo;
    await offer(
      proposal("p1", {
        kind: "materials",
        library,
        bodies: { body1: "m-alloy" },
        faces: [{ body: "body1", face: 2, material: "m-alloy", print: PRINT }],
      }),
    );

    expect(load).not.toHaveBeenCalled();
    expect(store.document.features.map((f) => f.id)).toEqual(["f0", "f1"]);
    expect(store.sectionView).toEqual(CUT);
    const after = {
      materials: library,
      bodyMaterial: { body1: "m-alloy" },
      faceMaterials: { "body1#2": "m-alloy" },
      facePrints: { "body1#2": PRINT },
    };
    expect(saved()).toEqual(after);

    expect(store.canUndo).toBe(true);
    store.undo();
    expect(saved()).toEqual(before);
    expect(store.canUndo).toBe(undoable);
    store.redo();
    expect(saved()).toEqual(after);
    expect(store.document.features.map((f) => f.id)).toEqual(["f0", "f1"]);
    await host.stop();
  });

  it("acknowledges the edit and moves the revision, so a later proposal on the old base is refused", async () => {
    const revision = () => geo.sent.filter((m) => m.op === "session_host").at(-1)!.payload["revision"] as number;
    const base = revision();
    await offer(
      { ...proposal("p1", { kind: "materials", library }), baseRevision: base },
      { ...proposal("p2", { kind: "materials", bodies: { body1: "m-alloy" } }), baseRevision: base },
    );
    await host.tick();
    expect(revision()).toBe(base + 1);
    const status = geo.sent.filter((m) => m.op === "session_host").at(-1)!.payload["status"] as {
      applied: string[];
      refused: { id: string; message: string }[];
    };
    expect(status.applied).toEqual(["p1"]);
    expect(status.refused).toEqual([{ id: "p2", message: REFUSED_STALE }]);
    expect(store.materialLibrary.map((m) => m.id)).toContain("m-alloy");
    expect(store.bodyMaterialId("body1")).toBeUndefined();
    await host.stop();
  });

  it("takes a removal's uses with it, undo brings them back, and leaves a later edit of another material", async () => {
    await offer(
      proposal("p1", {
        kind: "materials",
        library,
        bodies: { body1: "m-alloy" },
        faces: [{ body: "body1", face: 2, material: "m-alloy" }],
      }),
    );
    // The window holds a use the assistant's edit does not name, it must not stay on a material that is gone.
    store.setBodiesMaterial(["body7"], "m-alloy");
    await offer(
      proposal("p2", {
        kind: "materials",
        library: STARTER_LIBRARY,
        bodies: { body1: null },
        faces: [{ body: "body1", face: 2, material: null }],
      }),
    );
    expect(store.materialLibrary.map((m) => m.id)).not.toContain("m-alloy");
    expect(store.bodyMaterialId("body1")).toBeUndefined();
    expect(store.bodyMaterialId("body7")).toBeUndefined();
    expect(saved().faceMaterials).toBeUndefined();

    const other = STARTER_LIBRARY[0]!.id;
    store.updateMaterial(other, { color: "#123456" });
    store.undo();
    expect(store.materialLibrary.map((m) => m.id)).toEqual(library.map((m) => m.id));
    expect(store.materialLibrary.find((m) => m.id === other)?.color).toBe("#123456");
    expect(store.bodyMaterialId("body1")).toBe("m-alloy");
    expect(store.bodyMaterialId("body7")).toBe("m-alloy");
    expect(saved().faceMaterials).toEqual({ "body1#2": "m-alloy" });
    await host.stop();
  });

  it("repairs what it is sent as a file is repaired and skips what cannot be read", async () => {
    await offer(
      proposal("p1", {
        kind: "materials",
        library: [...STARTER_LIBRARY, { ...ALLOY, roughness: 7 }, "nonsense", { id: "m-bad" }],
        bodies: { body1: "m-unknown", body2: 3, body3: "m-alloy" },
        faces: [
          { body: "body1", face: -1, material: "m-alloy" },
          { body: "body1", face: 1.5, material: "m-alloy" },
          { body: 1, face: 1, material: "m-alloy" },
          { body: "body1", face: 3, material: "m-unknown" },
          { body: "body1", face: 4, material: "m-alloy", print: { centroid: "here" } },
        ],
      }),
    );
    expect(store.materialLibrary.find((m) => m.id === "m-alloy")?.roughness).toBe(1);
    expect(saved().bodyMaterial).toEqual({ body3: "m-alloy" });
    expect(saved().faceMaterials).toEqual({ "body1#4": "m-alloy" });
    expect(saved().facePrints).toBeUndefined();
    await host.stop();
  });

  it("falls back to the document for a kind of edit this window does not know", async () => {
    await offer(proposal("p1", { kind: "from-the-future" }, doc(3)));
    expect(store.document.features.map((f) => f.id)).toEqual(["f0", "f1", "f2"]);
    await host.stop();
  });

  it("is refused like any edit when the window shares read-only", async () => {
    await host.stop();
    host = new LiveSessionHost(store, geo as unknown as GeometryBackend, () => false);
    host.start();
    await host.tick();
    await offer(proposal("p1", { kind: "materials", library }));
    expect(store.materialLibrary.map((m) => m.id)).not.toContain("m-alloy");
    await host.stop();
  });
});
