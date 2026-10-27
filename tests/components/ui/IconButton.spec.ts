import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import IconButton from "../../../src/components/ui/IconButton.vue";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);
afterEach(() => setMacForTest(null));

type Props = InstanceType<typeof IconButton>["$props"];

async function render(props: Partial<Props> = {}) {
  const onClick = vi.fn();
  const w = mount(IconButton, {
    props: { icon: "close", tip: "Close", ...props },
    attrs: { onClick },
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return { w, onClick };
}

function key(el: Element, key: string) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("IconButton", () => {
  it("is a type=button lg tile by default, the 40px look of the viewport groups", async () => {
    const { w } = await render();
    expect(w.attributes("type")).toBe("button");
    expect(w.classes()).toEqual(["icon-btn", "icon-btn-tile", "icon-btn-lg"]);
    expect([w.find("svg").attributes("data-icon"), w.find("svg").attributes("width")]).toEqual(["close", "20"]);
  });

  it.each([
    ["plain", "md", ["icon-btn", "icon-btn-plain", "icon-btn-md"], "14"],
    ["danger", "sm", ["icon-btn", "icon-btn-danger", "icon-btn-sm"], "14"],
    ["tile", "lg", ["icon-btn", "icon-btn-tile", "icon-btn-lg"], "20"],
  ] as const)("renders the %s variant at size %s", async (variant, size, classes, icon) => {
    const { w } = await render({ variant, size });
    expect([w.classes(), w.find("svg").attributes("width")]).toEqual([classes, icon]);
  });

  it("takes an icon size of its own", async () => {
    const { w } = await render({ size: "md", iconSize: 12 });
    expect(w.find("svg").attributes("width")).toBe("12");
  });

  it("writes the same title and aria-label from tip and keys through fmtKeys", async () => {
    setMacForTest(true);
    const mac = await render({ tip: "Items", keys: "Ctrl+Alt+S" });
    expect([mac.w.attributes("title"), mac.w.attributes("aria-label")]).toEqual(["Items (⌘+⌥+S)", "Items (⌘+⌥+S)"]);
    setMacForTest(false);
    const pc = await render({ tip: "Items", keys: "Ctrl+Alt+S" });
    expect([pc.w.attributes("title"), pc.w.attributes("aria-label")]).toEqual([
      "Items (Ctrl+Alt+S)",
      "Items (Ctrl+Alt+S)",
    ]);
  });

  it("sets aria-pressed and .active only when active is passed", async () => {
    const plain = await render();
    expect([plain.w.attributes("aria-pressed"), plain.w.classes("active")]).toEqual([undefined, false]);
    const { w } = await render({ active: false });
    expect(w.attributes("aria-pressed")).toBe("false");
    await w.setProps({ active: true });
    expect([w.attributes("aria-pressed"), w.classes("active"), w.classes("is-on")]).toEqual(["true", true, true]);
  });

  it("renders disabled as aria-disabled and .is-disabled, never native, and keeps the title live", async () => {
    const { w } = await render({ disabled: true });
    expect([w.attributes("aria-disabled"), w.classes("is-disabled"), w.attributes("disabled")]).toEqual([
      "true",
      true,
      undefined,
    ]);
    expect([w.attributes("title"), w.attributes("aria-label")]).toEqual(["Close", "Close"]);
  });

  it("shows the disabled reason as the title, the name stays", async () => {
    const { w } = await render({ disabled: true, disabledReason: "Only while sketching" });
    expect([w.attributes("title"), w.attributes("aria-label")]).toEqual(["Only while sketching", "Close"]);
  });

  it("swallows a click, a click on its icon, and Enter or Space while disabled", async () => {
    const { w, onClick } = await render({ disabled: true });
    await w.trigger("click");
    await w.find("svg").trigger("click");
    const keys = ["Enter", " ", "Tab"].map((k) => key(w.element, k));
    expect([onClick.mock.calls.length, keys]).toEqual([0, [true, true, false]]);
    await w.setProps({ disabled: false });
    await w.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows a count badge as an error chip, hidden for null and empty", async () => {
    const { w } = await render({ badge: 3 });
    const badge = w.find(".icon-btn-badge");
    expect([badge.text(), badge.classes()]).toEqual(["3", ["chip", "chip-error", "chip-xs", "icon-btn-badge"]]);
    expect(badge.attributes("aria-hidden")).toBe("true");
    await w.setProps({ badge: null });
    expect(w.find(".icon-btn-badge").exists()).toBe(false);
    await w.setProps({ badge: "" });
    expect(w.find(".icon-btn-badge").exists()).toBe(false);
  });

  it("names the badge count in the label, so a screen reader hears it", async () => {
    const { w } = await render({ tip: "History", badge: 2 });
    expect([w.attributes("title"), w.attributes("aria-label")]).toEqual(["History", "History, 2"]);
  });
});
