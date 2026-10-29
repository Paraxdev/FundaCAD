import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import MenuBar from "../../../src/components/shell/MenuBar.vue";
import { escapeClaimed } from "../../../src/ui/escapeClaim";
import { inertOthers } from "../../../src/composables/useModalGate";

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
// The claim on Escape is released a task after the menu unmounts, so flush the unmount first: a fixed timer started
// before it raced the release on a loaded runner.
const settle = async () => {
  await flushPromises();
  await new Promise((r) => setTimeout(r, 0));
};

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

  it("Enter in the menu walked to runs its row and hands focus to that menu's button", async () => {
    run.mockClear();
    const w = mount(MenuBar, { props: { menus: keyed }, attachTo: document.body });
    const [file, view] = w.findAll<HTMLElement>(".menu-btn").map((b) => b.element);
    file!.focus();
    key("ArrowDown");
    await flushPromises();
    key("ArrowRight");
    await vi.waitFor(() => expect(focused()).toBe("Fit"));
    key("Enter");
    await flushPromises();
    expect([run.mock.calls.length, popup(), document.activeElement]).toEqual([1, null, view]);
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

describe("menubar roles and keys", () => {
  const four = ["File", "Edit", "View", "Help"].map((label) => ({
    label,
    items: [{ label: `${label} row`, onClick: () => {} }],
  }));
  const mountFour = () => mount(MenuBar, { props: { menus: four }, attachTo: document.body });
  const label = () => document.activeElement?.textContent?.trim() ?? null;

  it("is a labelled nav holding one menubar of menuitems with a single Tab stop", () => {
    const w = mountFour();
    const nav = w.get("nav#menubar");
    expect(nav.attributes("aria-label")).toBe("Menu");
    const bar = w.get('[role="menubar"]');
    expect(bar.attributes("aria-label")).toBe("Menu");
    expect(w.findAll(".menu").map((c) => c.attributes("role"))).toEqual(["none", "none", "none", "none"]);
    const btns = w.findAll(".menu-btn");
    expect(btns.map((b) => [b.attributes("role"), b.attributes("aria-haspopup"), b.attributes("tabindex")])).toEqual([
      ["menuitem", "menu", "0"],
      ["menuitem", "menu", "-1"],
      ["menuitem", "menu", "-1"],
      ["menuitem", "menu", "-1"],
    ]);
    expect(btns[0]!.attributes("aria-pressed")).toBeUndefined();
  });

  it("ArrowRight, ArrowLeft, Home and End move among closed menus without opening one", async () => {
    const w = mountFour();
    w.get<HTMLElement>(".menu-btn").element.focus();
    key("ArrowRight");
    expect([label(), popup()]).toEqual(["Edit", null]);
    key("ArrowLeft");
    key("ArrowLeft");
    expect(label()).toBe("Help");
    key("Home");
    expect(label()).toBe("File");
    key("End");
    expect(label()).toBe("Help");
    await flushPromises();
    expect(w.findAll(".menu-btn").map((b) => b.attributes("tabindex"))).toEqual(["-1", "-1", "-1", "0"]);
  });

  it("ArrowRight in the open File menu goes to Edit, not past it", async () => {
    const w = mountFour();
    w.get<HTMLElement>(".menu-btn").element.focus();
    key("ArrowDown");
    await flushPromises();
    key("ArrowRight");
    await vi.waitFor(() => expect(focused()).toBe("Edit row"));
    expect(popup()?.getAttribute("aria-label")).toBe("Edit");
    key("Escape");
    await settle();
    expect([label(), w.findAll(".menu-btn")[1]!.attributes("tabindex")]).toEqual(["Edit", "0"]);
  });

  it("F10 puts focus on the menu bar's stop and gives it back on a second press", async () => {
    const w = mountFour();
    const out = document.createElement("button");
    document.body.append(out);
    out.focus();
    key("F10");
    expect(label()).toBe("File");
    key("ArrowRight");
    key("F10");
    expect(document.activeElement).toBe(out);
    key("F10");
    expect(label()).toBe("Edit");
    out.remove();
    w.unmount();
  });

  it("F10 closes an open menu and lands on its menu bar item", async () => {
    const w = mountFour();
    await w.findAll(".menu-btn")[2]!.trigger("click");
    await vi.waitFor(() => expect(focused()).toBe("View row"));
    key("F10");
    await vi.waitFor(() => expect(label()).toBe("View"));
    expect(popup()).toBe(null);
  });

  it("F10 leaves focus alone with a modifier, when taken already, or while a dialog holds the page", () => {
    mountFour();
    const out = document.createElement("button");
    document.body.append(out);
    out.focus();
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }]) {
      out.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", bubbles: true, cancelable: true, ...init }));
    }
    expect(document.activeElement).toBe(out);
    const taken = new KeyboardEvent("keydown", { key: "F10", bubbles: true, cancelable: true });
    taken.preventDefault();
    out.dispatchEvent(taken);
    expect(document.activeElement).toBe(out);
    const dlg = document.createElement("div");
    document.body.append(dlg);
    dlg.append(out);
    const release = inertOthers(dlg);
    out.focus();
    key("F10");
    expect(document.activeElement).toBe(out);
    release();
    dlg.remove();
  });
});
