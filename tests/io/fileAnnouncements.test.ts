// Open, save and export say their result through the announcer, naming the file and not its folder.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { blake2b128Hex } from "../../src/document/blake2b";
import type { GeometryBackend } from "../../src/geometry/client";
import { DEFAULT_SETTINGS } from "../../src/io/exportSettings";
import { stubBackend, box } from "../document/storeKit";

const host = vi.hoisted(() => ({
  said: [] as string[],
  toasts: [] as { message: string; kind: string | undefined }[],
  savePath: "C:\\a\\b.funda" as string | null,
  modals: [] as string[],
}));
vi.mock("../../src/ui/announce", () => ({ announce: (text: string) => void host.said.push(text) }));
vi.mock("../../src/ui/toast", () => ({
  toast: (message: string, o?: { kind?: string }) => {
    host.toasts.push({ message, kind: o?.kind });
    return null;
  },
  dismissToast() {},
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) =>
    cmd === "container_open_bytes"
      ? {
          document: JSON.stringify({ version: 10, parameters: {}, features: [] }),
          wasContainer: true,
          repairedShards: 0,
          usedBackupIndex: false,
        }
      : undefined,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: async () => {}, save: async () => host.savePath }));
vi.mock("../../src/io/recentFiles", () => ({ noteRecent() {}, forgetRecent() {}, getRecentFiles: () => [] }));
vi.mock("../../src/ui/choice", () => ({
  choose: async () => null,
  listModal: async (title: string) => void host.modals.push(title),
}));
vi.mock("../../src/stores/exportDialog", () => ({
  useExportDialogStore: () => ({
    open: async () => ({ settings: { ...DEFAULT_SETTINGS, format: "step" }, scope: "all" }),
  }),
}));

const { saveDocument, saveDocumentAs, openDocumentText, openDocumentBytes, exportModel } =
  await import("../../src/io/files");

const globals = globalThis as unknown as Record<string, unknown>;

function desktop() {
  globals.window = {
    __TAURI_INTERNALS__: {},
    addEventListener() {},
    removeEventListener() {},
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

function browser() {
  globals.window = { addEventListener() {}, removeEventListener() {} };
  globals.document = { createElement: () => ({ href: "", download: "", click() {} }) };
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => {};
}

function edited(): DocumentStore {
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  store.addFeature(box("a-plate", 40));
  return store;
}

describe("open, save and export results spoken", () => {
  beforeEach(() => {
    host.said = [];
    host.toasts = [];
    host.modals = [];
    host.savePath = "C:\\a\\b.funda";
  });

  it("a desktop Save As and Save speak the file name of a Windows or a POSIX path", async () => {
    desktop();
    const store = edited();
    await saveDocumentAs(store);
    host.savePath = "/home/me/parts/c.funda";
    await saveDocumentAs(store);
    store.addFeature(box("b-plate", 20));
    await saveDocument(store);
    expect(host.said).toEqual(["Saved b.funda", "Saved c.funda", "Saved c.funda"]);
  });

  it("a desktop Save As cancelled in its dialog says nothing", async () => {
    desktop();
    host.savePath = null;
    await saveDocumentAs(edited());
    expect(host.said).toEqual([]);
  });

  it("a browser Save As speaks the downloaded name, a refused one only shows its error", async () => {
    browser();
    await saveDocumentAs(edited());
    const imported = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    imported.load(
      JSON.stringify({
        version: 10,
        parameters: {},
        features: [{ id: "f1", type: "import", format: "step", name: "bracket.step", geom: "0".repeat(32) }],
      }),
    );
    await saveDocumentAs(imported);
    expect({ said: host.said, errors: host.toasts.filter((t) => t.kind === "error").length }).toEqual({
      said: ["Saved Untitled.funda"],
      errors: 1,
    });
  });

  it("opening document text speaks its name, unless its embedded geometry could not reach the engine", async () => {
    browser();
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    expect(
      await openDocumentText(store, "plate.funda", JSON.stringify({ version: 10, parameters: {}, features: [] })),
    ).toBe("ok");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const embedded = JSON.stringify({
      version: 10,
      parameters: {},
      features: [],
      geometry: { [blake2b128Hex(bytes)]: btoa(String.fromCharCode(...bytes)) },
    });
    expect(await openDocumentText(store, "bracket.funda", embedded)).toBe("ok");
    expect({ said: host.said, errors: host.toasts.filter((t) => t.kind === "error").length }).toEqual({
      said: ["Opened plate.funda"],
      errors: 1,
    });
  });

  it("a document dropped on the desktop app speaks its name once it has opened", async () => {
    desktop();
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    expect(await openDocumentBytes(store, new File(["x"], "dropped.funda"))).toBe("ok");
    expect(host.said).toEqual(["Opened dropped.funda"]);
  });

  it("an export speaks the title of the list it shows, with warnings when a feature was left out", async () => {
    desktop();
    host.savePath = "D:/out/part.step";
    const replies = [
      { ok: true, path: "D:/out/part.step" },
      {
        ok: true,
        paths: ["D:/out/part-a.step", "D:/out/part-b.step"],
        warnings: [{ feature_id: "f2", message: "open profile" }],
      },
    ];
    const backend = {
      rebuild: async () => ({ ok: true, result: { bodies: [], errors: [] } }),
      export: async () => replies.shift(),
    } as unknown as GeometryBackend;
    const store = new DocumentStore(backend, { parameters: {}, features: [] });
    await exportModel(store, backend);
    await exportModel(store, backend);
    expect({ said: host.said, modals: host.modals }).toEqual({
      said: ["Exported 1 file", "Exported 2 files, with warnings"],
      modals: ["Exported 1 file", "Exported 2 files, with warnings"],
    });
  });
});
