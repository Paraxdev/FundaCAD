// The modal-depth gate, end to end.
//
// `depth` (stores/modals.ts) is what toolBusy() reads through isChoiceOpen(),
// so a global shortcut cannot fire underneath an open dialog. Get the DECREMENT
// wrong and there is no error and no visible symptom — depth simply never
// returns to zero, toolBusy() stays true forever, and every tool in the app is
// silently dead. That is exactly the class of bug a test is worth writing for,
// and exactly the one the imperative version was structurally exposed to
// (pushModal() in open(), popModal() hand-repeated on four dismissal paths).
//
// So these tests do not mount the dialogs directly. They drive them the way the
// app does — through the store, with a host that mirrors App.vue's v-if — and
// assert the count is back to zero after each dialog closes by its OWN exit
// path: Escape, backdrop, Cancel, or the frame's close button.
//
// The three dialogs here are the three that gate. FilamentMappingDialog and
// SpaceMouseModal both deliberately do NOT (each says so at its own top), so
// using one as a vehicle would assert the opposite of what it promises.
//
// The dialogs Teleport to body, so assertions query `document` rather than the
// wrapper: the wrapper only holds the teleport anchor comments.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useModalStore } from "../../../src/stores/modals";
import { useDialogStore } from "../../../src/stores/dialogs";
import type { BugReportDeps } from "../../../src/ui/bugReporter";
import type { WelcomeCallbacks } from "../../../src/ui/welcome";
import BugReportDialog from "../../../src/components/overlays/BugReportDialog.vue";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import WelcomeModal from "../../../src/components/overlays/WelcomeModal.vue";

// Every dialog installs a capture-phase window key trap for its lifetime. A
// wrapper left mounted would keep swallowing Escape in the NEXT test.
enableAutoUnmount(afterEach);

const depth = () => useModalStore().depth;
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);

/** Mirrors the App.vue entries for the gated dialogs. */
const Host = defineComponent({
  setup() {
    const dialogs = useDialogStore();
    return () => [
      dialogs.welcome && dialogs.welcomeCallbacks ? h(WelcomeModal) : null,
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

const fakeWelcomeCallbacks = (): WelcomeCallbacks => ({
  onNew: () => {},
  onOpen: () => {},
  onOpenPath: async () => "ok",
});

describe("modal depth gate", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.body.innerHTML = "";
    mount(Host, { attachTo: document.body });
  });

  it("starts at zero — the host on its own gates nothing", () => {
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

  it("counts the welcome screen once and releases it on the backdrop", async () => {
    const dialogs = useDialogStore();
    dialogs.bindWelcome(fakeWelcomeCallbacks());
    dialogs.welcome = true;
    await nextTick();
    expect(depth()).toBe(1);

    // .self: the overlay dismisses, a pointerdown inside the panel does not.
    $(".modal-panel")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(depth()).toBe(1);

    $(".modal-overlay")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(dialogs.welcome).toBe(false);
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
    // The bug button is reachable with the welcome screen up, so these two
    // genuinely stack. Each has to give its own count back.
    //
    // One Escape dismisses ONE of them: every trap calls
    // stopImmediatePropagation, and capture listeners on window fire in
    // registration order, so the dialog that opened first wins. That is the
    // imperative behaviour too, and it is why the count is per-dialog.
    const dialogs = useDialogStore();
    dialogs.bindWelcome(fakeWelcomeCallbacks());
    dialogs.bindBugReporter(fakeBugDeps());
    dialogs.welcome = true;
    await nextTick();
    dialogs.bugReport = true;
    await nextTick();
    expect(depth()).toBe(2);

    esc();
    await nextTick();
    expect(dialogs.welcome).toBe(false);
    expect(depth()).toBe(1);

    esc();
    await nextTick();
    expect(dialogs.bugReport).toBe(false);
    expect(depth()).toBe(0);
  });
});
