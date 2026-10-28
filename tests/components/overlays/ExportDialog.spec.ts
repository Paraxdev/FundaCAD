// The Export dialog on ui/Dialog: focus starts on Export, Tab stays inside, its own Escape and Enter, live fields,
// and the modal gate held while it is up.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import ExportDialog from "../../../src/components/overlays/ExportDialog.vue";
import { useExportDialogStore } from "../../../src/stores/exportDialog";
import { useModalStore } from "../../../src/stores/modals";
import type { ExportChoice } from "../../../src/stores/exportDialog";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const active = () => document.activeElement as HTMLElement | null;
const settle = () => new Promise((r) => setTimeout(r, 5));

function key(k: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });
  (active() ?? document.body).dispatchEvent(e);
  return e;
}

const Host = defineComponent({
  setup() {
    const store = useExportDialogStore();
    return () => (store.request ? h(ExportDialog) : null);
  },
});

function open(): Promise<ExportChoice | null> {
  return useExportDialogStore().open({
    bodies: [
      { id: "body1", name: "Bracket" },
      { id: "body2", name: "Lid" },
    ],
    format: "stl",
  });
}

describe("ExportDialog", () => {
  let opener: HTMLButtonElement;
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
    localStorage.removeItem("fundacad.exportSettings");
    opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    mount(Host, { attachTo: document.body });
  });

  it("is a labelled modal that opens on Export and holds the gate", async () => {
    void open();
    await settle();
    const panel = $("[role=dialog]")!;
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)!.textContent).toBe("Export");
    expect(active()).toBe($("[data-testid=export-confirm]"));
    expect(useModalStore().depth).toBe(1);
  });

  it("wraps Tab inside the dialog", async () => {
    void open();
    await settle();
    const e = key("Tab");
    expect([e.defaultPrevented, active()]).toEqual([true, $(".modal-close")]);
    key("Tab", { shiftKey: true });
    expect(active()).toBe($("[data-testid=export-confirm]"));
  });

  it("Escape cancels, gives the gate back and focus to the opener", async () => {
    const answer = open();
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(await answer).toBeNull();
    await flushPromises();
    expect([$("[role=dialog]"), useModalStore().depth, active()]).toEqual([null, 0, opener]);
  });

  it("Escape closes an open picker first and leaves the dialog up", async () => {
    void open();
    await settle();
    $("[data-testid=export-unit]")!.click();
    await settle();
    expect($(".select-pop")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    expect([$(".select-pop"), useExportDialogStore().request !== null]).toEqual([null, true]);
  });

  it("Enter in a field confirms with the value typed so far", async () => {
    const answer = open();
    await settle();
    $("[data-testid=export-advanced]")!.click();
    await settle();
    expect($("[data-testid=export-advanced]")!.getAttribute("aria-checked")).toBe("true");
    const edge = $("[data-testid=export-max-edge]") as HTMLInputElement;
    edge.focus();
    edge.value = "2";
    edge.dispatchEvent(new Event("input", { bubbles: true }));
    key("Enter");
    const choice = await answer;
    expect(choice?.settings.faceting.maxEdgeLength).toBe(2);
    expect(choice?.settings.refinement).toBe("custom");
  });

  it("names its fields' units in the field", async () => {
    void open();
    await settle();
    $("[data-testid=export-advanced]")!.click();
    await settle();
    const unitOf = (id: string) => $(`[data-testid=${id}]`)!.closest(".ui-number-field")!.textContent!.trim();
    expect([unitOf("export-surface-deviation"), unitOf("export-normal-deviation")]).toEqual(["mm", "°"]);
  });
});
