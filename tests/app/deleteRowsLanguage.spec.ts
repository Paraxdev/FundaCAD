// The delete message and its Undo button speak the chosen language, and a step keeps its number across a switch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/ui/announce", () => ({ announce: vi.fn() }));

import { createPinia, setActivePinia } from "pinia";
import { deleteRows } from "../../src/app/featureRows";
import { createDocumentActions } from "../../src/app/documentActions";
import { setLanguage } from "../../src/i18n";
import de from "../../src/i18n/locales/de.json";
import ja from "../../src/i18n/locales/ja.json";
import { useToastStore } from "../../src/stores/toasts";
import { opened } from "../document/storeKit";
import type { DocumentStore } from "../../src/document/store";
import type { Engine } from "../../src/app/engine";
import type { Feature } from "../../src/types";

const FEATURES = [
  { id: "a", type: "box", length: 40.5, width: 22.25, height: 7 },
  { id: "b", type: "box", length: 12.5, width: 9, height: 3.25 },
  { id: "m", type: "move", dx: 10, dy: -4.5, dz: 2, rx: 0, ry: 0, rz: 30, bodies: ["body1"] },
  { id: "n", type: "box", length: 3.5, width: 4.5, height: 5.5, name: "Bracket" },
] as unknown as Feature[];

function rig(store: DocumentStore = opened({ features: FEATURES })) {
  const e = {
    store,
    selectFeature: () => {},
    sketch: { active: false, undoEdit: () => false, redoEdit: () => false },
    tools: { move: { pending: false, cancel: () => {} }, extrude: { profileSketches: [] } },
    ui: { panels: { undoStress: () => false, redoStress: () => false } },
  } as unknown as Engine;
  Object.assign(e, createDocumentActions(e));
  return { e, store };
}

const toasts = () => useToastStore().items.map((t) => ({ message: t.message, action: t.action?.label }));
const ids = (s: DocumentStore) => s.document.features.map((f) => f.id);

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(async () => {
  await setLanguage("system");
});

describe("deleteRows in German", () => {
  beforeEach(async () => {
    await setLanguage("de");
  });

  it("says nothing for no step the document holds", () => {
    const { e, store } = rig();
    deleteRows(e, []);
    deleteRows(e, ["zz"]);
    expect({ toasts: toasts(), ids: ids(store) }).toEqual({ toasts: [], ids: ["a", "b", "m", "n"] });
  });

  it("names the one step by its German name and number, with the German Undo", () => {
    const { e, store } = rig();
    deleteRows(e, ["b"]);
    expect(toasts()).toEqual([{ message: "Quader 2 gelöscht", action: de["command.undo"] }]);
    expect(ids(store)).toEqual(["a", "m", "n"]);
  });

  it("keeps the name the user typed, as typed", () => {
    const { e } = rig();
    deleteRows(e, ["n"]);
    expect(toasts()).toEqual([{ message: "Bracket gelöscht", action: de["command.undo"] }]);
  });

  it("counts three steps, ids the document lacks not counted", () => {
    const { e, store } = rig();
    deleteRows(e, ["a", "m", "n", "zz"]);
    expect(toasts()).toEqual([{ message: "3 Schritte gelöscht", action: de["command.undo"] }]);
    expect(ids(store)).toEqual(["b"]);
  });

  it("brings the steps back with the button, and a second document leaks nothing", () => {
    const first = rig();
    deleteRows(first.e, ["a", "b"]);
    useToastStore().items[0]!.action!.onClick();
    expect(ids(first.store)).toEqual(["a", "b", "m", "n"]);

    useToastStore().items.splice(0);
    const second = rig(opened({ features: [FEATURES[2]!, FEATURES[1]!] }));
    deleteRows(second.e, ["b"]);
    expect(toasts()).toEqual([{ message: "Quader 1 gelöscht", action: de["command.undo"] }]);
    expect(ids(second.store)).toEqual(["m"]);
  });
});

describe("deleteRows in Japanese", () => {
  it("reads for one step and for many, with a plural that has one form", async () => {
    await setLanguage("ja");
    const { e } = rig();
    deleteRows(e, ["b"]);
    deleteRows(e, ["a", "m", "n"]);
    expect(toasts()).toEqual([
      { message: `${ja["feature.box"]} 2を削除しました`, action: ja["command.undo"] },
      { message: "3個のステップを削除しました", action: ja["command.undo"] },
    ]);
  });
});
