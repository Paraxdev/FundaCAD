// The size rows of the Accessibility Vision group: Interface size picks a zoom step and follows the keys, Comfortable
// text spaces the text out.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import A11ySizeRows from "../../../src/components/overlays/A11ySizeRows.vue";
import { setMacForTest } from "../../../src/input/platform";
import { a11yPrefs, resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";

enableAutoUnmount(afterEach);

const open = () => mount(A11ySizeRows, { attachTo: document.body });
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const trigger = () => $("#prefs-interface-size");
const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
const text = (el: Element) => el.textContent!.trim();

beforeEach(() => resetA11yPrefs());
afterEach(() => setMacForTest(null));

describe("Interface size", () => {
  it("is a combobox named by its label and described by the hint that names the keys", () => {
    setMacForTest(false);
    open();
    const hint = $("#prefs-interface-size-hint");
    expect([trigger().getAttribute("role"), trigger().getAttribute("aria-label")]).toEqual([
      "combobox",
      "Interface size",
    ]);
    expect($("label[for=prefs-interface-size]").textContent).toBe("Interface size");
    expect(trigger().getAttribute("aria-describedby")).toBe("prefs-interface-size-hint");
    expect(text(hint)).toContain("Ctrl+Plus and Ctrl+Minus step it from anywhere in the app, and Ctrl+0 puts it back");
    expect(text(trigger())).toBe("100%");
  });

  it("names the Cmd keys on macOS", () => {
    setMacForTest(true);
    open();
    expect(text($("#prefs-interface-size-hint"))).toContain("⌘+Plus and ⌘+Minus");
  });

  it("offers every zoom step up to 200 and stores the one picked", async () => {
    open();
    trigger().click();
    await flushPromises();
    expect(options().map(text)).toEqual(["80%", "90%", "100%", "110%", "125%", "150%", "175%", "200%"]);
    options()
      .find((o) => text(o) === "125%")!
      .click();
    await flushPromises();
    expect([a11yPrefs().interfaceSize, text(trigger())]).toEqual([125, "125%"]);
  });

  it("shows a size set by the keys or by Reset to defaults", async () => {
    open();
    setA11yPref("interfaceSize", 90);
    await flushPromises();
    expect(text(trigger())).toBe("90%");
    resetA11yPrefs();
    await flushPromises();
    expect(text(trigger())).toBe("100%");
  });
});

describe("Comfortable text", () => {
  const box = () => $<HTMLInputElement>("#prefs-comfortable-text input[type=checkbox]");

  it("is a themed checkbox named by its title and described by its hint", () => {
    open();
    expect(box().closest("label")!.classList.contains("ui-checkbox")).toBe(true);
    expect(text(box().closest("label")!)).toBe("Comfortable text");
    expect(box().getAttribute("aria-describedby")).toBe("prefs-comfortable-text-hint");
    expect(text($("#prefs-comfortable-text-hint"))).toContain("Spaces lines, letters and words further apart");
    expect(box().checked).toBe(false);
  });

  it("stores the choice and shows one made elsewhere or undone by Reset to defaults", async () => {
    open();
    box().click();
    await flushPromises();
    expect([a11yPrefs().comfortableText, box().checked]).toEqual([true, true]);
    resetA11yPrefs();
    await flushPromises();
    expect(box().checked).toBe(false);
    setA11yPref("comfortableText", true);
    await flushPromises();
    expect(box().checked).toBe(true);
  });
});
