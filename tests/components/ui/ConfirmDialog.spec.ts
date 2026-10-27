import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

import ConfirmDialog from "../../../src/components/ui/ConfirmDialog.vue";
import { useModalStore } from "../../../src/stores/modals";

enableAutoUnmount(afterEach);

const settle = () => new Promise((r) => setTimeout(r, 5));
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const active = () => document.activeElement as HTMLElement | null;

function key(k: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });
  (active() ?? document.body).dispatchEvent(e);
  return e;
}

const OPTIONS = [
  { value: "discard", label: "Discard" },
  { value: "cancel", label: "Cancel" },
  { value: "save", label: "Save", hint: "Ctrl+S", primary: true },
] as const;

async function render(props: Record<string, unknown> = {}) {
  const w = mount(ConfirmDialog, {
    props: { title: "Unsaved changes", message: "Save before closing?", options: [...OPTIONS], ...props },
    attachTo: document.body,
  });
  await nextTick();
  await settle();
  return w;
}

describe("ConfirmDialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("is a dialog labelled by its title, with the message, and it holds the modal gate", async () => {
    await render();
    const panel = $('[role="dialog"]')!;
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)?.textContent).toBe("Unsaved changes");
    expect($(".ui-confirm-message")!.textContent).toBe("Save before closing?");
    expect(useModalStore().depth).toBe(1);
  });

  it("focuses the primary choice first, and the choices are one Tab stop", async () => {
    await render();
    expect(active()?.textContent).toContain("Save");
    expect($$(".ui-confirm-choice").map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("ArrowLeft and ArrowRight move between the choices with wrap", async () => {
    await render();
    const seen = ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowRight"].map((k) => (key(k), active()?.textContent));
    expect(seen.map((t) => t?.replace("Ctrl+S", ""))).toEqual(["Cancel", "Discard", "Save", "Discard"]);
  });

  it("a click on a choice emits pick with its value", async () => {
    const w = await render();
    $$(".ui-confirm-choice")[0]!.click();
    expect(w.emitted("pick")).toEqual([["discard"]]);
  });

  it("Escape and a press on the overlay cancel", async () => {
    const w = await render();
    key("Escape");
    $(".modal-overlay")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(w.emitted("cancel")?.length).toBe(2);
    expect(w.emitted("pick")).toBeUndefined();
  });

  it("paints the primary choice danger when danger is set", async () => {
    await render({ danger: true });
    expect($(".ui-confirm-primary")!.classList.contains("ui-confirm-danger")).toBe(true);
  });

  it("multi: confirm stays disabled under min, then emits the ticked values", async () => {
    const w = await render({
      multi: true,
      min: 1,
      confirmLabel: "Delete",
      options: [
        { value: "a", label: "Body A" },
        { value: "b", label: "Body B" },
      ],
    });
    const ok = $(".ui-confirm-ok")!;
    expect(ok.getAttribute("aria-disabled")).toBe("true");
    ok.click();
    expect(w.emitted("confirm")).toBeUndefined();
    const boxes = $$('.ui-confirm-checklist input[type="checkbox"]') as HTMLInputElement[];
    boxes[1]!.click();
    await nextTick();
    expect(ok.getAttribute("aria-disabled")).toBeNull();
    ok.click();
    expect(w.emitted("confirm")).toEqual([[["b"]]]);
    $(".ui-confirm-cancel")!.click();
    expect(w.emitted("cancel")?.length).toBe(1);
  });
});
