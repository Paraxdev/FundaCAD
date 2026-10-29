import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import Tabs from "../../../src/components/ui/Tabs.vue";
import type { Named } from "../../../src/components/ui/useName";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
afterEach(() => setMacForTest(null));

type T = "a" | "b" | "c";
type Tab = { value: T; label: string; disabled?: boolean; title?: string; tip?: string; keys?: string };

function render(tabs: Tab[], modelValue: T = "a") {
  return mount(Tabs<T>, { props: { tabs, modelValue, label: "Steps" } });
}

type Extra = { variant?: "underline" | "bar" | "nav"; orientation?: "horizontal" | "vertical" } & Named;

async function live(tabs: Tab[], modelValue: T = "a", extra: Extra = { label: "Steps" }) {
  const w = mount(Tabs<T>, {
    props: {
      tabs,
      modelValue,
      ...extra,
      "onUpdate:modelValue": (v: T) => w.setProps({ modelValue: v }),
    },
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return w;
}
type W = Awaited<ReturnType<typeof live>>;

const abc = (disabled: T[] = []): Tab[] =>
  (["a", "b", "c"] as T[]).map((value) => ({ value, label: value.toUpperCase(), disabled: disabled.includes(value) }));
const tabEls = (w: W) => w.findAll("button");
const stops = (w: W) => tabEls(w).map((b) => b.attributes("tabindex"));
const selected = (w: W) => tabEls(w).map((b) => b.attributes("aria-selected"));
const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.trim();
const emitted = (w: W) => (w.emitted<[T]>("update:modelValue") ?? []).map(([v]) => v);

async function press(key: string) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  await flushPromises();
  return e.defaultPrevented;
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
    expect({ selected: t.attributes("aria-selected"), disabled: t.attributes("aria-disabled") }).toEqual({
      selected: "true",
      disabled: undefined,
    });
    await t.trigger("click");
    expect(w.emitted("update:modelValue")).toEqual([["b"]]);
  });

  it("renders a disabled tab aria-disabled with its title live, and it emits nothing on click", async () => {
    const w = render([
      { value: "a", label: "Set up" },
      { value: "b", label: "Results", disabled: true, title: "Run the analysis to see results" },
      { value: "c", label: "Notes", disabled: false },
    ]);
    const [a, b, c] = w.findAll(".float-tab");
    expect(w.findAll(".float-tab").map((t) => [t.text(), t.attributes("aria-disabled") === "true"])).toEqual([
      ["Set up", false],
      ["Results", true],
      ["Notes", false],
    ]);
    expect(b!.attributes("title")).toBe("Run the analysis to see results");
    expect([b!.attributes("disabled"), b!.classes("is-disabled")]).toEqual([undefined, true]);
    expect(b!.attributes("aria-selected")).toBe("false");
    await b!.trigger("click");
    expect(w.emitted("update:modelValue")).toBeUndefined();
    await c!.trigger("click");
    await a!.trigger("click");
    expect(w.emitted("update:modelValue")).toEqual([["c"], ["a"]]);
  });

  it("gives the bar one Tab stop, on the selected tab", async () => {
    const w = await live(abc(), "b");
    expect([stops(w), selected(w)]).toEqual([
      ["-1", "0", "-1"],
      ["false", "true", "false"],
    ]);
  });

  it("moves and picks with ArrowLeft and ArrowRight, wrapping, and jumps with Home and End", async () => {
    const w = await live(abc(), "c");
    (tabEls(w)[2]!.element as HTMLElement).focus();
    expect(await press("ArrowRight")).toBe(true);
    expect([focused(), selected(w), stops(w)]).toEqual(["A", ["true", "false", "false"], ["0", "-1", "-1"]]);
    await press("ArrowLeft");
    expect(focused()).toBe("C");
    await press("Home");
    await press("End");
    expect(emitted(w)).toEqual(["a", "c", "a", "c"]);
    expect(await press("ArrowDown")).toBe(false);
  });

  it("skips a disabled tab with the arrows", async () => {
    const w = await live(abc(["b"]), "a");
    (tabEls(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight");
    expect([focused(), emitted(w)]).toEqual(["C", ["c"]]);
  });

  it("uses ArrowUp and ArrowDown when vertical", async () => {
    const w = await live(abc(), "a", { orientation: "vertical", label: "Steps" });
    expect(w.attributes("aria-orientation")).toBe("vertical");
    (tabEls(w)[0]!.element as HTMLElement).focus();
    await press("ArrowDown");
    expect(await press("ArrowRight")).toBe(false);
    await press("ArrowUp");
    expect(emitted(w)).toEqual(["b", "a"]);
  });

  it("keeps the float-tab classes on the underline look and drops them on the bar look", async () => {
    const u = await live(abc(), "a");
    expect([u.classes("float-tabs"), u.classes("ui-tabs-underline"), tabEls(u)[0]!.classes("active")]).toEqual([
      true,
      true,
      true,
    ]);
    const b = await live(abc(), "a", { variant: "bar", label: "Render" });
    expect([b.classes("float-tabs"), b.classes("ui-tabs-bar"), b.attributes("aria-label")]).toEqual([
      false,
      true,
      "Render",
    ]);
    expect([tabEls(b)[0]!.classes("is-selected"), tabEls(b)[0]!.classes("float-tab")]).toEqual([true, false]);
  });

  it("renders the nav look as a vertical nav with aria-current on the page", async () => {
    const w = await live(abc(), "b", { variant: "nav", label: "Settings" });
    expect([w.element.tagName, w.attributes("role"), w.attributes("aria-label")]).toEqual([
      "NAV",
      undefined,
      "Settings",
    ]);
    expect(
      tabEls(w).map((t) => [t.attributes("role"), t.attributes("aria-selected"), t.attributes("aria-current")]),
    ).toEqual([
      [undefined, undefined, undefined],
      [undefined, undefined, "page"],
      [undefined, undefined, undefined],
    ]);
    (tabEls(w)[1]!.element as HTMLElement).focus();
    await press("ArrowDown");
    expect([focused(), emitted(w)]).toEqual(["C", ["c"]]);
  });

  it("writes a tab's tip and keys through fmtKeys into its title", async () => {
    setMacForTest(true);
    const w = await live([{ value: "a", label: "Views", tip: "Views", keys: "Ctrl+1" }]);
    expect(tabEls(w)[0]!.attributes("title")).toBe("Views (⌘+1)");
  });

  it("names the bar by labelledby alone when given one", async () => {
    const w = await live(abc(), "a", { labelledby: "steps-head" });
    expect([w.attributes("aria-label"), w.attributes("aria-labelledby")]).toEqual([undefined, "steps-head"]);
  });

  it("warns in a dev build when it has no name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount(Tabs<T>, { props: { tabs: abc(), modelValue: "a" } as never });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Tabs has no name"))).toBe(true);
    warn.mockRestore();
  });
});
