// A save in flight when an assistant's doc_open or doc_new lands wrote the user's document to the user's file, and
// must not put that path on the document the assistant brought, where the next Save would overwrite the user's file.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { LiveSessionHost } from "../../src/live/liveSession";
import type { CadDocument } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { box } from "../document/storeKit";

const host = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: Record<string, unknown> }[],
  hold: null as Promise<void> | null,
  savePath: "E:/work/hinge-v2.funda" as string | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    host.invoked.push({ cmd, args });
    if (cmd === "container_save" && host.hold) await host.hold;
    return undefined;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: async () => {}, save: async () => host.savePath }));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));
vi.mock("../../src/io/recentFiles", () => ({ noteRecent() {}, forgetRecent() {}, getRecentFiles: () => [] }));

const { saveDocument, saveDocumentAs } = await import("../../src/io/files");

class Geo {
  reply: Record<string, unknown> = { ok: true, guests: [], proposals: [] };
  connected = true;
  async session() {
    return this.reply;
  }
  async rebuild() {
    return { ok: true, result: { bodies: [], errors: [] } } as never;
  }
  async init() {}
  onStatus() {
    return () => {};
  }
}

const plates = (...ids: string[]): CadDocument =>
  ({ parameters: {}, features: ids.map((id, i) => box(id, 12.5 + i * 3.75)) }) as unknown as CadDocument;
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const meta = (store: DocumentStore) => ({
  dirty: store.dirty,
  path: store.filePath,
  features: store.document.features.map((f) => f.id),
});
const saves = () =>
  host.invoked
    .filter((c) => c.cmd === "container_save")
    .map((c) => ({
      path: c.args.path,
      features: JSON.parse(String(c.args.documentJson)).features.map((f: { id: string }) => f.id),
    }));

function userDoc(path: string | null, geo: Geo) {
  const store = new DocumentStore(geo as unknown as GeometryBackend, { parameters: {}, features: [] });
  store.loadDocument(plates("bracket-a", "web-c"));
  if (path) store.markSaved(path);
  store.addFeature(box("rib-b", 3.5, 2.25, 6));
  return store;
}

// Holds the container write open while the assistant's proposal replaces the document through the live session.
async function raced(how: "save" | "saveAs", note: "doc_open" | "doc_new", path: string | null) {
  const geo = new Geo();
  const store = userDoc(path, geo);
  const live = new LiveSessionHost(store, geo as unknown as GeometryBackend, () => true);
  live.start();
  await live.tick();
  let open!: () => void;
  host.hold = new Promise<void>((r) => (open = r));
  const saving = how === "save" ? saveDocument(store) : saveDocumentAs(store);
  while (!host.invoked.some((c) => c.cmd === "container_save")) await flush();
  const doc = note === "doc_open" ? plates("lid-x", "clip-y", "pin-z") : plates("blank-q");
  geo.reply = {
    ok: true,
    guests: ["an assistant"],
    proposals: [{ id: "p1", name: "an assistant", note, document: doc, replaces: true }],
  };
  await live.tick();
  open();
  await saving;
  host.hold = null;
  await live.stop();
  return store;
}

describe("a save racing an assistant's replacing load", () => {
  beforeEach(() => {
    host.invoked = [];
    host.hold = null;
    host.savePath = "E:/work/hinge-v2.funda";
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  });

  it("Save during a doc_open writes the user's file and leaves the assistant's document untitled", async () => {
    const store = await raced("save", "doc_open", "D:/parts/bracket.funda");
    const after = { meta: meta(store), saves: saves() };
    host.savePath = null;
    await saveDocument(store);
    expect({ after, next: saves().length }).toEqual({
      after: {
        meta: { dirty: true, path: null, features: ["lid-x", "clip-y", "pin-z"] },
        saves: [{ path: "D:/parts/bracket.funda", features: ["bracket-a", "web-c", "rib-b"] }],
      },
      next: 1,
    });
  });

  it("Save As during a doc_new on an untitled document leaves the new document untitled", async () => {
    const store = await raced("saveAs", "doc_new", null);
    expect({ meta: meta(store), saves: saves() }).toEqual({
      meta: { dirty: true, path: null, features: ["blank-q"] },
      saves: [{ path: "E:/work/hinge-v2.funda", features: ["bracket-a", "web-c", "rib-b"] }],
    });
  });

  it("Save As during a doc_open on a saved document does not take either path", async () => {
    const store = await raced("saveAs", "doc_open", "D:/parts/bracket.funda");
    expect(meta(store)).toEqual({ dirty: true, path: null, features: ["lid-x", "clip-y", "pin-z"] });
  });

  it("Save and Save As with no assistant load still mark the document saved", async () => {
    const out: Record<string, unknown> = {};
    for (const how of ["save", "saveAs"] as const) {
      host.invoked = [];
      const store = userDoc(how === "save" ? "D:/parts/bracket.funda" : null, new Geo());
      await (how === "save" ? saveDocument(store) : saveDocumentAs(store));
      out[how] = { meta: meta(store), saves: saves().map((s) => s.path) };
    }
    const features = ["bracket-a", "web-c", "rib-b"];
    expect(out).toEqual({
      save: { meta: { dirty: false, path: "D:/parts/bracket.funda", features }, saves: ["D:/parts/bracket.funda"] },
      saveAs: { meta: { dirty: false, path: "E:/work/hinge-v2.funda", features }, saves: ["E:/work/hinge-v2.funda"] },
    });
  });

  it("an assistant edit that keeps the file still leaves the path on the document", async () => {
    const geo = new Geo();
    const store = userDoc("D:/parts/bracket.funda", geo);
    let open!: () => void;
    host.hold = new Promise<void>((r) => (open = r));
    const saving = saveDocument(store);
    while (!host.invoked.some((c) => c.cmd === "container_save")) await flush();
    store.load(JSON.stringify(plates("bracket-a", "web-c", "rib-b", "boss-d")), { replace: true });
    open();
    await saving;
    expect(meta(store)).toEqual({
      dirty: true,
      path: "D:/parts/bracket.funda",
      features: ["bracket-a", "web-c", "rib-b", "boss-d"],
    });
  });
});
