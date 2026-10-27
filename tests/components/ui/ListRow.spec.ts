import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import ListRow from "../../../src/components/ui/ListRow.vue";

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
