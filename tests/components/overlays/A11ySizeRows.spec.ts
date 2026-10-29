// The size rows of the Accessibility Vision group: Interface size picks a zoom step up to the cap and follows the keys.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import A11ySizeRows from "../../../src/components/overlays/A11ySizeRows.vue";
import { setMacForTest } from "../../../src/input/platform";
import { a11yPrefs, resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";

enableAutoUnmount(afterEach);

const open = () => mount(A11ySizeRows, { attachTo: document.body });
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
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
