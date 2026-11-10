import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { fitScale, MIN_FIT_SCALE, useFitText } from "../../src/composables/useFitText";

enableAutoUnmount(afterEach);

describe("fitScale", () => {
  it("keeps a line that fits, up to the exact width, and never grows one", () => {
    expect([fitScale(32, 20), fitScale(32, 32), fitScale(32, 0), fitScale(0, 20), fitScale(32, NaN)]).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  it("shrinks a longer line by the ratio, rounded down so it never spills", () => {
    expect([fitScale(32, 33), fitScale(32, 40), fitScale(32, 52.8, 0), fitScale(35.5, 71, 0)]).toEqual([
      0.969, 0.8, 0.606, 0.5,
    ]);
  });

  it("stops at the floor, three quarters unless told otherwise", () => {
    expect([MIN_FIT_SCALE, fitScale(32, 64), fitScale(32, 52.8), fitScale(32, 64, 0.6)]).toEqual([
      0.75, 0.75, 0.75, 0.6,
    ]);
  });
});

// A monospaced label 6.6 px a character at full size, in a box with a 40 px min-width and 4 px padding a side.
const CHAR = 6.6;
const host = (text: ReturnType<typeof ref<string>>, style = "min-width: 40px; padding: 0 4px") =>
  defineComponent({
    setup() {
      const box = ref<HTMLElement | null>(null);
      const label = ref<HTMLElement | null>(null);
      useFitText(
        () => box.value,
        () => label.value,
        "--label-scale",
        () => text.value ?? "",
      );
      return () => h("div", { ref: box, style }, [h("span", { ref: label, class: "label" }, text.value)]);
    },
  });

function mountWith(initial: string, style?: string) {
  const text = ref(initial);
  const w = mount(host(text, style), { attachTo: document.body });
  const box = w.element as HTMLElement;
  const label = w.get(".label").element as HTMLElement;
  const scale = () => box.style.getPropertyValue("--label-scale");
  // The width shrinks with the scale in force, as a real label's does.
  Object.defineProperty(label, "scrollWidth", {
    get: () => Math.round((label.textContent ?? "").length * CHAR * (Number(scale()) || 1)),
  });
  return { text, scale };
}

async function show(text: { value: string | undefined }, value: string) {
  text.value = value;
  await nextTick();
  await nextTick();
}

describe("useFitText", () => {
  it("shrinks a reading too wide for its box and lets a short one back to full size", async () => {
    const { text, scale } = mountWith("1mm");
    await show(text, "0.01mm");
    const shrunk = scale();
    await show(text, "5mm");
    expect([shrunk, scale()]).toEqual([String(fitScale(32, Math.round(6 * CHAR))), ""]);
  });

  it("holds a reading too long for the room at the floor, for the box to grow around", async () => {
    const { text, scale } = mountWith("1mm");
    await show(text, "0.0005mm");
    expect(scale()).toBe(String(MIN_FIT_SCALE));
  });

  it("measures at full size, so a second fit of an equally long reading lands on the same scale", async () => {
    const { text, scale } = mountWith("2mm");
    await show(text, "0.02mm");
    const first = scale();
    await show(text, "0.05mm");
    expect([first, scale()]).toEqual(["0.8", "0.8"]);
  });

  it("keeps four characters at full size in the 32 px room and shrinks the fifth, which spills by one pixel", async () => {
    const { text, scale } = mountWith("1mm");
    await show(text, "1234");
    const four = scale();
    await show(text, "12345");
    expect([four, scale()]).toEqual(["", "0.969"]);
  });

  it("takes the border out of the room as well as the padding", async () => {
    const { text, scale } = mountWith("1mm", "min-width: 40px; padding: 0 4px; border: 1px solid");
    await show(text, "0.01mm");
    expect(scale()).toBe(String(fitScale(30, Math.round(6 * CHAR))));
  });
});
