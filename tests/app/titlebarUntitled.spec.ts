import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { setLanguage } from "../../src/i18n";
import { DocumentStore } from "../../src/document/store";
import { shownFileName, UNTITLED } from "../../src/document/untitled";
import { installTitlebar } from "../../src/app/titlebar";
import { useUiStore } from "../../src/stores/ui";
import type { CadDocument } from "../../src/types";
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

afterEach(async () => {
  await setLanguage("system");
});

describe("a document without a name", () => {
  let store: DocumentStore;
  beforeEach(() => {
    setActivePinia(createPinia());
    store = new DocumentStore(backend, { parameters: {}, features: [] } as CadDocument);
    installTitlebar({ store, tools: { move: { onHeldChange: () => () => {} } } } as unknown as Engine);
  });

  it("keeps the English name for code and shows it in the chosen language", async () => {
    const ui = useUiStore();
    expect(store.fileName).toBe(UNTITLED);
    expect(ui.docName).toBe("Untitled");
    await setLanguage("de");
    expect(store.fileName).toBe(UNTITLED);
    expect(ui.docName).toBe("Unbenannt");
    await setLanguage("system");
    expect(ui.docName).toBe("Untitled");
  });

  it("leaves a real file's name as it is", async () => {
    await setLanguage("de");
    expect(shownFileName("Untitled.funda")).toBe("Untitled.funda");
    expect(shownFileName("bracket.funda")).toBe("bracket.funda");
  });
});
