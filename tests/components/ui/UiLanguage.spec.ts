// The shared controls' own words follow the chosen language, including a switch made while they are shown.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import Chip from "../../../src/components/ui/Chip.vue";
import ConfirmDialog from "../../../src/components/ui/ConfirmDialog.vue";
import NumberField from "../../../src/components/ui/NumberField.vue";
import Panel from "../../../src/components/ui/Panel.vue";
import SwitchRow from "../../../src/components/ui/SwitchRow.vue";
import UnitChip from "../../../src/components/ui/UnitChip.vue";
import { setLanguage } from "../../../src/i18n";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  await setLanguage("system");
  document.body.innerHTML = "";
});

const $ = (sel: string) => document.body.querySelector<HTMLElement>(sel);
// Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
const settle = () => new Promise((r) => setTimeout(r, 5));

async function switchTo(code: "de" | "ja") {
  await setLanguage(code);
  await flushPromises();
}

describe("shared controls in another language", () => {
  it("a removable chip's button says Remove and the label", async () => {
    await switchTo("de");
    const w = mount(Chip, { props: { label: "M3", removable: true } });
    const x = () => w.get("button.icon-btn").attributes("aria-label");
    expect(x()).toBe("M3 entfernen");
    await switchTo("ja");
    expect(x()).toBe("M3 を外す");
  });

  it("a checklist dialog falls back to Cancel and OK in the language", async () => {
    await switchTo("de");
    mount(ConfirmDialog, {
      props: { title: "Ebenen", options: [{ value: "a", label: "A" }], multi: true },
      attachTo: document.body,
    });
    await nextTick();
    await settle();
    expect([$(".ui-confirm-cancel")?.textContent?.trim(), $(".ui-confirm-ok")?.textContent?.trim()]).toEqual([
      "Abbrechen",
      "OK",
    ]);
    await switchTo("ja");
    expect($(".ui-confirm-cancel")?.textContent?.trim()).toBe("キャンセル");
  });

  it("a number field names its limit and its unit chip in the language", async () => {
    await switchTo("de");
    const w = mount(NumberField, {
      props: { modelValue: 5, label: "Tiefe", unit: "mm", units: ["mm", "in"], min: 0 } as never,
      attachTo: document.body,
    });
    await settle();
    const input = w.get("input");
    await input.setValue("-1");
    await input.trigger("keydown", { key: "Enter" });
    expect(input.attributes("title")).toBe("Mindestens 0 mm");
    const chip = () => w.get('[aria-haspopup="listbox"]').attributes("aria-label");
    expect(chip()).toBe("Einheit für Tiefe, mm");
    await switchTo("ja");
    expect(chip()).toBe("Tiefe の単位, mm");
  });

  it("a closable panel's close button and an untitled panel's name follow a switch", async () => {
    await switchTo("de");
    mount(Panel, { props: { open: true, title: "Messen", closable: true }, attachTo: document.body });
    mount(Panel, { props: { open: true, panelClass: "untitled" }, attachTo: document.body });
    await nextTick();
    expect($(".ui-panel-close")?.getAttribute("aria-label")).toBe("Schließen");
    expect($(".untitled .sr-only")?.textContent).toBe("Panel");
    await switchTo("ja");
    expect([$(".ui-panel-close")?.getAttribute("aria-label"), $(".untitled .sr-only")?.textContent]).toEqual([
      "閉じる",
      "パネル",
    ]);
  });

  it("a floating switch row shows On and Off in the language", async () => {
    await switchTo("de");
    const w = mount(SwitchRow, { props: { modelValue: true, label: "Raster" } });
    const state = () => w.get(".ui-switch-row-state").text();
    expect(state()).toBe("Ein");
    await w.setProps({ modelValue: false });
    expect(state()).toBe("Aus");
    await switchTo("ja");
    expect(state()).toBe("オフ");
  });

  it("an unnamed unit picker is called Unit in the language", async () => {
    await switchTo("de");
    const w = mount(UnitChip, { props: { unit: "mm", options: ["mm", "in"] }, attachTo: document.body });
    await settle();
    const chip = () => w.get('[aria-haspopup="listbox"]');
    expect([chip().attributes("aria-label"), chip().attributes("title")]).toEqual(["Einheit, mm", "Einheit"]);
    await switchTo("ja");
    expect(chip().attributes("title")).toBe("単位");
  });
});
