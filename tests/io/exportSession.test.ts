// An export its document's end stops is not written, and the user is told so rather than left waiting for a file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { SessionEnded } from "../../src/document/session";
import type { GeometryBackend } from "../../src/geometry/client";
import { DEFAULT_SETTINGS } from "../../src/io/exportSettings";

const ui = vi.hoisted(() => ({ toasts: [] as string[], reported: [] as string[] }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: async () => "D:/out/part.step",
  message: async (m: string) => void ui.reported.push(m),
}));
vi.mock("../../src/ui/choice", () => ({ choose: async () => null, listModal: async () => {} }));
vi.mock("../../src/stores/exportDialog", () => ({
  useExportDialogStore: () => ({
    open: async () => ({ settings: { ...DEFAULT_SETTINGS, format: "step" }, scope: "all" }),
  }),
}));
vi.mock("../../src/ui/toast", () => ({ toast: (m: string) => ui.toasts.push(m), dismissToast: () => {} }));

const { exportModel } = await import("../../src/io/files");

describe("an export when its document ends", () => {
  beforeEach(() => {
    ui.toasts = [];
    ui.reported = [];
    (globalThis as unknown as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {},
      addEventListener() {},
      removeEventListener() {},
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  for (const how of ["rejected", "cancelled"] as const) {
    it(`says the file was not written when the engine's answer is ${how}`, async () => {
      let started!: () => void;
      const running = new Promise<void>((r) => (started = r));
      const backend = {
        rebuild: async () => ({ ok: true, result: { bodies: [], errors: [] } }),
        export: async () => {
          started();
          await new Promise((r) => setTimeout(r, 5));
          if (how === "rejected") throw new SessionEnded();
          return { ok: false, cancelled: true, message: "export cancelled" };
        },
      } as unknown as GeometryBackend;
      const store = new DocumentStore(backend, { parameters: {}, features: [] });
      const done = exportModel(store, backend);
      await running;
      store.newDocument();
      await done;
      expect({ toasts: ui.toasts, reported: ui.reported }).toEqual({
        toasts: ["part.step was not written, its document was closed during the export."],
        reported: [],
      });
    });
  }
});
