// The Interface size chords reach the setting from anywhere in the page, a text field included, and nothing under
// them sees the key: not the field, not a tool's own capture listener such as the pattern count's Minus.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installKeyboard } from "../../src/app/keyboard";
import { a11yPrefs, resetA11yPrefs } from "../../src/ui/a11yPrefs";
import { setMacForTest } from "../../src/input/platform";
import type { Engine } from "../../src/app/engine";

const engine = () =>
  ({
    sketch: { active: false },
    tools: {},
    handleAction: () => {},
    viewport: { clearSelection: () => {}, cycleAreaFilter: () => false },
    toolBusy: () => false,
    store: { document: { features: [] } },
  }) as unknown as Engine;

const press = (target: EventTarget, key: string, code: string, mods: KeyboardEventInit = { ctrlKey: true }) => {
  const ev = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(ev);
  return ev;
};

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  resetA11yPrefs();
  installKeyboard(engine());
});
afterEach(() => setMacForTest(null));

describe("Interface size keys", () => {
  it("step and reset the size from inside a text field, which never sees the key", () => {
    setMacForTest(false);
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const heard = vi.fn();
    field.addEventListener("keydown", heard);
    const ev = press(field, "=", "Equal");
    expect(ev.defaultPrevented).toBe(true);
    expect(a11yPrefs().interfaceSize).toBe(110);
    press(field, "-", "Minus");
    press(field, "-", "Minus");
    expect(a11yPrefs().interfaceSize).toBe(90);
    press(field, "0", "Digit0");
    expect(a11yPrefs().interfaceSize).toBe(100);
    expect(heard).not.toHaveBeenCalled();
  });

  it("keep a tool that listens later in the capture phase from reading the Minus", () => {
    setMacForTest(false);
    const tool = vi.fn();
    window.addEventListener("keydown", tool, true);
    press(document.body, "-", "Minus");
    window.removeEventListener("keydown", tool, true);
    expect(a11yPrefs().interfaceSize).toBe(90);
    expect(tool).not.toHaveBeenCalled();
  });

  it("use Cmd on macOS and leave Ctrl alone there", () => {
    setMacForTest(true);
    press(document.body, "=", "Equal", { metaKey: true });
    expect(a11yPrefs().interfaceSize).toBe(110);
    const ev = press(document.body, "=", "Equal", { ctrlKey: true });
    expect([ev.defaultPrevented, a11yPrefs().interfaceSize]).toEqual([false, 110]);
  });
});
