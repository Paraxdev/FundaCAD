import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

vi.mock("../../../src/ui/announce", () => ({ announce: vi.fn() }));

import Slider from "../../../src/components/ui/Slider.vue";
import { announce } from "../../../src/ui/announce";

enableAutoUnmount(afterEach);
beforeEach(() => vi.mocked(announce).mockClear());

async function render(props: Record<string, unknown>) {
  const w = mount(Slider, {
    props: { modelValue: 20, label: "Opacity", unit: "%", showValue: true, ...props },
    attachTo: document.body,
  });
  await new Promise((r) => setTimeout(r, 2));
  return w;
}
const range = (w: Awaited<ReturnType<typeof render>>) => w.find("input").element as HTMLInputElement;

async function drag(w: Awaited<ReturnType<typeof render>>, ...values: number[]) {
  range(w).dispatchEvent(new Event("pointerdown", { bubbles: true }));
  for (const v of values) {
    range(w).value = String(v);
    range(w).dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
  }
  range(w).dispatchEvent(new Event("change", { bubbles: true }));
  await flushPromises();
}

describe("Slider speech", () => {
  it("keeps the readout out of the live tree, so a drag does not speak every step", async () => {
    const w = await render({});
    expect(w.find("output").attributes("aria-live")).toBe("off");
  });

  it("speaks a pointer drag once, on release, with its label and value", async () => {
    const w = await render({});
    await drag(w, 30, 40, 55);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(vi.mocked(announce).mock.calls[0]?.slice(0, 2)).toEqual(["Opacity 55%", "polite"]);
  });

  it("names an unlabelled slider by its tip", async () => {
    const w = await render({ label: undefined, tip: "Exposure", unit: "EV", min: -5, max: 5, modelValue: 0 });
    await drag(w, 2);
    expect(vi.mocked(announce).mock.calls[0]?.[0]).toBe("Exposure 2 EV");
  });

  it("says nothing for keys or a change no pointer made, which the focused range already speaks", async () => {
    const w = await render({});
    range(w).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await flushPromises();
    range(w).value = "70";
    range(w).dispatchEvent(new Event("input", { bubbles: true }));
    range(w).dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();
    expect(announce).not.toHaveBeenCalled();
  });
});
