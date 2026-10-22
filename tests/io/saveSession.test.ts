// A save writes the document it began with: one finishing after another document was opened never marks that one
// saved, never writes it under the old path, and an autosave of the old document never lands in the new one's slot.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { stubBackend, box } from "../document/storeKit";

const host = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: Record<string, unknown> }[],
  hold: null as Promise<void> | null,
  savePath: "D:/parts/b.funda" as string | null,
  pickHold: null as Promise<void> | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    host.invoked.push({ cmd, args });
    if (cmd === "container_save" && host.hold) await host.hold;
    return undefined;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  message: async () => {},
  save: async () => {
    if (host.pickHold) await host.pickHold;
    return host.savePath;
  },
}));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));
vi.mock("../../src/io/recentFiles", () => ({ noteRecent() {}, forgetRecent() {}, getRecentFiles: () => [] }));

const { saveDocument, saveDocumentAs } = await import("../../src/io/files");
const { installAutosave, slotFor } = await import("../../src/io/recovery");

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

function edited(path: string | null): DocumentStore {
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  if (path) store.markSaved(path);
  store.addFeature(box("a-plate", 40));
  return store;
}

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

describe("a save and the document it began with", () => {
  beforeEach(() => {
    host.invoked = [];
    host.hold = null;
    host.pickHold = null;
    host.savePath = "D:/parts/b.funda";
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  });

  it("Save finishing after New writes the old document only and leaves the new one unsaved", async () => {
    const store = edited("D:/parts/a.funda");
    const g = gate();
    host.hold = g.p;
    const saving = saveDocument(store);
    await flush();
    store.newDocument();
    store.addFeature(box("b-plate", 20));
    g.open();
    await saving;
    const afterFirst = { meta: meta(store), saves: saves() };
    host.hold = null;
    store.newDocument();
    store.addFeature(box("c-plate", 10));
    await saveDocument(store);
    expect({ afterFirst, second: meta(store) }).toEqual({
      afterFirst: {
        meta: { dirty: true, path: null, features: ["b-plate"] },
        saves: [{ path: "D:/parts/a.funda", features: ["a-plate"] }],
      },
      second: { dirty: false, path: "D:/parts/b.funda", features: ["c-plate"] },
    });
  });

  it("Save in the same document marks it saved", async () => {
    const store = edited("D:/parts/a.funda");
    await saveDocument(store);
    expect({ meta: meta(store), saves: saves() }).toEqual({
      meta: { dirty: false, path: "D:/parts/a.funda", features: ["a-plate"] },
      saves: [{ path: "D:/parts/a.funda", features: ["a-plate"] }],
    });
  });

  it("Save As whose path was picked after Open writes nothing, one picked in the same document writes it", async () => {
    const store = edited(null);
    const g = gate();
    host.pickHold = g.p;
    const saving = saveDocumentAs(store);
    await flush();
    store.newDocument();
    g.open();
    await saving;
    const closed = { meta: meta(store), saves: saves() };
    host.pickHold = null;
    store.addFeature(box("b-plate", 20));
    await saveDocumentAs(store);
    expect({ closed, same: { meta: meta(store), saves: saves() } }).toEqual({
      closed: { meta: { dirty: false, path: null, features: [] }, saves: [] },
      same: {
        meta: { dirty: false, path: "D:/parts/b.funda", features: ["b-plate"] },
        saves: [{ path: "D:/parts/b.funda", features: ["b-plate"] }],
      },
    });
  });

  it("an autosave timer of the old document never fires after New, the new document's own does", async () => {
    vi.useFakeTimers();
    try {
      const store = edited("D:/parts/a.funda");
      installAutosave(store);
      store.addFeature(box("a-more", 5));
      vi.advanceTimersByTime(10_000);
      store.newDocument();
      vi.advanceTimersByTime(200_000);
      await flush();
      const afterNew = host.invoked.filter((c) => c.cmd === "recovery_write").length;
      store.addFeature(box("b-plate", 20));
      vi.advanceTimersByTime(200_000);
      await flush();
      const writes = host.invoked
        .filter((c) => c.cmd === "recovery_write")
        .map((c) => JSON.parse(String(c.args.json)).doc.features.map((f: { id: string }) => f.id));
      expect({ afterNew, writes }).toEqual({ afterNew: 0, writes: [["b-plate"]] });
    } finally {
      vi.useRealTimers();
    }
  });
  it("a document given up by New or Open drops its recovery slot, a clean one and a reload keep theirs", async () => {
    const store = edited("D:/parts/a.funda");
    installAutosave(store);
    const clears = async (act: () => void) => {
      host.invoked = [];
      act();
      await flush();
      return host.invoked.filter((c) => c.cmd === "recovery_clear").map((c) => c.args.slot);
    };
    const discarded = await clears(() => store.newDocument());
    const clean = await clears(() => store.newDocument());
    store.addFeature(box("b-plate", 20));
    const reloaded = await clears(() => store.sessions.begin("reload"));
    const opened = await clears(() => store.load(JSON.stringify({ parameters: {}, features: [box("c-plate", 9)] })));
    store.markSaved("D:/parts/c.funda");
    const reopened = await clears(() => store.load(JSON.stringify({ parameters: {}, features: [] })));
    expect({ discarded, clean, reloaded, opened, reopened }).toEqual({
      discarded: [slotFor("D:/parts/a.funda"), slotFor(null)],
      clean: [],
      reloaded: [],
      opened: [slotFor(null), slotFor(null)],
      reopened: [],
    });
  });

  it("an autosave whose document is given up while it starts writes nothing, one in the next document writes", async () => {
    vi.useFakeTimers();
    try {
      const store = edited("D:/parts/a.funda");
      installAutosave(store);
      store.addFeature(box("a-more", 5));
      vi.advanceTimersByTime(200_000);
      store.newDocument();
      await flush();
      const afterNew = host.invoked.filter((c) => c.cmd === "recovery_write").length;
      store.addFeature(box("b-plate", 20));
      vi.advanceTimersByTime(200_000);
      await flush();
      const writes = host.invoked.filter((c) => c.cmd === "recovery_write").map((c) => c.args.slot);
      expect({ afterNew, writes }).toEqual({ afterNew: 0, writes: [slotFor(null)] });
    } finally {
      vi.useRealTimers();
    }
  });
});
