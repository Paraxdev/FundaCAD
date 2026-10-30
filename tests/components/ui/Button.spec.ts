import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import Button from "../../../src/components/ui/Button.vue";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
afterEach(() => setMacForTest(null));

type Props = InstanceType<typeof Button>["$props"];

async function render(props: Props = {}, slot: string | null = "Save") {
  const onClick = vi.fn();
  const slots = slot === null ? { icon: "<i></i>" } : { default: slot };
  const w = mount(Button, { props, attrs: { onClick }, slots, attachTo: document.body });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return { w, onClick };
}

function key(el: Element, key: string) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("Button", () => {
  it("is a type=button secondary md button by default, wearing the .btn alias", async () => {
    const { w } = await render();
    expect(w.element.tagName).toBe("BUTTON");
    expect(w.attributes("type")).toBe("button");
    expect(w.classes()).toEqual(["btn", "btn-secondary", "btn-md"]);
    expect(w.text()).toBe("Save");
  });

  it("takes a submit or reset type when asked", async () => {
    const { w } = await render({ type: "submit" });
    expect(w.attributes("type")).toBe("submit");
  });

  it.each([
    ["primary", "sm", ["btn", "btn-primary", "btn-sm"]],
    ["ghost", "md", ["btn", "btn-ghost", "btn-md"]],
    ["danger", "sm", ["btn", "btn-danger", "btn-sm"]],
  ] as const)("renders the %s variant at size %s", async (variant, size, classes) => {
    const { w } = await render({ variant, size });
    expect(w.classes()).toEqual(classes);
  });

  it("renders a tile without a size, its content laid out by the caller", async () => {
    const w = mount(Button, {
      props: { variant: "tile", size: "sm" },
      slots: { default: "<span class='pic'></span><span class='name'>Plate</span>" },
    });
    expect(w.classes()).toEqual(["btn", "btn-tile"]);
    expect(w.attributes("type")).toBe("button");
    expect(w.find(".btn-label > .pic + .name").text()).toBe("Plate");
  });

  it("spans its container with block", async () => {
    const { w } = await render({ block: true });
    expect(w.classes()).toContain("btn-block");
  });

  it("puts an icon before the label and the trailing slot after it", async () => {
    const w = mount(Button, { props: { icon: "plus" }, slots: { default: "Add", trailing: "<b>3</b>" } });
    expect([...w.element.children].map((c) => c.tagName.toLowerCase() + (c.getAttribute("data-icon") ?? ""))).toEqual([
      "svgplus",
      "span",
      "b",
    ]);
    const slotted = mount(Button, { slots: { icon: "<i class='mine'></i>", default: "Add" } });
    expect(slotted.find(".mine").exists()).toBe(true);
  });

  it("clicks through while enabled", async () => {
    const { w, onClick } = await render({ tip: "Save" });
    await w.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders disabled as aria-disabled and .is-disabled, never native, and keeps the title live", async () => {
    const { w } = await render({ disabled: true, tip: "Save" });
    expect([w.attributes("aria-disabled"), w.classes("is-disabled"), w.attributes("disabled")]).toEqual([
      "true",
      true,
      undefined,
    ]);
    expect(w.attributes("title")).toBe("Save");
  });

  it("shows the disabled reason as the title while disabled", async () => {
    const { w } = await render({ disabled: true, tip: "Save", disabledReason: "Nothing changed" });
    expect([w.attributes("title"), w.attributes("aria-label")]).toEqual(["Nothing changed", undefined]);
    await w.setProps({ disabled: false });
    expect(w.attributes("title")).toBe("Save");
  });

  it("swallows a click and Enter or Space while disabled, but not Tab", async () => {
    const { w, onClick } = await render({ disabled: true });
    await w.trigger("click");
    await w.find("span").trigger("click");
    const keys = ["Enter", " ", "Tab"].map((k) => key(w.element, k));
    expect([onClick.mock.calls.length, keys]).toEqual([0, [true, true, false]]);
  });

  it("sets aria-pressed and .is-on only when pressed is passed", async () => {
    const plain = await render();
    expect(plain.w.attributes("aria-pressed")).toBeUndefined();
    const { w } = await render({ pressed: false });
    expect([w.attributes("aria-pressed"), w.classes("is-on")]).toEqual(["false", false]);
    await w.setProps({ pressed: true });
    expect([w.attributes("aria-pressed"), w.classes("is-on")]).toEqual(["true", true]);
  });

  it("says popup and expanded instead of pressed when popup is set, keeping the on look", async () => {
    const { w } = await render({ popup: "dialog", pressed: true });
    expect([w.attributes("aria-haspopup"), w.attributes("aria-expanded"), w.attributes("aria-pressed")]).toEqual([
      "dialog",
      "false",
      undefined,
    ]);
    expect(w.classes("is-on")).toBe(true);
    await w.setProps({ expanded: true });
    expect(w.attributes("aria-expanded")).toBe("true");
    await w.setProps({ popup: true });
    expect(w.attributes("aria-haspopup")).toBe("true");
  });

  it("writes no popup state without popup, even when expanded is passed", async () => {
    const { w } = await render({ expanded: true, pressed: false });
    expect([w.attributes("aria-haspopup"), w.attributes("aria-expanded"), w.attributes("aria-pressed")]).toEqual([
      undefined,
      undefined,
      "false",
    ]);
  });

  it("names an icon only button by the tip alone and hands the keys to the title and aria-keyshortcuts", async () => {
    setMacForTest(true);
    const mac = await render({ tip: "Save", keys: "Ctrl+S" }, null);
    const attrs = (w: typeof mac.w) => ["title", "aria-label", "aria-keyshortcuts"].map((a) => w.attributes(a));
    expect(attrs(mac.w)).toEqual(["Save (⌘+S)", "Save", "Meta+S"]);
    setMacForTest(false);
    const pc = await render({ tip: "Save", keys: "Ctrl+S" }, null);
    expect(attrs(pc.w)).toEqual(["Save (Ctrl+S)", "Save", "Control+S"]);
  });

  it("writes the tip as title only when a visible label names the button", async () => {
    setMacForTest(false);
    const { w } = await render({ tip: "Save the file", keys: "Ctrl+S" });
    expect([w.attributes("title"), w.attributes("aria-label"), w.text(), w.attributes("aria-keyshortcuts")]).toEqual([
      "Save the file (Ctrl+S)",
      undefined,
      "Save",
      "Control+S",
    ]);
  });

  it("writes no title or aria-label without a tip, so the label names it", async () => {
    const { w } = await render();
    expect([w.attributes("title"), w.attributes("aria-label")]).toEqual([undefined, undefined]);
  });
});
