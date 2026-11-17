// A palette sync from the printer writes the English default slot name, whatever the language, so the next sync
// compares like with like and finds no difference. Only the confirmation text is worded in the language.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { setLanguage } from "../../src/i18n";
import { stubBackend } from "../document/storeKit";

const h = vi.hoisted(() => ({
  choose: vi.fn(async (_question: string, _options?: unknown) => "apply" as string),
  toast: vi.fn(),
}));

vi.mock("fundacad", async () => ({
  choose: h.choose,
  toast: h.toast,
  contribute: () => () => {},
  pluginText: (await import("../../src/i18n")).pluginText,
}));
vi.mock("../../plugins/FundaCAD.Printing/printerClient", () => ({
  activePrinterId: () => "u1",
  printerProbe: async () => ({ online: true }),
  printerFilaments: async () => [
    { index: 0, vendor: "", material: "", sub_type: "", color: "#d23b30", present: true },
    { index: 1, vendor: "Polymaker", material: "PLA", sub_type: "", color: "#2255cc", present: true },
  ],
  asPrinterError: () => null,
}));

const { filamentSource } = await import("../../plugins/FundaCAD.Printing/main");

beforeEach(() => {
  h.choose.mockClear();
  h.toast.mockClear();
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
});
afterEach(async () => {
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
  await setLanguage("system");
});

describe("the palette sync from the printer", () => {
  it("stores Toolhead 1 in German and a second sync shows no difference", async () => {
    await setLanguage("de");
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    const source = filamentSource();

    expect(await source.sync(store)).toBe(true);
    expect(h.choose).not.toHaveBeenCalled();
    expect(store.colorPalette[0]?.name).toBe("Toolhead 1");
    expect(store.colorPalette[1]?.name).toBe("Polymaker PLA");

    expect(await source.sync(store)).toBe(true);
    expect(h.choose).toHaveBeenCalledTimes(1);
    expect(h.choose.mock.calls[0]?.[0]).toBe("Palette vom Drucker synchronisieren?");
  });

  it("words a changed slot in the language and keeps the other names as saved", async () => {
    await setLanguage("de");
    const store = new DocumentStore(stubBackend, { parameters: {}, features: [] });
    store.replacePaletteSlots([{ name: "Toolhead 1", color: "#000000" }]);
    await filamentSource().sync(store);
    expect(h.choose.mock.calls[0]?.[0]).toContain("Slot 1: Werkzeugkopf 1 → Werkzeugkopf 1");
    expect(store.colorPalette[0]?.name).toBe("Toolhead 1");
  });
});
