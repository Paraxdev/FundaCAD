import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import Tabs from "../../../src/components/ui/Tabs.vue";

enableAutoUnmount(afterEach);

type T = "a" | "b" | "c";

function render(tabs: { value: T; label: string; disabled?: boolean; title?: string }[], modelValue: T = "a") {
  return mount(Tabs<T>, { props: { tabs, modelValue } });
}

describe("Tabs", () => {
  it("renders an empty bar for no tabs", () => {
    const w = render([]);
    expect(w.findAll(".float-tab")).toEqual([]);
    expect(w.find(".float-tabs").attributes("role")).toBe("tablist");
  });

  it("emits the value of the one enabled tab clicked", async () => {
    const w = render([{ value: "b", label: "Only" }], "b");
    const t = w.find(".float-tab");
    expect({ selected: t.attributes("aria-selected"), disabled: t.attributes("disabled") }).toEqual({
      selected: "true",
      disabled: undefined,
    });
    await t.trigger("click");
    expect(w.emitted("update:modelValue")).toEqual([["b"]]);
  });

  it("renders a disabled tab disabled with its title, and it emits nothing on click", async () => {
    const w = render([
      { value: "a", label: "Set up" },
      { value: "b", label: "Results", disabled: true, title: "Run the analysis to see results" },
      { value: "c", label: "Notes", disabled: false },
    ]);
    const [a, b, c] = w.findAll(".float-tab");
    expect(w.findAll(".float-tab").map((t) => [t.text(), t.attributes("disabled") !== undefined])).toEqual([
      ["Set up", false],
      ["Results", true],
      ["Notes", false],
    ]);
    expect(b!.attributes("title")).toBe("Run the analysis to see results");
    expect(b!.attributes("aria-selected")).toBe("false");
    await b!.trigger("click");
    expect(w.emitted("update:modelValue")).toBeUndefined();
    await c!.trigger("click");
    await a!.trigger("click");
    expect(w.emitted("update:modelValue")).toEqual([["c"], ["a"]]);
  });
});
