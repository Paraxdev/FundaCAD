import { afterEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import MenuBar from "../../src/components/shell/MenuBar.vue";
import Menu from "../../src/components/ui/Menu.vue";
import { refOf } from "../../src/ui/controlRefs";
import { setLanguage } from "../../src/i18n";
import type { MenuDef } from "../../src/ui/menu";

enableAutoUnmount(afterEach);
afterEach(async () => {
  document.body.innerHTML = "";
  await setLanguage("system");
});

const menus: MenuDef[] = [
  { label: () => "Datei", refName: "File", items: [{ label: "Neu", refName: "New", onClick: () => {} }] },
  { label: "Edit", items: [{ label: "Rückgängig", refName: "Undo", onClick: () => {} }] },
];

describe("menu refs", () => {
  it("keep the English menu name for the button and a row under a translated label", async () => {
    const w = mount(MenuBar, { props: { menus }, attachTo: document.body });
    const [file, edit] = w.findAll(".menu-btn");
    expect(file!.text()).toBe("Datei");
    expect(refOf(file!.element as HTMLElement)).toBe("menu:File");
    await edit!.trigger("click");
    await flushPromises();
    const rowEl = document.body.querySelector<HTMLElement>(".menu-item")!;
    expect(refOf(rowEl)).toBe("menu:Edit/Undo");
    await file!.trigger("click");
    await flushPromises();
    expect(refOf(document.body.querySelector<HTMLElement>(".menu-item")!)).toBe("menu:File/New");
  });

  it("fall back to the popup aria-label without a name", async () => {
    mount(Menu, {
      props: { label: "Zeichnen", at: { x: 3, y: 4 } },
      slots: { default: '<div class="menu-item">Linie</div>' },
      attachTo: document.body,
    });
    await flushPromises();
    expect(refOf(document.body.querySelector<HTMLElement>(".menu-item")!)).toBe("menu:Zeichnen/Linie");
  });
});
