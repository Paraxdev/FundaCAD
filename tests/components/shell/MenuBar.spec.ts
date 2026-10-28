import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import MenuBar from "../../../src/components/shell/MenuBar.vue";
import { escapeClaimed } from "../../../src/ui/escapeClaim";

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

function key(k: string): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
  );
}
const focused = () => document.activeElement?.querySelector(".ui-menu-label")?.textContent ?? null;
const popup = () => document.body.querySelector<HTMLElement>(".ui-menu");
// The claim on Escape is released a task after the close.
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("menubar popups", () => {
  const run = vi.fn();
  const keyed = [
    {
      label: "File",
      items: [
        { label: "Undo", disabled: () => true, onClick: run },
        { label: "Open...", shortcut: "Ctrl+O", onClick: run },
        { label: "", separator: true },
        { label: "Grid", checked: () => true, onClick: run },
      ],
    },
    { label: "View", items: [{ label: "Fit", onClick: run }] },
  ];

  it("ArrowDown on a button opens its menu on the first enabled row, Enter runs it and focus goes back", async () => {
    run.mockClear();
    const w = mount(MenuBar, { props: { menus: keyed }, attachTo: document.body });
    const file = w.get<HTMLElement>(".menu-btn").element;
    file.focus();
    key("ArrowDown");
    await flushPromises();
    expect([popup()?.getAttribute("aria-label"), focused()]).toEqual(["File", "Open..."]);
    const rows = [...popup()!.querySelectorAll<HTMLElement>(".menu-item")];
    expect(rows.map((r) => [r.getAttribute("role"), r.getAttribute("aria-disabled")])).toEqual([
      ["menuitem", "true"],
      ["menuitem", null],
      ["menuitemcheckbox", null],
    ]);
    expect(rows[2]!.getAttribute("aria-checked")).toBe("true");
    key("ArrowDown");
    expect(focused()).toBe("Grid");
    key("o");
    expect(focused()).toBe("Open...");
    key("Enter");
    await flushPromises();
    expect([run.mock.calls.length, popup(), document.activeElement]).toEqual([1, null, file]);
  });

  it("ArrowRight and ArrowLeft on a row walk to the neighbouring menu", async () => {
    const w = mount(MenuBar, { props: { menus: keyed }, attachTo: document.body });
    await w.get(".menu-btn").trigger("click");
    await flushPromises();
    key("ArrowRight");
    await flushPromises();
    expect([popup()?.getAttribute("aria-label"), focused()]).toEqual(["View", "Fit"]);
    key("ArrowRight");
    await flushPromises();
    expect(popup()?.getAttribute("aria-label")).toBe("File");
  });

  it("Escape closes the menu, hands focus back to its button and claims the key until then", async () => {
    const w = mount(MenuBar, { props: { menus: keyed }, attachTo: document.body });
    const view = w.findAll<HTMLElement>(".menu-btn")[1]!;
    view.element.focus();
    key("ArrowDown");
    await flushPromises();
    expect(escapeClaimed()).toBe(true);
    key("Escape");
    await settle();
    expect([popup(), document.activeElement, escapeClaimed()]).toEqual([null, view.element, false]);
  });
});
