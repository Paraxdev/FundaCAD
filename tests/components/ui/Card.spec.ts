import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";

import Card from "../../../src/components/ui/Card.vue";

enableAutoUnmount(afterEach);

describe("Card", () => {
  it("is labelled by its title and holds the head actions, body and foot", () => {
    const w = mount(Card, {
      props: { title: "History" },
      slots: { default: "<p>Body</p>", "head-actions": '<i class="act"></i>', foot: '<i class="ft"></i>' },
      attachTo: document.body,
    });
    const title = document.getElementById(w.attributes("aria-labelledby")!);
    expect(title?.textContent).toBe("History");
    expect(w.find(".float-card-head .act").exists()).toBe(true);
    expect(w.find(".float-card-body").text()).toBe("Body");
    expect(w.find(".float-card-foot .ft").exists()).toBe(true);
    expect(w.find(".ui-card-toggle").exists()).toBe(false);
  });

  it("draws no foot without one", () => {
    const w = mount(Card, { props: { title: "History" } });
    expect(w.find(".float-card-foot").exists()).toBe(false);
  });

  it("collapsible: the title is a button with aria-expanded that folds the body and emits the model", async () => {
    const w = mount(Card, { props: { title: "Members", collapsible: true }, slots: { default: "<p>Body</p>" } });
    const t = w.find(".ui-card-toggle");
    const body = w.find(".float-card-body");
    expect([t.attributes("type"), t.attributes("aria-expanded"), t.attributes("aria-controls")]).toEqual([
      "button",
      "true",
      body.attributes("id"),
    ]);
    await t.trigger("click");
    expect([t.attributes("aria-expanded"), w.classes("is-collapsed"), body.attributes("style")]).toEqual([
      "false",
      true,
      "display: none;",
    ]);
    expect(w.emitted("update:collapsed")).toEqual([[true]]);
    await t.trigger("click");
    expect([t.attributes("aria-expanded"), w.emitted("update:collapsed")?.[1]]).toEqual(["true", [false]]);
  });

  it("follows a collapsed prop from its owner", async () => {
    const w = mount(Card, { props: { title: "Members", collapsible: true, collapsed: true } });
    expect(w.find(".ui-card-toggle").attributes("aria-expanded")).toBe("false");
    await w.setProps({ collapsed: false });
    expect(w.find(".ui-card-toggle").attributes("aria-expanded")).toBe("true");
  });
});
