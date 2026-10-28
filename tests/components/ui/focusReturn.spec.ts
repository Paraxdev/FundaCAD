import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { focusReturn, lastFocus, trackFocus, withFocusReturn } from "../../../src/components/ui/focusables";

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const active = () => document.activeElement;
const tick = () => new Promise((r) => setTimeout(r, 5));
const inside = (sel: string) => (n: Node) => !!document.querySelector(sel)?.contains(n);
let stop: () => void = () => {};

beforeEach(() => {
  document.body.innerHTML = `
    <div id="main">
      <button id="a">A</button><input id="field" /><button id="opener">Open</button>
      <button id="gone">Gone</button><button id="shut" inert>Shut</button>
      <div style="display: none"><button id="hidden">Hidden</button></div>
    </div>
    <div id="dlg"><button id="inner">Inner</button></div>`;
  stop = trackFocus();
});
afterEach(() => {
  stop();
  vi.restoreAllMocks();
});

describe("focusReturn", () => {
  it("refocuses a connected opener", () => {
    $("#opener").focus();
    const back = focusReturn();
    $("#inner").focus();
    back.restore(inside("#dlg"));
    expect(active()).toBe($("#opener"));
  });

  it("leaves focus alone when the user moved on outside the overlay", () => {
    $("#opener").focus();
    const back = focusReturn();
    $("#a").focus();
    back.restore(inside("#dlg"));
    expect(active()).toBe($("#a"));
  });

  it("falls back to the last tracked control outside the overlay when the opener is gone", () => {
    $("#a").focus();
    $("#opener").focus();
    const back = focusReturn();
    $("#inner").focus();
    $("#opener").remove();
    back.restore(inside("#dlg"));
    expect(active()).toBe($("#a"));
  });

  it("prefers the caller's fallback over the history", () => {
    $("#a").focus();
    $("#opener").focus();
    const back = focusReturn(() => $("#field"));
    $("#opener").remove();
    back.restore(() => false);
    expect(active()).toBe($("#field"));
  });

  it("lands on the main landmark without a ring when nothing tracked is left", () => {
    $("#gone").focus();
    const back = focusReturn();
    $("#gone").remove();
    back.restore(() => false);
    expect(active()).toBe($("#main"));
    expect($("#main").getAttribute("tabindex")).toBe("-1");
    expect($("#main").hasAttribute("data-focus-landing")).toBe(true);
  });

  it("keeps a tabindex the landmark already has", () => {
    $("#main").setAttribute("tabindex", "0");
    $("#gone").focus();
    const back = focusReturn();
    $("#gone").remove();
    back.restore(() => false);
    expect(active()).toBe($("#main"));
    expect($("#main").getAttribute("tabindex")).toBe("0");
  });

  it("does nothing when focus sat on the body at open", () => {
    $("#a").focus();
    $("#a").blur();
    const back = focusReturn();
    back.restore(() => false);
    expect(active()).toBe(document.body);
    expect($("#main").hasAttribute("tabindex")).toBe(false);
  });
});

describe("lastFocus", () => {
  it("skips removed, inert, hidden and excluded controls", () => {
    $("#a").focus();
    for (const id of ["#hidden", "#shut", "#inner", "#gone"]) $(id).dispatchEvent(new FocusEvent("focusin"));
    $("#gone").remove();
    expect(lastFocus(inside("#dlg"))).toBe($("#a"));
    expect(lastFocus()).toBe($("#inner"));
  });

  it("is empty once tracking stops", () => {
    $("#a").focus();
    stop();
    expect(lastFocus()).toBeNull();
  });
});

describe("withFocusReturn", () => {
  it("hands focus back to the caller when the native dialog left it on the body", async () => {
    $("#opener").focus();
    const out = await withFocusReturn(async () => {
      $("#opener").blur();
      return "picked";
    });
    expect(out).toBe("picked");
    expect(active()).toBe($("#opener"));
  });

  it("leaves focus where the callee moved it", async () => {
    $("#opener").focus();
    await withFocusReturn(() => $("#a").focus());
    expect(active()).toBe($("#a"));
  });

  it("restores and rethrows when the callee fails", async () => {
    $("#opener").focus();
    const run = withFocusReturn(async () => {
      $("#opener").blur();
      throw new Error("cancelled");
    });
    await expect(run).rejects.toThrow("cancelled");
    expect(active()).toBe($("#opener"));
  });
});

describe("window focus", () => {
  it("restores the last control when the window comes back with focus on the body", async () => {
    $("#field").focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    $("#field").blur();
    await tick();
    window.dispatchEvent(new FocusEvent("focus"));
    await tick();
    expect(active()).toBe($("#field"));
  });

  it("leaves focus on the body when the user put it there", async () => {
    $("#field").focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    $("#field").blur();
    await tick();
    window.dispatchEvent(new FocusEvent("focus"));
    await tick();
    expect(active()).toBe(document.body);
  });

  it("does not move focus the engine already restored", async () => {
    $("#field").focus();
    $("#a").focus();
    window.dispatchEvent(new FocusEvent("focus"));
    await tick();
    expect(active()).toBe($("#a"));
  });
});
