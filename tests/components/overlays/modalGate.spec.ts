// The modal-depth gate, end to end.
//
// `depth` (stores/modals.ts) is what toolBusy() reads through isChoiceOpen(),
// so a global shortcut cannot fire underneath an open dialog. Get the DECREMENT
// wrong and there is no error and no visible symptom, depth simply never
// returns to zero, toolBusy() stays true forever, and every tool in the app is
// silently dead. That is exactly the class of bug a test is worth writing for,
// and exactly the one the imperative version was structurally exposed to
// (pushModal() in open(), popModal() hand-repeated on four dismissal paths).
//
// So these tests do not mount the dialogs directly. They drive them the way the
// app does, through the store, with a host that mirrors App.vue's v-if, and
// assert the count is back to zero after each dialog closes by its OWN exit
// path: Escape, backdrop, Cancel, or the frame's close button.
//
// The three dialogs here are the three that gate. FilamentMappingDialog
// deliberately does NOT (it says so at its top), so using it as a vehicle
// would assert the opposite of what it promises.
//
// The dialogs Teleport to body, so assertions query `document` rather than the
// wrapper: the wrapper only holds the teleport anchor comments.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useModalStore } from "../../../src/stores/modals";
import { useDialogStore } from "../../../src/stores/dialogs";
import { useHomeStore } from "../../../src/stores/home";
import type { BugReportDeps } from "../../../src/ui/bugReporter";
import type { HomeCallbacks } from "../../../src/ui/home";
import BugReportDialog from "../../../src/components/overlays/BugReportDialog.vue";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import HomeScreen from "../../../src/components/home/HomeScreen.vue";

// Every dialog installs a capture-phase window key trap for its lifetime. A
// wrapper left mounted would keep swallowing Escape in the NEXT test.
enableAutoUnmount(afterEach);

const depth = () => useModalStore().depth;
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);

/** Mirrors the App.vue entries for the gated dialogs. */
const Host = defineComponent({
  setup() {
    const dialogs = useDialogStore();
    const home = useHomeStore();
    return () => [
      home.visible && home.callbacks ? h(HomeScreen) : null,
      dialogs.preferences ? h(PreferencesDialog) : null,
      dialogs.bugReport && dialogs.bugDeps ? h(BugReportDialog) : null,
    ];
  },
});

function esc() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}
function click(sel: string) {
  $(sel)!.dispatchEvent(new Event("click", { bubbles: true }));
}

/** The narrowest bug-report deps the dialog actually touches at open time. */
function fakeBugDeps(): BugReportDeps {
  return {
    store: { toJSON: () => `{"features":[]}` },
    geometry: { connected: true },
    viewport: { sceneStats: () => ["1 body"] },
    sketch: { snapshotFeature: () => null },
  } as unknown as BugReportDeps;
}

const fakeHomeCallbacks = (): HomeCallbacks => ({
  newDocument: async () => {},
  openDoc: async () => {},
  newFromTemplate: async () => {},
  currentVersions: () => null,
  openVersion: async () => false,
  openBranch: async () => false,
  openPath: async () => "ok",
  currentPath: () => null,
});

describe("modal depth gate", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
    mount(Host, { attachTo: document.body });
  });

  it("starts at zero, the host on its own gates nothing", () => {
    expect(depth()).toBe(0);
  });

  it("counts the bug reporter once and gives the count back on Cancel", async () => {
    const dialogs = useDialogStore();
    dialogs.bindBugReporter(fakeBugDeps());
    dialogs.bugReport = true;
    await nextTick();
    expect($(".bug-report-card")).not.toBeNull();
    expect(depth()).toBe(1);

    click(".bug-cancel");
    await nextTick();
    expect(dialogs.bugReport).toBe(false);
    expect(depth()).toBe(0);
  });

  it("gives the bug reporter's count back on Escape too", async () => {
    const dialogs = useDialogStore();
    dialogs.bindBugReporter(fakeBugDeps());
    dialogs.bugReport = true;
    await nextTick();
    expect(depth()).toBe(1);

    esc();
    await nextTick();
    expect(dialogs.bugReport).toBe(false);
    expect(depth()).toBe(0);
  });

  it("counts Home once and releases it on its close button", async () => {
    const home = useHomeStore();
    home.bind(fakeHomeCallbacks());
    home.visible = true;
    await nextTick();
    expect(depth()).toBe(1);

    click(".modal-close");
    await nextTick();
    expect(home.visible).toBe(false);
    expect(depth()).toBe(0);
  });

  it("releases the preferences count through the frame's close button", async () => {
    const dialogs = useDialogStore();
    dialogs.preferences = true;
    await nextTick();
    expect(depth()).toBe(1);

    click(".modal-close");
    await nextTick();
    expect(dialogs.preferences).toBe(false);
    expect(depth()).toBe(0);
  });

  it("nests rather than double-counting when dialogs stack", async () => {
    // The bug button is reachable with Home up, so these two genuinely stack.
    // Each has to give its own count back, and one Escape dismisses ONE of them:
    // Home opened first and its trap fires first, but it stands aside while a
    // dialog is above it, so the top one goes first.
    const dialogs = useDialogStore();
    const home = useHomeStore();
    home.bind(fakeHomeCallbacks());
    dialogs.bindBugReporter(fakeBugDeps());
    home.visible = true;
    await nextTick();
    dialogs.bugReport = true;
    await nextTick();
    expect(depth()).toBe(2);

    esc();
    await nextTick();
    expect(dialogs.bugReport).toBe(false);
    expect(depth()).toBe(1);

    esc();
    await nextTick();
    expect(home.visible).toBe(false);
    expect(depth()).toBe(0);
  });
});
