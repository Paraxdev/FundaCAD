// Insert > FundaCAD Document waits on a dialog, a choice and a file read. A document opened during any of them
// never receives the insert, while an insert finished in the same document lands as its import step.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import { box, stubBackend } from "../document/storeKit";

const host = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  toasts: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd !== "container_open") return undefined;
    if (host.hold) await host.hold;
    return JSON.stringify({ parameters: {}, features: [{ id: "lid", type: "box", length: 5, width: 5, height: 1 }] });
  },
}));
vi.mock("@tauri-apps/api/path", () => ({ tempDir: async () => "T:/", join: async (a: string, b: string) => a + b }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => "D:/parts/lid.funda", message: async () => {} }));
vi.mock("../../src/ui/choice", () => ({ choose: async () => "append" }));
vi.mock("../../src/ui/toast", () => ({
  toast: (m: string) => void host.toasts.push(m),
  dismissToast: () => {},
}));

const { insertDocumentFromDialog } = await import("../../src/io/fundaLinks");

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const engine = {
  ...stubBackend,
  async export(_d: unknown, _f: string, path: string) {
    return { ok: true, path };
  },
  async importGeometry() {
    return { ok: true, geom: "h-lid", name: "lid", solid: true, faces: 6 };
  },
} as unknown as GeometryBackend;

const steps = (store: DocumentStore) => store.document.features.map((f) => `${f.type}:${f.id}`);

describe("inserting a FundaCAD document and the document session", () => {
  beforeEach(() => {
    host.hold = null;
    host.toasts = [];
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });

  it("a New while the file is read inserts nothing anywhere, an insert in the same document lands", async () => {
    const store = new DocumentStore(engine, { parameters: {}, features: [box("a-plate", 40)] });
    let open!: () => void;
    host.hold = new Promise<void>((r) => (open = r));
    const inserting = insertDocumentFromDialog(store, engine).catch((e: Error) => e.name);
    await flush();
    store.newDocument();
    store.addFeature(box("b-plate", 20));
    open();
    const outcome = await inserting;
    await flush();
    const afterNew = { outcome, steps: steps(store), toasts: [...host.toasts] };
    host.hold = null;
    await insertDocumentFromDialog(store, engine);
    expect({ afterNew, same: steps(store), toasts: host.toasts }).toEqual({
      afterNew: { outcome: "SessionEnded", steps: ["box:b-plate"], toasts: [] },
      same: ["box:b-plate", expect.stringMatching(/^import:/)],
      toasts: ["Appended lid"],
    });
    store.newDocument();
    expect(steps(store)).toEqual([]);
  });
});
