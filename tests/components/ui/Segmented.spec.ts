import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import Segmented from "../../../src/components/ui/Segmented.vue";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
afterEach(() => setMacForTest(null));

type V = "mm" | "cm" | "in" | "ft";
type Opt = { value: V; label?: string; icon?: string; tip?: string; keys?: string; disabled?: boolean };

const units = (disabled: V[] = []): Opt[] =>
  (["mm", "cm", "in", "ft"] as V[]).map((value) => ({ value, label: value, disabled: disabled.includes(value) }));

async function render(props: { options: Opt[]; modelValue: V; iconOnly?: boolean; disabled?: boolean; size?: "sm" }) {
  const w = mount(Segmented<V>, {
    props: { label: "Units", ...props, "onUpdate:modelValue": (v: V) => w.setProps({ modelValue: v }) },
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return w;
}
type W = Awaited<ReturnType<typeof render>>;

const radios = (w: W) => w.findAll('[role="radio"]');
const stops = (w: W) => radios(w).map((b) => b.attributes("tabindex"));
const checked = (w: W) => radios(w).map((b) => b.attributes("aria-checked"));
const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.trim();
const emitted = (w: W) => (w.emitted<[V]>("update:modelValue") ?? []).map(([v]) => v);

async function press(key: string) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  await flushPromises();
  return e.defaultPrevented;
}

describe("Segmented", () => {
  it("is a radiogroup with one Tab stop, on the checked radio", async () => {
    const w = await render({ options: units(), modelValue: "cm" });
    expect([w.attributes("role"), w.attributes("aria-label")]).toEqual(["radiogroup", "Units"]);
    expect(checked(w)).toEqual(["false", "true", "false", "false"]);
    expect(stops(w)).toEqual(["-1", "0", "-1", "-1"]);
    expect(radios(w)[1]!.classes("is-selected")).toBe(true);
  });

  it("moves and picks with the arrows, wrapping at both ends", async () => {
    const w = await render({ options: units(), modelValue: "in" });
    (radios(w)[2]!.element as HTMLElement).focus();
    expect(await press("ArrowRight")).toBe(true);
    expect([focused(), checked(w), stops(w)]).toEqual([
      "ft",
      ["false", "false", "false", "true"],
      ["-1", "-1", "-1", "0"],
    ]);
    await press("ArrowRight");
    await press("ArrowLeft");
    await press("ArrowLeft");
    expect(emitted(w)).toEqual(["ft", "mm", "ft", "in"]);
    expect(focused()).toBe("in");
  });

  it("jumps to the ends with Home and End", async () => {
    const w = await render({ options: units(), modelValue: "cm" });
    (radios(w)[1]!.element as HTMLElement).focus();
    await press("End");
    expect(focused()).toBe("ft");
    await press("Home");
    expect([focused(), emitted(w)]).toEqual(["mm", ["ft", "mm"]]);
  });

  it("skips a disabled option with the arrows and refuses a click on it", async () => {
    const w = await render({ options: units(["cm", "ft"]), modelValue: "mm" });
    (radios(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight");
    expect(focused()).toBe("in");
    await press("ArrowRight");
    expect(focused()).toBe("mm");
    await radios(w)[1]!.trigger("click");
    expect(radios(w)[1]!.attributes("aria-disabled")).toBe("true");
    expect(emitted(w)).toEqual(["in", "mm"]);
  });

  it("picks on click, and a click on the checked option emits nothing", async () => {
    const w = await render({ options: units(), modelValue: "mm" });
    await radios(w)[0]!.trigger("click");
    await radios(w)[2]!.trigger("click");
    expect(emitted(w)).toEqual(["in"]);
  });

  it("names icon only options from their tip and keys", async () => {
    setMacForTest(false);
    const w = await render({
      options: [
        { value: "mm", icon: "grid", tip: "Grid", keys: "G" },
        { value: "cm", icon: "snap", tip: "Snap" },
      ],
      modelValue: "mm",
      iconOnly: true,
      size: "sm",
    });
    expect(w.classes()).toEqual(expect.arrayContaining(["ui-segmented-sm", "ui-segmented-icon"]));
    expect(radios(w).map((r) => [r.attributes("aria-label"), r.attributes("title")])).toEqual([
      ["Grid (G)", "Grid (G)"],
      ["Snap", "Snap"],
    ]);
  });

  it("keeps its Tab stop but picks nothing while the whole group is disabled", async () => {
    const w = await render({ options: units(), modelValue: "mm", disabled: true });
    expect([w.attributes("aria-disabled"), stops(w)]).toEqual(["true", ["0", "-1", "-1", "-1"]]);
    (radios(w)[0]!.element as HTMLElement).focus();
    await press("ArrowRight");
    await radios(w)[2]!.trigger("click");
    expect([focused(), emitted(w)]).toEqual(["mm", []]);
  });

  it("puts an option's attrs on its button, under the group's own role and state", () => {
    const w = mount(Segmented<V>, {
      props: {
        label: "Units",
        modelValue: "mm",
        options: [
          { value: "mm", label: "mm", attrs: { "data-unit": "mm", role: "button" } },
          { value: "cm", label: "cm" },
        ],
      },
    });
    const [mm, cm] = radios(w);
    expect([mm!.attributes("data-unit"), mm!.attributes("role"), mm!.attributes("aria-checked")]).toEqual([
      "mm",
      "radio",
      "true",
    ]);
    expect(cm!.attributes("data-unit")).toBeUndefined();
  });

  it("names the group by labelledby alone when given one", () => {
    const w = mount(Segmented<V>, { props: { labelledby: "units-head", modelValue: "mm", options: units() } });
    expect([w.attributes("aria-label"), w.attributes("aria-labelledby")]).toEqual([undefined, "units-head"]);
  });

  it("warns in a dev build when it has no name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mount(Segmented<V>, { props: { modelValue: "mm", options: units() } as never });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Segmented has no name"))).toBe(true);
    warn.mockRestore();
  });
});
