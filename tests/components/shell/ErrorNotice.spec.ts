import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ErrorNotice from "../../../src/components/shell/ErrorNotice.vue";
import { dismissErrorNotice, showErrorNotice } from "../../../src/ui/errorNotice";
import { consoleOpen, log, revealedEntry, setConsoleOpen } from "../../../src/ui/logStore";
import { motionOn, setMotion } from "../../../src/ui/motion";

enableAutoUnmount(afterEach);
afterEach(() => {
  vi.useRealTimers();
  dismissErrorNotice();
  setConsoleOpen(false);
  setMotion(true);
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
    await vi.advanceTimersByTimeAsync(10000);
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
});
