import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h, mergeProps } from "vue";

import { useDisabled } from "../../../src/components/ui/useDisabled";

enableAutoUnmount(afterEach);

const Probe = defineComponent({
  props: { disabled: Boolean, disabledReason: String, title: String },
  emits: ["act"],
  setup(props, { emit }) {
    const d = useDisabled(props);
    const act = d.guard(() => emit("act"));
    return () =>
      h("button", mergeProps(d.bind.value, { type: "button", title: d.title(props.title), onClick: act }), [
        h("span", { class: "inner" }, "Go"),
      ]);
  },
});

async function render(props: { disabled?: boolean; disabledReason?: string; title?: string } = {}) {
  const onClick = vi.fn();
  const onKeydown = vi.fn();
  const w = mount(Probe, { props, attrs: { onClick, onKeydown }, attachTo: document.body });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return { w, onClick, onKeydown };
}

describe("useDisabled", () => {
  it("leaves an enabled control alone", async () => {
    const { w, onClick } = await render({ title: "Save" });
    expect([w.attributes("aria-disabled"), w.classes("is-disabled"), w.attributes("title")]).toEqual([
      undefined,
      false,
      "Save",
    ]);
    await w.trigger("click");
    expect([onClick.mock.calls.length, w.emitted("act")?.length]).toEqual([1, 1]);
  });

  it("marks a disabled control with aria-disabled and .is-disabled, never the native attribute", async () => {
    const { w } = await render({ disabled: true, title: "Save" });
    expect([w.attributes("aria-disabled"), w.classes("is-disabled"), w.attributes("disabled")]).toEqual([
      "true",
      true,
      undefined,
    ]);
  });

  it("keeps the title live, and the reason replaces it only while disabled", async () => {
    const { w } = await render({ disabled: true, title: "Save", disabledReason: "Nothing to save" });
    expect(w.attributes("title")).toBe("Nothing to save");
    await w.setProps({ disabled: false });
    expect(w.attributes("title")).toBe("Save");
    await w.setProps({ disabled: true, disabledReason: "" });
    expect(w.attributes("title")).toBe("Save");
  });

  it("swallows a click on the control or inside it, before the parent's listener", async () => {
    const { w, onClick } = await render({ disabled: true });
    await w.trigger("click");
    await w.find(".inner").trigger("click");
    expect([onClick.mock.calls.length, w.emitted("act")]).toEqual([0, undefined]);
  });

  it("swallows Enter and Space activation but lets Tab and arrows through", async () => {
    const { w, onKeydown } = await render({ disabled: true });
    const keys = ["Enter", " ", "Tab", "ArrowRight"].map((key) => {
      const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      w.element.dispatchEvent(e);
      return [key, e.defaultPrevented];
    });
    expect(keys).toEqual([
      ["Enter", true],
      [" ", true],
      ["Tab", false],
      ["ArrowRight", false],
    ]);
    expect(onKeydown.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(["Tab", "ArrowRight"]);
  });

  it("follows the prop as it changes", async () => {
    const { w, onClick } = await render({ disabled: true });
    await w.setProps({ disabled: false });
    await w.trigger("click");
    expect([w.attributes("aria-disabled"), onClick.mock.calls.length]).toEqual([undefined, 1]);
  });
});
