import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { fitScale, useFitText } from "../../src/composables/useFitText";

enableAutoUnmount(afterEach);

describe("fitScale", () => {
  it("keeps a line that fits, up to the exact width, and never grows one", () => {
    expect([fitScale(32, 20), fitScale(32, 32), fitScale(32, 0), fitScale(0, 20), fitScale(32, NaN)]).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  it("shrinks a longer line by the ratio, rounded down so it never spills", () => {
    expect([fitScale(32, 33), fitScale(32, 64), fitScale(32, 52.8), fitScale(35.5, 71)]).toEqual([
      0.969, 0.5, 0.606, 0.5,
    ]);
  });
});

// A monospaced label 6.6 px a character at full size, in a 40 px box with 4 px padding a side.
const CHAR = 6.6;
const host = (text: ReturnType<typeof ref<string>>) =>
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
      return () =>
        h("div", { ref: box, style: "padding: 0 4px" }, [h("span", { ref: label, class: "label" }, text.value)]);
    },
  });

function mountWith(initial: string) {
  const text = ref(initial);
  const w = mount(host(text), { attachTo: document.body });
  const box = w.element as HTMLElement;
  const label = w.get(".label").element as HTMLElement;
  const scale = () => box.style.getPropertyValue("--label-scale");
  Object.defineProperty(box, "clientWidth", { get: () => 40 });
  // The width shrinks with the scale in force, as a real label's does.
  Object.defineProperty(label, "scrollWidth", {
    get: () => Math.round((label.textContent ?? "").length * CHAR * (Number(scale()) || 1)),
  });
  return { text, scale };
}

describe("useFitText", () => {
  it("shrinks a reading too wide for its box and lets a short one back to full size", async () => {
    const { text, scale } = mountWith("1mm");
    text.value = "0.0005mm";
    await nextTick();
    await nextTick();
    expect(scale()).toBe(String(fitScale(32, Math.round(8 * CHAR))));
    text.value = "5mm";
    await nextTick();
    await nextTick();
    expect(scale()).toBe("");
  });

  it("measures at full size, so a second fit of an equally long reading lands on the same scale", async () => {
    const { text, scale } = mountWith("2mm");
    text.value = "0.0002mm";
    await nextTick();
    await nextTick();
    const first = scale();
    text.value = "0.0005mm";
    await nextTick();
    await nextTick();
    expect([first, scale()]).toEqual(["0.603", "0.603"]);
  });

  it("keeps four characters at full size in the 32 px room and shrinks the fifth, which spills by one pixel", async () => {
    const { text, scale } = mountWith("1mm");
    text.value = "1234";
    await nextTick();
    await nextTick();
    const four = scale();
    text.value = "12345";
    await nextTick();
    await nextTick();
    expect([four, scale()]).toEqual(["", "0.969"]);
  });
});
