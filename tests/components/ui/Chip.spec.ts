import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import Chip from "../../../src/components/ui/Chip.vue";

enableAutoUnmount(afterEach);

type Props = InstanceType<typeof Chip>["$props"];

async function render(props: Props = {}, slot = "Draft") {
  const onClick = vi.fn();
  const w = mount(Chip, { props, attrs: { onClick }, slots: { default: slot }, attachTo: document.body });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return { w, onClick };
}

describe("Chip", () => {
  it("is a neutral sm span by default, with no button semantics", async () => {
    const { w } = await render();
    expect([w.element.tagName, w.classes(), w.attributes("type"), w.text()]).toEqual([
      "SPAN",
      ["chip", "chip-neutral", "chip-sm"],
      undefined,
      "Draft",
    ]);
  });

  it.each([
    ["accent", "md"],
    ["warn", "sm"],
    ["error", "xs"],
  ] as const)("renders the %s variant at size %s", async (variant, size) => {
    const { w } = await render({ variant, size });
    expect(w.classes()).toEqual(["chip", `chip-${variant}`, `chip-${size}`]);
  });

  it("shows its label when there is no slot, and an icon before it", () => {
    const w = mount(Chip, { props: { label: "Live", icon: "dot" } });
    expect([w.find("svg").attributes("data-icon"), w.text()]).toEqual(["dot", "Live"]);
  });

  it("as a button is type=button and writes title and aria-label from tip and keys", async () => {
    const { w, onClick } = await render({ as: "button", tip: "Filter", keys: "F" });
    expect([w.element.tagName, w.attributes("type"), w.attributes("title"), w.attributes("aria-label")]).toEqual([
      "BUTTON",
      "button",
      "Filter (F)",
      "Filter (F)",
    ]);
    await w.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("as a button swallows its click while disabled and keeps the title", async () => {
    const { w, onClick } = await render({ as: "button", tip: "Filter", disabled: true });
    await w.trigger("click");
    expect([onClick.mock.calls.length, w.attributes("aria-disabled"), w.attributes("title")]).toEqual([
      0,
      "true",
      "Filter",
    ]);
  });

  it("adds a remove IconButton tipped Remove and the label, which emits remove and not the chip click", async () => {
    const w = mount(Chip, { props: { label: "M3", removable: true } });
    const x = w.find("button.icon-btn");
    expect([x.attributes("title"), x.attributes("aria-label")]).toEqual(["Remove M3", "Remove M3"]);
    await x.trigger("click");
    expect(w.emitted("remove")).toEqual([[]]);
  });

  it("keeps a removable button chip valid: no button nested in a button", async () => {
    const { w, onClick } = await render({ as: "button", label: "M3", removable: true, tip: "Edit M3" }, "");
    expect([w.element.tagName, w.findAll("button button")]).toEqual(["SPAN", []]);
    const [body, x] = w.findAll("button");
    expect([body!.attributes("title"), x!.attributes("title")]).toEqual(["Edit M3", "Remove M3"]);
    await body!.trigger("click");
    await x!.trigger("click");
    expect([onClick.mock.calls.length, w.emitted("remove")?.length]).toEqual([1, 1]);
  });

  it("refuses remove while disabled", async () => {
    const { w } = await render({ label: "M3", removable: true, disabled: true });
    await w.find("button.icon-btn").trigger("click");
    expect([w.emitted("remove"), w.classes("is-disabled")]).toEqual([undefined, true]);
  });
});
