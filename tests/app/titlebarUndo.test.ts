import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { DocumentStore } from "../../src/document/store";
import { installTitlebar } from "../../src/app/titlebar";
import { useUiStore } from "../../src/stores/ui";
import type { CadDocument, Feature } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import type { Engine } from "../../src/app/engine";

const backend = {
  async rebuild() {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus() {
    return () => {};
  },
  connected: true,
} as unknown as GeometryBackend;

const doc = (): CadDocument => ({
  parameters: {},
  features: [{ id: "s1", type: "sketch", plane: "XY", entities: [] }] as Feature[],
});

describe("the title bar Undo and Redo buttons", () => {
  let store: DocumentStore;
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    store = new DocumentStore(backend, doc());
    installTitlebar({ store } as unknown as Engine);
  });

  it("follow a material change and its undo, which change no feature", async () => {
    const ui = useUiStore();
    store.setBodiesMaterial(["body1"], "m-brass");
    await Promise.resolve();
    expect(ui.canUndo).toBe(true);
    store.undo();
    await Promise.resolve();
    expect([ui.canUndo, ui.canRedo]).toEqual([false, true]);
    store.redo();
    await Promise.resolve();
    expect([ui.canUndo, ui.canRedo]).toEqual([true, false]);
  });

  it("follow a feature edit and its undo", async () => {
    const ui = useUiStore();
    store.addFeature({ id: "b1", type: "box", length: 1, width: 1, height: 1 } as Feature);
    await Promise.resolve();
    expect([ui.canUndo, ui.canRedo]).toEqual([true, false]);
    store.undo();
    await Promise.resolve();
    expect([ui.canUndo, ui.canRedo]).toEqual([false, true]);
  });
});
