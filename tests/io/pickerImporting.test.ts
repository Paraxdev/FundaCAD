// A file picked in the Open or Import dialog lands in the document open when the dialog closes, so an assistant's
// doc_set must not replace that document while the dialog is up.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";

const host = vi.hoisted(() => ({
  pick: null as ((path: string | null) => void) | null,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: () => new Promise<string | null>((resolve) => (host.pick = resolve)),
  message: async () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => new Promise(() => {}) }));

function setup() {
  const geometry = {
    async rebuild() {
      return { ok: false, error: { message: "stub" } };
    },
    async init() {},
    onStatus() {
      return () => {};
    },
    connected: true,
  } as unknown as GeometryBackend;
  return new DocumentStore(geometry, { parameters: { gap: 2.75 }, features: [] });
}

async function docSet(store: DocumentStore, param: string): Promise<string> {
  const { appHost } = await import("../../src/plugins/broker/appHost");
  try {
    await appHost({ store }).perform("doc_set", { document: { parameters: { [param]: 4.5 }, features: [] } });
    return "applied";
  } catch (e) {
    return (e as Error).message.includes("import is still being read") ? "refused" : String(e);
  }
}

async function dialogUp() {
  await vi.waitFor(() => expect(host.pick).not.toBeNull());
  const pick = host.pick!;
  host.pick = null;
  return pick;
}

describe("a file dialog counts as an import into the open document", () => {
  beforeEach(() => {
    host.pick = null;
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });

  it("holds back a doc_set while the Import dialog is up and lets it through once it closes", async () => {
    const { importModel } = await import("../../src/io/files");
    const store = setup();
    const running = importModel(store, store.backend);
    const pick = await dialogUp();
    const during = { importRunning: store.importRunning, docSet: await docSet(store, "during") };
    pick(null);
    await running;
    const after = { importRunning: store.importRunning, docSet: await docSet(store, "after") };
    expect({ during, after, parameters: store.document.parameters }).toEqual({
      during: { importRunning: true, docSet: "refused" },
      after: { importRunning: false, docSet: "applied" },
      parameters: { after: 4.5 },
    });
    store.newDocument();
    expect({ importRunning: store.importRunning, docSet: await docSet(store, "next") }).toEqual({
      importRunning: false,
      docSet: "applied",
    });
  });

  it("holds back a doc_set while the Open dialog is up, but not while a picked document is opened", async () => {
    const { openDocument } = await import("../../src/io/files");
    const store = setup();
    const asked: boolean[] = [];
    for (const picked of [null, "D:/work/Gear.funda"]) {
      const running = openDocument(store, store.backend, async () => {
        asked.push(store.importRunning);
        return false;
      });
      const pick = await dialogUp();
      expect(store.importRunning).toBe(true);
      pick(picked);
      await running;
    }
    expect({ asked, importRunning: store.importRunning, docSet: await docSet(store, "after") }).toEqual({
      asked: [false],
      importRunning: false,
      docSet: "applied",
    });
  });
});
