// The Versions panel on the base controls: the message field, the guarded Save, the version rows and the branch picker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import VersionsPanel from "../../../src/components/shell/VersionsPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { box, freshStore } from "../../document/storeKit";

vi.mock("../../../src/ui/toast", () => ({ toast: vi.fn() }));
enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

function saved() {
  const store = freshStore();
  store.load(JSON.stringify({ parameters: {}, features: [box("f1", 10.5)] }));
  const one = store.saveVersion("one")!;
  return { store, one };
}
function mountPanel(store: ReturnType<typeof freshStore>) {
  const bridge = { docVersion: ref(0), metaVersion: ref(0), buildVersion: ref(0) };
  const engine = { store, bridge } as unknown as Engine;
  return mount(VersionsPanel, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
}

describe("Versions panel controls", () => {
  it("refuses a save with nothing changed, from the button and from Enter in the field", async () => {
    const { store } = saved();
    const spy = vi.spyOn(store, "saveVersion");
    const w = mountPanel(store);
    const btn = w.get(".versions-save-btn");
    expect([btn.attributes("type"), btn.attributes("aria-disabled")]).toEqual(["submit", "true"]);
    await btn.trigger("click");
    await w.get(".versions-save").trigger("submit");
    expect(spy).not.toHaveBeenCalled();
  });

  it("saves the typed message once something changed", async () => {
    const { store } = saved();
    store.load(JSON.stringify({ parameters: {}, features: [box("f1", 10.5), box("f2", 3)] }), { replace: true });
    const spy = vi.spyOn(store, "saveVersion");
    const w = mountPanel(store);
    const input = w.get<HTMLInputElement>(".versions-save .versions-input input");
    await input.setValue("wider");
    expect(w.get(".versions-save-btn").attributes("aria-disabled")).toBeUndefined();
    await w.get(".versions-save").trigger("submit");
    await nextTick();
    expect(spy).toHaveBeenCalledWith("wider");
  });

  it("opens a version from its row and creates a branch only with a name", async () => {
    const { store } = saved();
    const spy = vi.spyOn(store, "branchFromVersion");
    const w = mountPanel(store);
    const row = w.get(".versions-main");
    expect([row.element.tagName, row.attributes("aria-expanded")]).toEqual(["BUTTON", "false"]);
    await row.trigger("click");
    expect(row.attributes("aria-expanded")).toBe("true");
    await w.findAll(".versions-actions button")[1]!.trigger("click");
    const form = w.get(".versions-detail .versions-save");
    await form.trigger("submit");
    expect(spy).not.toHaveBeenCalled();
    await form.get("input").setValue("alt");
    await form.trigger("submit");
    expect(spy).toHaveBeenCalledWith(expect.any(String), "alt");
  });

  it("switches branch from the base select", async () => {
    const { store, one } = saved();
    store.branchFromVersion(one.id, "alt");
    const spy = vi.spyOn(store, "switchVersionBranch");
    const w = mountPanel(store);
    const trigger = w.get(".versions-branch");
    expect(trigger.attributes("role")).toBe("combobox");
    await trigger.trigger("click");
    await nextTick();
    const target = trigger.text().includes("alt") ? "main" : "alt";
    const opt = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent?.trim() === target,
    );
    opt!.click();
    await nextTick();
    expect(spy).toHaveBeenCalledWith(target);
  });
});
