import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ToastStack from "../../../src/components/overlays/ToastStack.vue";
import { useToastStore } from "../../../src/stores/toasts";

enableAutoUnmount(afterEach);
beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
});

const leaving = () => useToastStore().items.map((t) => t.leaving);

describe("ToastStack", () => {
  it("runs a toast's action once and dismisses it", async () => {
    mount(ToastStack, { attachTo: document.body });
    const onClick = vi.fn();
    useToastStore().push("Saved", "info", { label: "Open folder", onClick }, 60000);
    await nextTick();
    const action = document.querySelector<HTMLButtonElement>(".toast .btn")!;
    expect([action.type, action.textContent?.trim()]).toEqual(["button", "Open folder"]);
    await new Promise((r) => setTimeout(r, 2));
    action.click();
    expect([onClick.mock.calls.length, leaving()]).toEqual([1, [true]]);
  });

  it("closes from a named icon button with the same tooltip", async () => {
    mount(ToastStack, { attachTo: document.body });
    useToastStore().push("Saved", "info", undefined, 60000);
    await nextTick();
    const close = document.querySelector<HTMLButtonElement>(".toast .icon-btn")!;
    expect([close.type, close.getAttribute("aria-label"), close.title]).toEqual(["button", "Dismiss", "Dismiss"]);
    await new Promise((r) => setTimeout(r, 2));
    close.click();
    expect(leaving()).toEqual([true]);
  });
});
