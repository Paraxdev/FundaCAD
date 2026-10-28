import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import InlineLabel from "../../../src/components/shell/InlineLabel.vue";

enableAutoUnmount(afterEach);

async function editing(rename = vi.fn()) {
  const w = mount(InlineLabel, {
    props: { text: "Sketch 1", rename, renameOnDblclick: true },
    attachTo: document.body,
  });
  await w.get(".tree-label").trigger("dblclick");
  await nextTick();
  return { w, rename, input: w.get<HTMLInputElement>(".tree-label.renaming input") };
}

describe("InlineLabel rename", () => {
  it("opens a focused base text field holding the name", async () => {
    const { input } = await editing();
    expect(input.element.value).toBe("Sketch 1");
    expect(document.activeElement).toBe(input.element);
    expect(input.element.closest(".ui-text-field")).not.toBeNull();
  });

  it("names the field Rename for a screen reader", async () => {
    const { input } = await editing();
    expect(input.attributes("aria-label")).toBe("Rename");
  });

  it("saves the trimmed name on Enter and closes", async () => {
    const { w, rename, input } = await editing();
    await input.setValue("  Plate  ");
    await input.trigger("keydown", { key: "Enter" });
    await nextTick();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("Plate");
    expect(w.find(".renaming").exists()).toBe(false);
  });

  it("cancels on Escape without saving", async () => {
    const { w, rename, input } = await editing();
    await input.setValue("Plate");
    await input.trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(rename).not.toHaveBeenCalled();
    expect(w.get(".tree-label").text()).toBe("Sketch 1");
  });

  it("saves on blur, once, and never an empty or unchanged name", async () => {
    const { w, rename, input } = await editing();
    await input.setValue("Plate");
    await input.trigger("blur");
    await input.trigger("blur");
    await nextTick();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(w.find(".renaming").exists()).toBe(false);

    const again = await editing();
    await again.input.setValue("   ");
    await again.input.trigger("keydown", { key: "Enter" });
    const same = await editing();
    await same.input.trigger("blur");
    expect(again.rename).not.toHaveBeenCalled();
    expect(same.rename).not.toHaveBeenCalled();
  });

  it("keeps keystrokes inside the field", async () => {
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);
    const { input } = await editing();
    await input.trigger("keydown", { key: "e" });
    await input.trigger("keydown", { key: "Escape" });
    document.body.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
  });

  it("stays a plain label without a rename callback", async () => {
    const w = mount(InlineLabel, { props: { text: "Body", renameOnDblclick: true } });
    await w.get(".tree-label").trigger("dblclick");
    expect(w.find("input").exists()).toBe(false);
  });
});
