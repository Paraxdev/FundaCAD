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

describe("ToastStack region", () => {
  const region = () => document.querySelector<HTMLElement>(".toast-stack");

  it("is in the page with no toast, named Notifications and not live", () => {
    mount(ToastStack, { attachTo: document.body });
    const el = region()!;
    expect([el.getAttribute("role"), el.getAttribute("aria-label"), el.children.length]).toEqual([
      "region",
      "Notifications",
      0,
    ]);
    expect(el.closest("[aria-live]")).toBeNull();
    expect(el.querySelector("[aria-live], [role=status], [role=alert]")).toBeNull();
  });

  it("holds one row and then three, in the same region", async () => {
    mount(ToastStack, { attachTo: document.body });
    const el = region()!;
    const st = useToastStore();
    st.push("Saved 3 parts", "info", undefined, 60000);
    await nextTick();
    expect(document.querySelectorAll(".toast-stack")).toHaveLength(1);
    expect(Array.from(el.querySelectorAll(".toast-msg"), (m) => m.textContent)).toEqual(["Saved 3 parts"]);
    st.push("Pasted 4 faces", "warning", undefined, 60000);
    st.push("Opened 2 files", "info", undefined, 60000);
    await nextTick();
    expect(region()).toBe(el);
    expect(Array.from(el.querySelectorAll(".toast-msg"), (m) => m.textContent)).toEqual([
      "Saved 3 parts",
      "Pasted 4 faces",
      "Opened 2 files",
    ]);
    expect(el.getAttribute("aria-live")).toBeNull();
  });
});
