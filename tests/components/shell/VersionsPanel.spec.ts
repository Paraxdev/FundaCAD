// Restore in the Versions panel: a version that cannot be read says so and leaves
// the document as it was, and a good one after it still restores. A damaged newest
// version still lets the panel open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import VersionsPanel from "../../../src/components/shell/VersionsPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { VersionRepo } from "../../../src/document/versions";
import { toast } from "../../../src/ui/toast";
import { box, freshStore } from "../../document/storeKit";

vi.mock("../../../src/ui/toast", () => ({ toast: vi.fn() }));

enableAutoUnmount(afterEach);
beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(toast).mockClear();
});

function twoVersions() {
  const store = freshStore();
  store.load(JSON.stringify({ parameters: {}, features: [box("f1", 10.5)] }));
  const one = store.saveVersion("one")!;
  store.load(JSON.stringify({ parameters: {}, features: [box("f1", 10.5), box("f2", 4.25)] }), { replace: true });
  const two = store.saveVersion("two")!;
  return { store, one, two };
}

function mountPanel(store: ReturnType<typeof freshStore>) {
  const bridge = { docVersion: ref(0), metaVersion: ref(0), buildVersion: ref(0) };
  const engine = { store, bridge } as unknown as Engine;
  return mount(VersionsPanel, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
}

async function restoreRow(w: ReturnType<typeof mountPanel>, message: string) {
  const row = w.findAll(".versions-row").find((r) => r.find(".versions-msg").text() === message)!;
  await row.find(".versions-main").trigger("click");
  await row.findAll(".versions-actions button")[0]!.trigger("click");
}

describe("Restore in the Versions panel", () => {
  it("opens over a newest version that lost a feature object, with a setting changed since", async () => {
    const { store, two } = twoVersions();
    delete (store.versionRepo as VersionRepo).objects[two.tree.features[1]!];
    store.load(JSON.stringify({ parameters: { w: 3.5 }, features: [box("f1", 10.5), box("f2", 4.25)] }), {
      replace: true,
    });
    const w = mountPanel(store);
    expect(w.findAll(".versions-row .versions-msg").map((m) => m.text())).toEqual(["two", "one"]);
    expect(w.find(".pop-note").text()).toMatch(/^1 change .*"two"/);
    await restoreRow(w, "one");
    expect(store.document.features).toEqual([box("f1", 10.5)]);
  });

  it("says a version that is missing a feature cannot be restored, and leaves the document alone", async () => {
    const { store, two } = twoVersions();
    const repo = store.versionRepo as VersionRepo;
    delete repo.objects[two.tree.features[1]!];
    const w = mountPanel(store);
    const before = JSON.stringify(store.document);
    await restoreRow(w, "two");
    expect(JSON.stringify(store.document)).toBe(before);
    expect(vi.mocked(toast).mock.calls.map((c) => c[1])).toEqual([{ kind: "error" }]);
    expect(vi.mocked(toast).mock.calls[0]![0]).toContain("two");
    expect(vi.mocked(toast).mock.calls[0]![0]).toContain("missing a feature");
  });

  it("restores the readable version next to it and says so", async () => {
    const { store, two } = twoVersions();
    delete (store.versionRepo as VersionRepo).objects[two.tree.features[1]!];
    const w = mountPanel(store);
    await restoreRow(w, "one");
    expect(store.document.features).toEqual([box("f1", 10.5)]);
    expect(vi.mocked(toast).mock.calls.map((c) => c[1])).toEqual([undefined]);
    expect(vi.mocked(toast).mock.calls[0]![0]).toContain("one");
  });
});
