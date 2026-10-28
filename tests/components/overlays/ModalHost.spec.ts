// The chooser host on ui/ConfirmDialog: focus in, the arrows and Tab inside it, every other key kept from the app,
// Escape for the topmost dialog only, and focus back on the opener.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

import ModalHost from "../../../src/components/overlays/ModalHost.vue";
import Dialog from "../../../src/components/ui/Dialog.vue";
import { choose, chooseMulti, listModal } from "../../../src/ui/choice";
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

/** What a window shortcut listener, like keymap.ts, hears. */
let heard: string[] = [];
const listen = (e: KeyboardEvent) => heard.push(e.key);

const OPTIONS = [
  { value: "face", label: "Face or plane", hint: "click a face" },
  { value: "axis", label: "Axis" },
  { value: "cancel", label: "Cancel" },
];

/** Boxed: an async function returning the answer's promise would wait for the answer itself. */
async function open<T>(p: Promise<T>): Promise<{ answer: Promise<T> }> {
  await nextTick();
  await settle();
  return { answer: p };
}

describe("ModalHost", () => {
  let opener: HTMLButtonElement;
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
    opener = document.createElement("button");
    opener.textContent = "Section";
    document.body.append(opener);
    opener.focus();
    heard = [];
    window.addEventListener("keydown", listen);
    mount(ModalHost, { attachTo: document.body });
  });
  afterEach(() => window.removeEventListener("keydown", listen));

  it("is a labelled modal alertdialog with the first choice focused", async () => {
    await open(choose("Cut along what?", OPTIONS));
    const panel = $("[role=alertdialog]")!;
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)!.textContent).toBe("Cut along what?");
    expect(active()?.textContent).toContain("Face or plane");
    expect($$(".ui-confirm-choice").map((b) => b.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("moves between choices on the arrows with wrap, and Enter picks the focused one", async () => {
    const { answer } = await open(choose("Cut along what?", OPTIONS));
    key("ArrowRight");
    expect(active()?.textContent).toBe("Axis");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(active()?.textContent).toBe("Cancel");
    key("ArrowRight");
    key("ArrowRight");
    expect(active()?.textContent).toBe("Axis");
    key("Enter");
    expect(await answer).toBe("axis");
    expect(heard).toEqual([]);
  });

  it("keeps Tab inside the dialog and every other key from the app's shortcuts", async () => {
    await open(choose("Cut along what?", OPTIONS));
    const close = $(".modal-close")!;
    key("Tab");
    expect(active()).toBe(close);
    const k = key("k");
    expect(k.defaultPrevented).toBe(true);
    expect(heard).toEqual([]);
  });

  it("resolves null on Escape and gives focus back to the opener", async () => {
    const { answer } = await open(choose("Cut along what?", OPTIONS));
    key("Escape");
    expect(await answer).toBeNull();
    await nextTick();
    expect($("[role=alertdialog]")).toBeNull();
    expect(active()).toBe(opener);
    expect(useModalStore().depth).toBe(0);
  });

  it("resolves null on a press on the backdrop", async () => {
    const { answer } = await open(choose("Cut along what?", OPTIONS));
    $(".modal-overlay")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(await answer).toBeNull();
  });

  it("closes only the chooser on Escape over another dialog, then that dialog on the next", async () => {
    const under = mount(Dialog, { props: { title: "Export" }, attachTo: document.body });
    await settle();
    const { answer } = await open(choose("Cut along what?", OPTIONS));
    key("Escape");
    expect(await answer).toBeNull();
    expect(under.emitted("close")).toBeUndefined();
    await nextTick();
    key("Escape");
    expect(under.emitted("close")).toHaveLength(1);
  });

  it("multi: Enter refuses too few ticks, then confirms the ticked values", async () => {
    const { answer } = await open(chooseMulti("Export which?", OPTIONS, { min: 1, confirmLabel: "Export" }));
    expect(active()).toBe($$(".ui-confirm-check input")[0]);
    expect($(".ui-confirm-ok")!.getAttribute("aria-disabled")).toBe("true");
    key("Enter");
    expect($("[role=alertdialog]")).not.toBeNull();
    $$(".ui-confirm-check input")[1]!.click();
    await nextTick();
    key("Enter");
    expect(await answer).toEqual(["axis"]);
  });

  it("multi: Space reaches the focused box", async () => {
    await open(chooseMulti("Export which?", OPTIONS));
    const box = $$(".ui-confirm-check input")[0]!;
    const e = key(" ");
    expect(e.defaultPrevented).toBe(false);
    expect(active()).toBe(box);
    expect(heard).toEqual([]);
  });

  it("list: Done and Escape both resolve, and the modal depth is left alone", async () => {
    const depth = () => useModalStore().depth;
    const { answer: first } = await open(listModal("Exported", ["a.stl", "b.stl"]));
    expect($$(".choice-list li").map((li) => li.textContent)).toEqual(["a.stl", "b.stl"]);
    expect(depth()).toBe(0);
    expect(active()?.textContent).toBe("Done");
    $(".ui-confirm-ok")!.click();
    expect(await first).toBeUndefined();
    const { answer: second } = await open(listModal("Exported", ["c.stl"]));
    key("Escape");
    expect(await second).toBeUndefined();
  });

  it("shows a queued chooser after the first is answered, focused afresh", async () => {
    const { answer: one } = await open(choose("First?", OPTIONS));
    const two = choose("Second?", [{ value: "x", label: "Ex" }]);
    key("Escape");
    expect(await one).toBeNull();
    await nextTick();
    await settle();
    expect($("[role=alertdialog] h2")!.textContent).toBe("Second?");
    expect(active()?.textContent).toBe("Ex");
    key("Enter");
    expect(await two).toBe("x");
  });
});
