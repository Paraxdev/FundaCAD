// A crash snapshot is dropped only for work the user gave up by Discard or Don't save. A plugin's doc_new asks the same
// question, and a Cancel keeps the document and its snapshot.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { stubBackend, box } from "../document/storeKit";

const host = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: Record<string, unknown> }[],
  pick: "discard" as string | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    host.invoked.push({ cmd, args });
  },
}));
vi.mock("../../src/ui/choice", () => ({ choose: async () => host.pick }));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));

const { installAutosave, slotFor } = await import("../../src/io/recovery");
const { mayDiscard } = await import("../../src/app/documentActions");
const { appHost } = await import("../../src/plugins/broker/appHost");

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const noSketch = { hasUncommittedEdits: false } as never;

function editedFile() {
  const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
  installAutosave(store);
  store.markSaved("D:/parts/a.funda");
  store.addFeature(box("a-plate", 40));
  return store;
}

async function clears(act: () => Promise<unknown> | void) {
  host.invoked = [];
  await act();
  await flush();
  return host.invoked.filter((c) => c.cmd === "recovery_clear").map((c) => c.args.slot);
}

const shape = (store: DocumentStore) => ({
  features: store.document.features.map((f) => f.id),
  path: store.filePath,
  dirty: store.dirty,
});

describe("the crash snapshot of a document that ends unsaved", () => {
  beforeEach(() => {
    host.pick = "discard";
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  });

  it("follows the answer to a plugin's doc_new, kept on Cancel and dropped on Discard", async () => {
    const store = editedFile();
    host.pick = "cancel";
    const kept = await clears(() =>
      appHost({ store })
        .perform("doc_new", {})
        .catch(() => {}),
    );
    const after = shape(store);
    host.pick = "discard";
    const dropped = await clears(() => appHost({ store }).perform("doc_new", {}));
    expect({ kept, after, dropped, last: shape(store) }).toEqual({
      kept: [],
      after: { features: ["a-plate"], path: "D:/parts/a.funda", dirty: true },
      dropped: [slotFor("D:/parts/a.funda"), slotFor(null)],
      last: { features: [], path: null, dirty: false },
    });
  });

  it("is dropped when the user says Discard, and the document after it keeps its own", async () => {
    const store = editedFile();
    const discarded = await clears(async () => {
      if (await mayDiscard({ store, sketch: noSketch }, "Discard?")) store.newDocument();
    });
    store.addFeature(box("b-plate", 20));
    const unasked = await clears(() => store.newDocument());
    expect({ discarded, unasked, last: shape(store) }).toEqual({
      discarded: [slotFor("D:/parts/a.funda"), slotFor(null)],
      unasked: [],
      last: { features: [], path: null, dirty: false },
    });
  });

  it("is kept on Cancel, and when an edit follows the Discard before the document ends", async () => {
    const store = editedFile();
    host.pick = "cancel";
    const cancelled = await clears(async () => {
      if (await mayDiscard({ store, sketch: noSketch }, "Discard?")) store.newDocument();
    });
    const kept = shape(store);
    host.pick = "discard";
    await mayDiscard({ store, sketch: noSketch }, "Discard?");
    store.addFeature(box("a-more", 5));
    const editedSince = await clears(() => store.newDocument());
    expect({ cancelled, kept, editedSince, last: shape(store) }).toEqual({
      cancelled: [],
      kept: { features: ["a-plate"], path: "D:/parts/a.funda", dirty: true },
      editedSince: [],
      last: { features: [], path: null, dirty: false },
    });
  });
});
