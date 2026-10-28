import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import MenuBar from "../../../src/components/shell/MenuBar.vue";

enableAutoUnmount(afterEach);

const menus = [
  { label: "File", items: [{ label: "New", onClick: () => {} }] },
  { label: "Edit", items: [{ label: "Undo", onClick: () => {} }] },
];

describe("menubar buttons", () => {
  it("are ghost buttons that say which menu is open", async () => {
    const w = mount(MenuBar, { props: { menus }, attachTo: document.body });
    const [file, edit] = w.findAll(".menu-btn");
    expect([file!.attributes("type"), file!.classes()]).toEqual(["button", expect.arrayContaining(["btn-ghost"])]);
    expect([file!.attributes("aria-expanded"), edit!.attributes("aria-expanded")]).toEqual(["false", "false"]);
    await file!.trigger("click");
    expect([file!.attributes("aria-expanded"), file!.classes("is-open")]).toEqual(["true", true]);
    await edit!.trigger("click");
    expect([file!.attributes("aria-expanded"), edit!.attributes("aria-expanded")]).toEqual(["false", "true"]);
    await edit!.trigger("click");
    expect(edit!.attributes("aria-expanded")).toBe("false");
  });
});
