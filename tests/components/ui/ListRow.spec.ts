import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import { h } from "vue";
import ListRow from "../../../src/components/ui/ListRow.vue";
import Listbox from "../../../src/components/ui/Listbox.vue";

enableAutoUnmount(afterEach);

const settle = () => new Promise((r) => setTimeout(r, 2));

describe("ListRow", () => {
  it("is a type=button standalone, with its label, hint and icon", () => {
    const w = mount(ListRow, { props: { label: "Version 3", hint: "2 days ago", icon: "clock" } });
    expect([w.element.tagName, w.attributes("type"), w.attributes("role")]).toEqual(["BUTTON", "button", undefined]);
    expect(w.find(".ui-list-row-label").text()).toBe("Version 3");
    expect(w.find(".ui-list-row-hint").text()).toBe("2 days ago");
    expect(w.find('[data-icon="clock"]').exists()).toBe(true);
  });

  it("standalone selected is aria-current and .is-selected", () => {
    const w = mount(ListRow, { props: { label: "A", selected: true } });
    expect([w.attributes("aria-current"), w.classes("is-selected")]).toEqual(["true", true]);
  });

  it("as an option it is role=option with aria-selected, for a listbox", () => {
    const w = mount(ListRow, { props: { label: "A", as: "option", selected: false } });
    expect([w.element.tagName, w.attributes("role"), w.attributes("aria-selected")]).toEqual([
      "DIV",
      "option",
      "false",
    ]);
  });

  it("inside a Listbox takes the listbox's attrs over its own, each row its own", () => {
    const items = [
      { value: "f:7", label: "Flat face 8" },
      { value: "f:9", label: "Flat face 10" },
      { value: "f:12", label: "Hole 13" },
    ];
    const w = mount(Listbox, {
      props: { label: "Faces", multiple: true, items, modelValue: ["f:9"] },
      slots: {
        option: (p: { item: { label: string }; selected: boolean; attrs: object }) =>
          h(ListRow, { ...p.attrs, as: "option", label: p.item.label, selected: p.selected }),
      },
    });
    const rows = w.findAll(".ui-list-row");
    expect(rows.map((r) => [r.attributes("role"), r.attributes("aria-selected"), r.attributes("tabindex")])).toEqual([
      ["option", "false", "-1"],
      ["option", "true", "0"],
      ["option", "false", "-1"],
    ]);
    expect(rows.map((r) => r.classes("is-selected"))).toEqual([false, true, false]);
    expect(new Set(rows.map((r) => r.attributes("id"))).size).toBe(3);
    expect(rows.every((r) => r.attributes("data-roving") === "")).toBe(true);
  });

  it("renders the leading and trailing slots around the text", () => {
    const w = mount(ListRow, {
      props: { label: "A" },
      slots: { leading: '<i class="lead"></i>', trailing: '<i class="trail"></i>' },
    });
    const kids = [...w.element.children].map((c) => c.className);
    expect(kids).toEqual(["lead", "ui-list-row-text", "trail"]);
  });

  it("disabled renders aria-disabled and swallows the click, with the title kept", async () => {
    const onClick = vi.fn();
    const w = mount(ListRow, {
      props: { label: "A", disabled: true, disabledReason: "Locked" },
      attrs: { onClick },
      attachTo: document.body,
    });
    await settle();
    await w.trigger("click");
    expect([
      w.attributes("aria-disabled"),
      w.classes("is-disabled"),
      w.attributes("title"),
      onClick.mock.calls.length,
    ]).toEqual(["true", true, "Locked", 0]);
    await w.setProps({ disabled: false });
    await w.trigger("click");
    expect(onClick.mock.calls.length).toBe(1);
  });
});
