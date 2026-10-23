import { beforeEach, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installKeyboard } from "../../src/app/keyboard";
import { useDialogStore } from "../../src/stores/dialogs";
import type { Engine } from "../../src/app/engine";

beforeEach(() => setActivePinia(createPinia()));

it("Ctrl+, closes the shortcuts dialog before opening Preferences", () => {
  installKeyboard({ sketch: { active: false }, handleAction: () => {}, toolBusy: () => false, tools: {}, viewport: {} } as unknown as Engine);
  const d = useDialogStore();
  d.shortcuts = true;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }));
  expect([d.preferences, d.shortcuts]).toEqual([true, false]);
});
