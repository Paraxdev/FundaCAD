import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import KeyChip from "../../../src/components/ui/KeyChip.vue";
import RailButton from "../../../src/components/ui/RailButton.vue";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
afterEach(() => setMacForTest(null));

describe("KeyChip", () => {
  it("draws one kbd per key through fmtKeys", () => {
    setMacForTest(true);
    const w = mount(KeyChip, { props: { keys: "Ctrl+Shift+Z" } });
    expect([w.classes(), w.findAll("kbd").map((k) => k.text())]).toEqual([["key-chip"], ["⌘", "Shift", "Z"]]);
  });

  it("stays readable on its own, where the keys are the content", () => {
    const w = mount(KeyChip, { props: { keys: "Ctrl S" } });
    expect(w.attributes("aria-hidden")).toBeUndefined();
  });

  it("hides from screen readers when the owner's title already says the keys", () => {
    const w = mount(KeyChip, { props: { keys: "Ctrl S", inTitle: true } });
    expect(w.attributes("aria-hidden")).toBe("true");
  });

  it("is hidden inside a rail button, whose title and label carry the keys", () => {
    setMacForTest(false);
    const w = mount(RailButton, { props: { icon: "search", label: "Search", keys: "Ctrl F" } });
    expect([w.attributes("aria-label"), w.find(".key-chip").attributes("aria-hidden")]).toEqual([
      "Search (Ctrl F)",
      "true",
    ]);
  });
});
