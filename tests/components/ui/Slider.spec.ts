import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

import Slider from "../../../src/components/ui/Slider.vue";

enableAutoUnmount(afterEach);

type Props = {
  modelValue: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  showValue?: boolean;
  unit?: string;
  commit?: "live" | "end";
  disabled?: boolean;
  disabledReason?: string;
};

async function render(props: Props) {
  const w = mount(Slider, {
    props: { ...props, "onUpdate:modelValue": (v: number) => w.setProps({ modelValue: v }) },
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return w;
}
type W = Awaited<ReturnType<typeof render>>;

const range = (w: W) => w.find("input").element as HTMLInputElement;
const updates = (w: W) => (w.emitted<[number]>("update:modelValue") ?? []).map(([v]) => v);
const commits = (w: W) => (w.emitted<[number]>("commit") ?? []).map(([v]) => v);

async function drag(w: W, ...values: number[]) {
  for (const v of values) {
    range(w).value = String(v);
    range(w).dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
  }
}
async function release(w: W) {
  range(w).dispatchEvent(new Event("change", { bubbles: true }));
  await flushPromises();
}
async function press(w: W, key: string) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  range(w).dispatchEvent(e);
  await flushPromises();
  return e.defaultPrevented;
}

describe("Slider", () => {
  it("is a native range with the bounds, step and value, named by its label", async () => {
    const w = await render({ modelValue: 4, min: 0, max: 10, step: 0.5, label: "Exposure" });
    expect([range(w).type, range(w).min, range(w).max, range(w).step, range(w).value]).toEqual([
      "range",
      "0",
      "10",
      "0.5",
      "4",
    ]);
    const id = range(w).getAttribute("aria-labelledby");
    expect(document.getElementById(id!)?.textContent).toBe("Exposure");
  });

  it("emits every value live while dragging and commit once on release", async () => {
    const w = await render({ modelValue: 2, max: 10 });
    await drag(w, 3, 5, 7);
    expect([updates(w), commits(w)]).toEqual([[3, 5, 7], []]);
    await release(w);
    expect([updates(w), commits(w)]).toEqual([[3, 5, 7], [7]]);
  });

  it("holds the value back until release with commit end, showing the draft meanwhile", async () => {
    const w = await render({ modelValue: 2, max: 10, commit: "end", showValue: true, unit: "mm" });
    await drag(w, 6, 8);
    expect([updates(w), w.find(".ui-slider-value").text()]).toEqual([[], "8 mm"]);
    await release(w);
    expect([updates(w), commits(w), w.find(".ui-slider-value").text()]).toEqual([[8], [8], "8 mm"]);
  });

  it("steps with the arrows, Page keys, Home and End, clamped, committing each step", async () => {
    const w = await render({ modelValue: 9, min: 0, max: 10, step: 0.5 });
    expect(await press(w, "ArrowRight")).toBe(true);
    await press(w, "ArrowUp");
    await press(w, "ArrowUp");
    await press(w, "ArrowLeft");
    await press(w, "PageDown");
    await press(w, "Home");
    await press(w, "ArrowDown");
    await press(w, "End");
    expect(updates(w)).toEqual([9.5, 10, 9.5, 8.5, 0, 10]);
    expect(commits(w)).toEqual(updates(w));
    expect(range(w).value).toBe("10");
    expect(await press(w, "a")).toBe(false);
  });

  it("refuses drags and keys while disabled and keeps the reason as title", async () => {
    const w = await render({ modelValue: 4, max: 10, disabled: true, disabledReason: "Run first" });
    expect([w.classes("is-disabled"), range(w).getAttribute("aria-disabled"), range(w).disabled]).toEqual([
      true,
      "true",
      false,
    ]);
    expect(w.attributes("title")).toBe("Run first");
    await drag(w, 7);
    await release(w);
    expect(await press(w, "ArrowRight")).toBe(true);
    expect([updates(w), commits(w), range(w).value]).toEqual([[], [], "4"]);
  });

  it("writes a percent readout without the space a unit gets", async () => {
    const w = await render({ modelValue: 40, showValue: true, unit: "%" });
    expect(w.find(".ui-slider-value").text()).toBe("40%");
  });

  it("renders the value slot in place of the readout", async () => {
    const w = mount(Slider, {
      props: { modelValue: 0.25, max: 1, step: 0.05 },
      slots: { value: "<template #value='{ value }'>{{ Math.round(value * 100) }}%</template>" },
    });
    expect(w.find(".ui-slider-value").text()).toBe("25%");
  });
});
