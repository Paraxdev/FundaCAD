import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";

import Dialog from "../../../src/components/ui/Dialog.vue";
import ModalFrame from "../../../src/components/overlays/ModalFrame.vue";
import Popover from "../../../src/components/ui/Popover.vue";
import { useModalStore } from "../../../src/stores/modals";

enableAutoUnmount(afterEach);

const settle = () => new Promise((r) => setTimeout(r, 5));
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const active = () => document.activeElement as HTMLElement | null;

function key(k: string, opts: KeyboardEventInit = {}, target: EventTarget = active() ?? document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(e);
  return e;
}

async function render(props: Record<string, unknown> = {}, body?: () => unknown) {
  const open = ref(false);
  const closes = ref(0);
  const Host = defineComponent({
    setup: () => () => [
      h("button", { class: "opener" }, "Open"),
      open.value
        ? h(
            Dialog,
            {
              title: "Export",
              ...props,
              onClose: () => {
                closes.value++;
                open.value = false;
              },
            },
            {
              default:
                body ??
                (() => [
                  h("input", { class: "first" }),
                  h("input", { class: "second" }),
                  h("button", { class: "last" }),
                ]),
            },
          )
        : null,
    ],
  });
  const w = mount(Host, { attachTo: document.body });
  $(".opener")!.focus();
  open.value = true;
  await nextTick();
  await settle();
  return { w, open, closes };
}

describe("Dialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("is a modal dialog labelled by its title", async () => {
    await render();
    const panel = $(".ui-dialog")!;
    expect([panel.getAttribute("role"), panel.getAttribute("aria-modal")]).toEqual(["dialog", "true"]);
    const title = document.getElementById(panel.getAttribute("aria-labelledby")!);
    expect(title?.textContent).toBe("Export");
  });

  it("wears the size class it is given", async () => {
    await render({ size: "sm" });
    expect($(".ui-dialog")!.classList.contains("ui-dialog-sm")).toBe(true);
  });

  it("focuses the first control of its body, not the close button", async () => {
    await render();
    expect(active()?.className).toBe("first");
  });

  it("focuses the initialFocus selector when given", async () => {
    await render({ initialFocus: ".second" });
    expect(active()?.className).toBe("second");
  });

  it("wraps Tab inside: Tab on the last control goes to the first, Shift+Tab on the first to the last", async () => {
    await render();
    $(".last")!.focus();
    const fwd = key("Tab");
    expect([fwd.defaultPrevented, active()?.classList.contains("modal-close")]).toEqual([true, true]);
    const back = key("Tab", { shiftKey: true });
    expect([back.defaultPrevented, active()?.className]).toEqual([true, "last"]);
    $(".first")!.focus();
    const mid = key("Tab");
    expect(mid.defaultPrevented).toBe(false);
  });

  it("Escape closes it through the modal gate, and focus returns to the opener", async () => {
    const { open } = await render();
    expect(useModalStore().depth).toBe(1);
    const e = key("Escape");
    await nextTick();
    expect([e.defaultPrevented, open.value, useModalStore().depth]).toEqual([true, false, 0]);
    expect(active()?.className).toBe("opener");
  });

  it("leaves Escape to a choice raised over it and to a popover inside it", async () => {
    const { open } = await render();
    const m = useModalStore();
    m.depth++;
    key("Escape");
    expect(open.value).toBe(true);
    m.depth--;
    const anchor = $(".first")!;
    const pop = ref(true);
    mount(
      defineComponent({
        setup: () => () => (pop.value ? h(Popover, { anchor, onClose: () => (pop.value = false) }) : null),
      }),
      { attachTo: document.body },
    );
    await nextTick();
    await settle();
    key("Escape");
    await nextTick();
    expect([pop.value, open.value]).toEqual([false, true]);
  });

  it("does not close on Escape when closeOnEsc is false", async () => {
    const { open } = await render({ closeOnEsc: false });
    key("Escape");
    expect(open.value).toBe(true);
  });

  it("closes on a press on the overlay, not on one inside the panel, and on the close button", async () => {
    const { closes, open } = await render();
    $(".ui-dialog")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(closes.value).toBe(0);
    $(".modal-overlay")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(closes.value).toBe(1);
    open.value = true;
    await nextTick();
    await settle();
    $(".modal-close")!.click();
    expect(closes.value).toBe(2);
  });

  it("wraps the body, and renders the footer only when given one", async () => {
    await render();
    expect([$(".ui-dialog .modal-body .first") !== null, $(".ui-dialog-foot")]).toEqual([true, null]);
    document.body.innerHTML = "";
    mount(Dialog, {
      props: { title: "Save" },
      slots: { default: "<p>Body</p>", footer: '<button class="ok">OK</button>' },
      attachTo: document.body,
    });
    await nextTick();
    expect($(".ui-dialog-foot .ok")).not.toBeNull();
  });
});

describe("ModalFrame keeps its old contract over Dialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  async function frame() {
    const closes = ref(0);
    const w = mount(
      defineComponent({
        setup: () => () =>
          h(
            ModalFrame,
            { panelClass: "export-dialog", onClose: () => closes.value++ },
            { title: () => "Export", default: () => h("div", { class: "modal-body" }, [h("input")]) },
          ),
      }),
      { attachTo: document.body },
    );
    await nextTick();
    await settle();
    return { w, closes };
  }

  it("keeps .modal-close, the panel class and the caller's own body", async () => {
    await frame();
    expect($(".modal-panel.export-dialog")).not.toBeNull();
    expect(document.querySelectorAll(".modal-body").length).toBe(1);
    expect($(".modal-close")!.getAttribute("aria-label")).toBe("Close");
  });

  it("neither gates, nor handles Escape, nor moves focus: the dialogs wearing it do that themselves", async () => {
    const before = active();
    const { closes } = await frame();
    expect(useModalStore().depth).toBe(0);
    expect(active()).toBe(before);
    key("Escape", {}, window);
    expect(closes.value).toBe(0);
    $(".modal-close")!.click();
    $(".modal-overlay")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(closes.value).toBe(2);
  });
});
