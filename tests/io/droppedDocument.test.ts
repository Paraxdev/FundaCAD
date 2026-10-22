// A document dropped on the desktop app as bytes, with no path: macOS and Linux
// always, Windows when WebView2 does not name the path. It has to open the way
// File > Open does, through Rust, or embedded geometry is lost and a .fundab is
// read as text.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";

// Mocked once for the file: a doMock per test raced vitest's mock queue against the
// fundaLinks import an open leaves loading, so a later open got the real Tauri core.
const host = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: unknown }[],
  reported: [] as string[],
  toasts: [] as { message: string; kind: string | undefined }[],
  dismissed: [] as number[],
  reply: (): unknown => undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    host.invoked.push({ cmd, args });
    return host.reply();
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: async (m: string) => void host.reported.push(m) }));
vi.mock("../../src/app/documentActions", () => ({ mayDiscard: async () => true }));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, opts: { kind?: string } = {}) => host.toasts.push({ message, kind: opts.kind }),
  dismissToast: (id: number) => void host.dismissed.push(id),
}));
vi.mock("../../src/io/recentFiles", () => ({ noteRecent() {}, forgetRecent() {}, getRecentFiles: () => [] }));
vi.mock("../../src/io/recovery", () => ({ clearRecovery: async () => {} }));

const DROPPED = JSON.stringify({ version: 9, parameters: { dropped: 10 }, features: [] });

describe("a document dropped as bytes in the desktop app", () => {
  beforeEach(() => {
    host.invoked = [];
    host.reported = [];
    host.toasts = [];
    host.dismissed = [];
    host.reply = () => ({ document: DROPPED, repairedShards: 0, usedBackupIndex: false, wasContainer: true });
    // Never removed: the store's param commit chain outlives the test, and
    // deleting the stub under that chain threw on slower CI runners.
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });

  function setup() {
    const importBytes = vi.fn(async () => ({ ok: false, message: "stub" }));
    const geometry = {
      async rebuild() { return { ok: false, error: { message: "stub" } }; },
      async init() {}, onStatus() { return () => {}; }, connected: true,
      async migrateGeometry() { return []; },
      importBytes,
    } as unknown as GeometryBackend;
    const store = new DocumentStore(geometry, { parameters: {}, features: [] });
    store.markSaved("D:/work/previous.funda");
    return { store, geometry, importBytes, engine: { store, geometry, sketch: { hasUncommittedEdits: false } } as never };
  }

  const binary = () => new Uint8Array([0x46, 0x55, 0x4e, 0x44, 0x41, 0xff, 0xfe, 0x00, 0x80]);

  it("is read by Rust from its raw bytes, not decoded as text", async () => {
    const { takeDroppedFiles } = await import("../../src/io/desktopDrop");
    const { store, engine } = setup();
    await takeDroppedFiles(engine, [{ name: "part.fundab", path: null, file: new File([binary()], "part.fundab") }]);

    expect(host.reported).toEqual([]);
    expect(host.invoked.map((c) => c.cmd)).toEqual(["container_open_bytes"]);
    expect(Array.from(host.invoked[0]!.args as Uint8Array)).toEqual(Array.from(binary()));
    expect(store.document.parameters).toEqual({ dropped: 10 });
  });

  it("shows its name, stays clean and never saves to the bare name or the previous file", async () => {
    const { takeDroppedFiles } = await import("../../src/io/desktopDrop");
    const { store, engine } = setup();
    await takeDroppedFiles(engine, [{ name: "part.fundab", path: null, file: new File([binary()], "part.fundab") }]);

    expect(host.reported).toEqual([]);
    expect(store.filePath).toBeNull();
    expect(store.fileName).toBe("part.fundab");
    expect(store.dirty).toBe(false);
    store.newDocument();
    expect(store.fileName).toBe("Untitled");
  });

  it("says once what a newer file holds that this version leaves out, stays clean, and takes it down on the next open", async () => {
    host.reply = () => ({
      document: JSON.stringify({ version: 99, parameters: {}, features: [{ id: "w1", type: "futureWidget" }] }),
      repairedShards: 0, usedBackupIndex: false, wasContainer: true,
    });
    const { takeDroppedFiles } = await import("../../src/io/desktopDrop");
    const { store, engine } = setup();
    await takeDroppedFiles(engine, [{ name: "newer.funda", path: null, file: new File(["{}"], "newer.funda") }]);

    expect(host.reported).toEqual([]);
    expect(host.toasts).toEqual([{
      message: "Opened a file from a newer version of FundaCAD. 1 feature was not included because this version does not know it: futureWidget. It is kept and saved with the file. Bodies after it may differ. Update FundaCAD to build it.",
      kind: "warning",
    }]);
    expect(store.dirty).toBe(false);

    store.newDocument();
    expect(host.dismissed).toEqual([1]);
    store.newDocument();
    expect(host.dismissed).toEqual([1]);
  });

  it("hands the sections of a .fundab this version does not read back to the save", async () => {
    const carried = [{ kind: 9, name: "futureIndex", hash: "0123456789abcdef0123456789abcdef" }];
    host.reply = () => ({ document: DROPPED, repairedShards: 0, usedBackupIndex: false, wasContainer: true, carried });
    const { openDocumentAtPath, saveDocument } = await import("../../src/io/files");
    const { store } = setup();
    const outcome = await openDocumentAtPath(store, "D:/work/newer.fundab");
    expect({ outcome, reported: host.reported }).toEqual({ outcome: "ok", reported: [] });
    expect(store.carriedSections).toEqual(carried);

    await saveDocument(store);
    const save = host.invoked.find((c) => c.cmd === "container_save");
    expect((save?.args as { carried: unknown }).carried).toEqual(carried);

    store.newDocument();
    expect(store.carriedSections).toEqual([]);
  });

  it("offers the save every hash shaped string a feature this version does not know names", async () => {
    const blob = "0123456789abcdef0123456789abcdef";
    host.reply = () => ({
      document: JSON.stringify({ version: 99, parameters: {}, features: [{ id: "w1", type: "futureWidget", blob }] }),
      repairedShards: 0, usedBackupIndex: false,
    });
    const { openDocumentAtPath, saveDocument } = await import("../../src/io/files");
    const { store } = setup();
    const outcome = await openDocumentAtPath(store, "D:/work/newer.funda");
    expect({ outcome, reported: host.reported }).toEqual({ outcome: "ok", reported: [] });

    await saveDocument(store);
    const save = host.invoked.find((c) => c.cmd === "container_save")?.args as { hashes: string[]; optionalHashes: string[] };
    expect(save.hashes).toEqual([]);
    expect(save.optionalHashes).toEqual([blob]);
  });

  it("keeps the open document and imports nothing when Rust refuses it", async () => {
    host.reply = () => { throw "This document is damaged and cannot be opened."; };
    const { takeDroppedFiles } = await import("../../src/io/desktopDrop");
    const { store, engine, importBytes } = setup();
    await takeDroppedFiles(engine, [
      { name: "bad.funda", path: null, file: new File(["junk"], "bad.funda") },
      { name: "b.stl", path: null, file: new File(["solid x\nendsolid x\n"], "b.stl") },
    ]);

    expect(host.reported).toEqual(["Couldn't open bad.funda: This document is damaged and cannot be opened."]);
    expect(importBytes).not.toHaveBeenCalled();
    expect(store.filePath).toBe("D:/work/previous.funda");
    expect(store.document.parameters).toEqual({});
  });
});
