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

  it("is a region named by its title, which is a real h2 heading", async () => {
    mount(Panel, { props: { open: true, title: "Overhang analysis" }, attachTo: document.body });
    const el = $(".ui-panel")!;
    const head = document.getElementById(el.getAttribute("aria-labelledby")!)!;
    expect([el.getAttribute("role"), head.tagName, head.textContent, head.className]).toEqual([
      "region",
      "H2",
      "Overhang analysis",
      "measure-title ui-panel-title",
    ]);
  });

  it("titleHidden keeps the h2 for screen readers only and draws no head for it", async () => {
    mount(Panel, {
      props: { open: true, title: "Stress", titleHidden: true },
      slots: { default: "<p>Body</p>" },
      attachTo: document.body,
    });
    const el = $(".ui-panel")!;
    const head = el.firstElementChild as HTMLElement;
    expect([head.tagName, head.className, !!head.id]).toEqual(["H2", "sr-only", true]);
    expect(el.getAttribute("aria-labelledby")).toBe(head.id);
    expect([$(".ui-panel-head"), el.getAttribute("role")]).toEqual([null, "region"]);
  });

  it("titleHidden with a close button keeps the head for the button alone", async () => {
    mount(Panel, {
      props: { open: true, title: "Stress", titleHidden: true, closable: true },
      attachTo: document.body,
    });
    expect([$(".ui-panel-head .ui-panel-close") !== null, $(".ui-panel-head h2")]).toEqual([true, null]);
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
      props: { open: true, title: "Stress", closeOnEsc: true, panelClass: "stress-panel" },
      slots: { default: "<p>Body</p>" },
      attachTo: document.body,
    });
    window.addEventListener("keydown", after);
    try {
      const kids = [...$(".measure-panel.stress-panel")!.children];
      expect(kids.map((c) => c.tagName)).toEqual(["H2", "P"]);
      expect(kids[1]!.outerHTML).toBe("<p>Body</p>");
      esc();
      expect([w.emitted("close")?.length, after.mock.calls.length]).toEqual([1, 1]);
    } finally {
      window.removeEventListener("keydown", after);
    }
  });
});

describe("FloatingPanel names its region", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reads its title as a hidden h2 heading that labels the region, and draws no head", async () => {
    mount(FloatingPanel, {
      props: { open: true, title: "Fasteners" },
      slots: { default: '<div class="measure-title" aria-hidden="true">Fasteners</div>' },
      attachTo: document.body,
    });
    const el = $(".ui-panel")!;
    const head = document.getElementById(el.getAttribute("aria-labelledby")!)!;
    expect([el.getAttribute("role"), head.tagName, head.className, head.textContent]).toEqual([
      "region",
      "H2",
      "sr-only",
      "Fasteners",
    ]);
    expect($(".ui-panel-head")).toBeNull();
  });
});
