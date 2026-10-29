import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import RailButton from "../../../src/components/ui/RailButton.vue";
import { setMacForTest } from "../../../src/input/platform";

afterEach(() => setMacForTest(null));

const hint = () => mount(RailButton, { props: { icon: "search", label: "Search", keys: "Ctrl F" } });

describe("rail key hint", () => {
  it("shows the Command glyph on macOS", () => {
    setMacForTest(true);
    const w = hint();
    expect(w.findAll("kbd").map((k) => k.text())).toEqual(["⌘", "F"]);
    expect(w.attributes("title")).toBe("Search (⌘ F)");
  });

  it("shows Ctrl elsewhere", () => {
    setMacForTest(false);
    const w = hint();
    expect(w.findAll("kbd").map((k) => k.text())).toEqual(["Ctrl", "F"]);
    expect(w.attributes("title")).toBe("Search (Ctrl F)");
  });
});

describe("rail button tip", () => {
  it("shows the tip as the tooltip and keeps the label as the name", () => {
    const w = mount(RailButton, {
      props: { icon: "caretDown", label: "Surface Texture", tip: "Surface Texture, 2 tools" },
    });
    expect([w.attributes("title"), w.attributes("aria-label")]).toEqual([
      "Surface Texture, 2 tools",
      "Surface Texture",
    ]);
  });

  it("draws the icon at the size asked for", () => {
    const w = mount(RailButton, { props: { icon: "caretDown", label: "Group", iconSize: 18 } });
    expect(w.get(".rail-tile svg").attributes("width")).toBe("18");
  });
});
