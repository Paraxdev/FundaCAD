import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";
import type { Engine } from "../../src/app/engine";
import { Home, homeIsOpen, type HomeCallbacks } from "../../src/ui/home";

const h = vi.hoisted(() => ({ picked: null as string | null, asked: [] as string[], reported: [] as string[] }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: async () => h.picked,
  message: async (m: string) => void h.reported.push(m),
}));
vi.mock("../../src/ui/choice", () => ({
  choose: async (question: string) => {
    h.asked.push(question);
    return null;
  },
}));
vi.mock("../../src/ui/toast", () => ({ toast: () => null, dismissToast: () => {} }));

import { openDocument } from "../../src/io/files";
import { createDocumentActions } from "../../src/app/documentActions";

function rig() {
  setActivePinia(createPinia());
  new Home({} as HomeCallbacks).open();
  const importGeometry = vi.fn(async (_path: string) => ({ ok: false, message: "the file has no solids" }));
  const geometry = {
    rebuild: () => new Promise<never>(() => {}),
    async init() {},
    onStatus: () => () => {},
    onProgress: () => () => {},
    importGeometry,
  } as unknown as GeometryBackend;
  const store = new DocumentStore(geometry, { parameters: {}, features: [] } as unknown as CadDocument);
  return { store, geometry, importGeometry };
}

beforeEach(() => {
  h.asked = [];
  h.reported = [];
  (globalThis as unknown as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {},
    addEventListener() {},
    removeEventListener() {},
  };
});

describe("Open… with a part", () => {
  it("hands the file name and its import to the caller", async () => {
    const { store, geometry, importGeometry } = rig();
    h.picked = "D:/downloads/printer frame.stp.gz";
    const mayReplace = vi.fn(async () => true);
    const placed: string[][] = [];
    await openDocument(store, geometry, mayReplace, async (names, run) => {
      placed.push(names);
      await run();
    });
    expect(placed).toEqual([["printer frame.stp.gz"]]);
    expect(importGeometry.mock.calls.map((c) => c[0])).toEqual(["D:/downloads/printer frame.stp.gz"]);
    expect(mayReplace).not.toHaveBeenCalled();
  });

  it("opens a document without the placer", async () => {
    const { store, geometry } = rig();
    h.picked = "E:/jigs/Bracket.funda";
    const place = vi.fn();
    await openDocument(store, geometry, async () => false, place);
    expect(place).not.toHaveBeenCalled();
  });

  it("closes Home and imports when no placer is given", async () => {
    const { store, geometry, importGeometry } = rig();
    h.picked = "D:/downloads/motor.step";
    await openDocument(store, geometry);
    expect(importGeometry).toHaveBeenCalledOnce();
    expect(homeIsOpen()).toBe(false);
  });

  it("from Home over the blank document asks nothing, and a failed import leaves it Untitled", async () => {
    const { store, geometry, importGeometry } = rig();
    h.picked = "D:/downloads/printer.step";
    const e = { store, geometry, sketch: { active: false, hasUncommittedEdits: false } } as unknown as Engine;
    await createDocumentActions(e).openDoc();
    expect(h.asked).toEqual([]);
    expect(importGeometry).toHaveBeenCalledOnce();
    expect([store.fileName, store.document.features, homeIsOpen()]).toEqual(["Untitled", [], false]);
    expect(h.reported.join("\n")).toContain("the file has no solids");
  });
});
