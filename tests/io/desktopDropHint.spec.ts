// The drop hint is for files from the desktop. A material swatch is an <img>,
// and Chromium lists "Files" on its drag, so the hint used to open for it.

import { afterEach, describe, expect, it } from "vitest";

import { installDesktopDrop } from "../../src/io/desktopDrop";

function drag(type: string, types: string[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { types, files: [], dropEffect: "none" } });
  return ev;
}

describe("the desktop drop hint", () => {
  let uninstall: () => void = () => {};
  afterEach(() => uninstall());

  function install() {
    const shown: boolean[] = [];
    uninstall = installDesktopDrop({} as never, (s) => shown.push(s));
    return shown;
  }

  it("opens for files dragged in from outside the window", () => {
    const shown = install();
    window.dispatchEvent(drag("dragenter", ["Files"]));
    expect(shown).toEqual([true]);
  });

  it("stays shut for a drag that started in the page, even when it lists Files", () => {
    const shown = install();
    window.dispatchEvent(drag("dragstart", ["Files", "application/x-fundacad-material"]));
    window.dispatchEvent(drag("dragenter", ["Files", "application/x-fundacad-material"]));
    window.dispatchEvent(drag("dragover", ["Files", "application/x-fundacad-material"]));
    expect(shown).not.toContain(true);
  });

  it("opens again for a desktop drag after an in-page drag ended", () => {
    const shown = install();
    window.dispatchEvent(drag("dragstart", ["Files"]));
    window.dispatchEvent(drag("dragend", ["Files"]));
    window.dispatchEvent(drag("dragenter", ["Files"]));
    expect(shown.at(-1)).toBe(true);
  });
});
