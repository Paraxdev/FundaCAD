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

  it("titles itself with an h2 by default and the level asked for", () => {
    const w = mount(Card, { props: { title: "History" } });
    const h = w.find("h2.float-card-title");
    expect([h.text(), h.attributes("id")]).toEqual(["History", w.attributes("aria-labelledby")]);
    const deep = mount(Card, { props: { title: "Members", level: 3 } });
    expect([deep.find("h3").text(), deep.find("h2").exists()]).toEqual(["Members", false]);
  });

  it("collapsible: the heading holds the toggle, so heading keys still reach it", () => {
    const w = mount(Card, { props: { title: "Members", collapsible: true } });
    const h = w.find("h2");
    expect([h.attributes("id"), h.find("button.ui-card-toggle").exists()]).toEqual([
      w.attributes("aria-labelledby"),
      true,
    ]);
    expect(h.text()).toBe("Members");
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
