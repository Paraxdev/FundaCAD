import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import Panel from "../../../src/components/ui/Panel.vue";
import FloatingPanel from "../../../src/components/overlays/FloatingPanel.vue";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);

function esc(): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

describe("Panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("closeOnEsc closes it without stopping the event, so the global handler still hears it", async () => {
    const after = vi.fn();
    const w = mount(Panel, { props: { open: true, closeOnEsc: true }, attachTo: document.body });
    window.addEventListener("keydown", after);
    try {
      const e = esc();
      expect([w.emitted("close")?.length, e.defaultPrevented, after.mock.calls.length]).toEqual([1, false, 1]);
    } finally {
      window.removeEventListener("keydown", after);
    }
  });

  it("ignores Escape without closeOnEsc, and while closed", async () => {
    const w = mount(Panel, { props: { open: true }, attachTo: document.body });
    esc();
    await w.setProps({ open: false, closeOnEsc: true });
    esc();
    expect(w.emitted("close")).toBeUndefined();
  });

  it("with nothing but content renders the bare measure-panel, as FloatingPanel did", async () => {
    mount(Panel, { props: { open: true, panelClass: "params-dialog" }, slots: { default: "<p>Body</p>" } });
    const el = $(".measure-panel.params-dialog")!;
    expect([...el.children].map((c) => c.outerHTML)).toEqual(["<p>Body</p>"]);
  });

  it("draws the title, hint, head actions, foot and a close button, labelled by the title", async () => {
    const w = mount(Panel, {
      props: { open: true, title: "Properties", hint: "Esc to close", closable: true },
      slots: { default: "<p>Body</p>", "head-actions": '<i class="act"></i>', foot: '<i class="ft"></i>' },
      attachTo: document.body,
    });
    const el = $(".ui-panel")!;
    expect(document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent).toBe("Properties");
    expect($(".ui-panel-head .act")).not.toBeNull();
    expect($(".ui-panel-hint")!.textContent).toBe("Esc to close");
    expect($(".ui-panel-foot .ft")).not.toBeNull();
    const close = $(".ui-panel-close")!;
    expect([close.getAttribute("type"), close.getAttribute("aria-label"), close.getAttribute("title")]).toEqual([
      "button",
      "Close",
      "Close",
    ]);
    close.click();
    expect(w.emitted("close")?.length).toBe(1);
  });

  it("renders nothing while closed", async () => {
    const w = mount(Panel, { props: { open: false }, attachTo: document.body });
    expect($(".measure-panel")).toBeNull();
    await w.setProps({ open: true });
    await nextTick();
    expect($(".measure-panel")).not.toBeNull();
  });
});

describe("FloatingPanel keeps its contract over Panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("passes open, closeOnEsc, panelClass and close through", async () => {
    const after = vi.fn();
    const w = mount(FloatingPanel, {
      props: { open: true, closeOnEsc: true, panelClass: "stress-panel" },
      slots: { default: "<p>Body</p>" },
      attachTo: document.body,
    });
    window.addEventListener("keydown", after);
    try {
      expect([...$(".measure-panel.stress-panel")!.children].map((c) => c.outerHTML)).toEqual(["<p>Body</p>"]);
      esc();
      expect([w.emitted("close")?.length, after.mock.calls.length]).toEqual([1, 1]);
    } finally {
      window.removeEventListener("keydown", after);
    }
  });
});
