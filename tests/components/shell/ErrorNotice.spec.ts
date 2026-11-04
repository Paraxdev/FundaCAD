import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ErrorNotice from "../../../src/components/shell/ErrorNotice.vue";
import { dismissErrorNotice, showErrorNotice } from "../../../src/ui/errorNotice";
import { consoleOpen, log, revealedEntry, setConsoleOpen } from "../../../src/ui/logStore";
import { motionOn, setMotion } from "../../../src/ui/motion";
import { resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";

enableAutoUnmount(afterEach);
afterEach(() => {
  vi.useRealTimers();
  dismissErrorNotice();
  setConsoleOpen(false);
  setMotion(true);
  resetA11yPrefs();
});

describe("the title bar error notice", () => {
  it("pops the triangle, grows, then shows the text", async () => {
    vi.useFakeTimers();
    setMotion(true);
    const w = mount(ErrorNotice);
    showErrorNotice("Fillet1 failed: radius too large", { logId: 1 });
    await w.vm.$nextTick();
    expect(w.get("#error-notice").classes()).toContain("is-icon");
    await vi.advanceTimersByTimeAsync(200);
    expect(w.get("#error-notice").classes()).toContain("is-grow");
    await vi.advanceTimersByTimeAsync(800);
    expect(w.get("#error-notice").classes()).toContain("is-text");
    expect(w.text()).toContain("radius too large");
    await vi.advanceTimersByTimeAsync(10500);
    expect(w.find("#error-notice").exists()).toBe(false);
  });

  it("goes straight to the text with animations off", async () => {
    setMotion(false);
    expect(motionOn()).toBe(false);
    expect(document.documentElement.dataset.motion).toBe("off");
    const w = mount(ErrorNotice);
    showErrorNotice("Shell failed", { logId: 1 });
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(w.get("#error-notice").classes()).toContain("is-text");
  });

  it("leaves speaking to the announcer, with no live role of its own that would say it twice", async () => {
    setMotion(false);
    const w = mount(ErrorNotice);
    showErrorNotice("Shell failed", { logId: 1 });
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(w.find("#error-notice").exists()).toBe(true);
    expect(w.find('[role="alert"], [aria-live]').exists()).toBe(false);
  });

  it("opens the console on the entry it was showing", async () => {
    setMotion(false);
    const w = mount(ErrorNotice);
    const entry = log("error", "Hole1 failed", { detail: "report" });
    showErrorNotice("Hole1 failed", { logId: entry.id });
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    await w.get("#error-notice").trigger("click");
    expect(consoleOpen()).toBe(true);
    expect(revealedEntry()).toBe(entry.id);
    expect(w.find("#error-notice").exists()).toBe(false);
  });

  it("is a button chip named by its sentence, counts repeats, and its action runs once and closes it", async () => {
    setMotion(false);
    const w = mount(ErrorNotice);
    const onClick = vi.fn();
    showErrorNotice("Fillet failed", { logId: 1 });
    showErrorNotice("Fillet failed", { logId: 2, action: { label: "Edit", onClick } });
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    const chip = w.get("#error-notice");
    expect([chip.attributes("type"), chip.attributes("aria-label")]).toEqual(["button", undefined]);
    expect(chip.classes()).toEqual(expect.arrayContaining(["chip", "chip-error", "err-notice", "is-text"]));
    expect(chip.get(".err-count").text()).toBe("2");
    const action = w.get(".err-action");
    expect([action.attributes("type"), action.text()]).toEqual(["button", "Edit"]);
    await action.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(w.find("#error-notice").exists()).toBe(false);
  });
});

describe("the error notice holds while pointed at or focused", () => {
  const shownNotice = async (action?: { label: string; onClick: () => void }) => {
    vi.useFakeTimers();
    setMotion(false);
    const w = mount(ErrorNotice, { attachTo: document.body });
    showErrorNotice("Fillet2 failed: radius 7 too large", { logId: 3, ...(action ? { action } : {}) });
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    return w;
  };
  const gone = (w: Awaited<ReturnType<typeof shownNotice>>) => !w.find("#error-notice").exists();

  it("focus on the chip holds it past its time, focusout gives a full time again", async () => {
    const w = await shownNotice();
    const chip = w.get("#error-notice").element as HTMLElement;
    chip.focus();
    await vi.advanceTimersByTimeAsync(40000);
    expect(gone(w)).toBe(false);
    chip.blur();
    await vi.advanceTimersByTimeAsync(9990);
    expect(gone(w)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(gone(w)).toBe(true);
  });

  it("focus moving from the chip to its action stays held", async () => {
    const w = await shownNotice({ label: "Edit", onClick: () => {} });
    (w.get("#error-notice").element as HTMLElement).focus();
    (w.get(".err-action").element as HTMLElement).focus();
    await vi.advanceTimersByTimeAsync(40000);
    expect(gone(w)).toBe(false);
  });

  it("hover still holds, and mouseleave starts a full time", async () => {
    const w = await shownNotice();
    await w.get(".err-notice-wrap").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(40000);
    expect(gone(w)).toBe(false);
    await w.get(".err-notice-wrap").trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(9990);
    expect(gone(w)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(gone(w)).toBe(true);
  });

  it("a notice clicked away while focused does not hold the next one", async () => {
    const w = await shownNotice();
    (w.get("#error-notice").element as HTMLElement).focus();
    await w.get("#error-notice").trigger("click");
    expect(gone(w)).toBe(true);
    showErrorNotice("Hole1 failed: depth 12", { logId: 4 });
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(gone(w)).toBe(false);
    await vi.advanceTimersByTimeAsync(10010);
    expect(gone(w)).toBe(true);
  });
});

describe("the error notice follows Notification time", () => {
  const shown = async (
    time: "normal" | "longer" | "until-dismissed",
    action?: { label: string; onClick: () => void },
  ) => {
    vi.useFakeTimers();
    setMotion(false);
    setA11yPref("noticeTime", time);
    const w = mount(ErrorNotice, { attachTo: document.body });
    showErrorNotice("Extrude3 failed: depth 14 too deep", { logId: 5, ...(action ? { action } : {}) });
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    return w;
  };

  it("Normal has no Dismiss button and leaves at 10 s", async () => {
    const w = await shown("normal");
    expect(w.find(".err-dismiss").exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(9990);
    expect(w.find("#error-notice").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(w.find("#error-notice").exists()).toBe(false);
  });

  it("Longer leaves at 30 s, and 45 s with a button", async () => {
    let w = await shown("longer");
    await vi.advanceTimersByTimeAsync(29990);
    expect(w.find("#error-notice").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(w.find("#error-notice").exists()).toBe(false);
    w.unmount();
    dismissErrorNotice();
    w = await shown("longer", { label: "Edit", onClick: () => {} });
    await vi.advanceTimersByTimeAsync(44990);
    expect(w.find("#error-notice").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(w.find("#error-notice").exists()).toBe(false);
  });

  it("Until dismissed stays at 10 minutes with a Dismiss button that removes it without opening the console", async () => {
    const w = await shown("until-dismissed", { label: "Edit", onClick: () => {} });
    await vi.advanceTimersByTimeAsync(600000);
    expect(w.find("#error-notice").exists()).toBe(true);
    expect(w.find(".err-action").exists()).toBe(true);
    await w.get(".err-dismiss").trigger("click");
    expect(w.find("#error-notice").exists()).toBe(false);
    expect(consoleOpen()).toBe(false);
  });

  it("a newer error at Until dismissed replaces the text and still stays", async () => {
    const w = await shown("until-dismissed");
    showErrorNotice("Hole2 failed: diameter 9 too wide", { logId: 6 });
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    await vi.advanceTimersByTimeAsync(120000);
    expect(w.text()).toContain("Hole2");
  });
});
