// The welcome screen's load-bearing details.
//
//   1. `.modal-close` still exists. e2e/assembly_tree_e2e.cjs — the CI script —
//      dismisses the startup modal by clicking it, and if the button is gone
//      that script HANGS rather than failing, so nothing tells you.
//   2. Recent-file names are escaped exactly once. The innerHTML version needed
//      esc() on every one; interpolation escapes on its own, so a leftover
//      esc() would render a file called "Bracket & Plate" as "Bracket &amp;
//      Plate" — a bug you only see with the right file on the recents list.
//   3. It embeds NO remote content. The right half used to be a cross-origin
//      iframe, which made this screen the app's only remote-content surface and
//      its sandbox token list a real security boundary in a privileged webview.
//      The frame is gone; this pins that it stays gone, because re-adding one
//      would silently reopen that boundary.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useModalStore } from "../../../src/stores/modals";
import { useDialogStore } from "../../../src/stores/dialogs";
import WelcomeModal from "../../../src/components/overlays/WelcomeModal.vue";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);

function open(recents: { path: string; openedAt: number }[] = []) {
  // Deliberately the PRE-RENAME key: a recent-files list written by an older
  // build has to keep showing up, and this is the one place that path is
  // exercised through a real component rather than through readSetting alone.
  localStorage.setItem("sindri.recentFiles", JSON.stringify(recents));
  useDialogStore().bindWelcome({
    onNew: () => {},
    onOpen: () => {},
    onOpenPath: async () => "ok",
  });
  return mount(WelcomeModal, { attachTo: document.body });
}

describe("WelcomeModal", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("keeps the .modal-close button the CI e2e script clicks", () => {
    open();
    expect($(".modal-close")).not.toBeNull();
  });

  it("escapes a recent-file name exactly once", () => {
    open([{ path: "C:/work/Bracket & Plate.sindri", openedAt: 1 }]);
    const name = $(".welcome-recent-name")!;
    expect(name.textContent).toBe("Bracket & Plate.sindri");
    expect(name.innerHTML).not.toContain("&amp;amp;");
    expect($(".welcome-recent-dir")!.textContent).toBe("C:/work");
    // the full path stays on the title, for the user AND for disambiguation
    expect($(".welcome-recent")!.getAttribute("title")).toBe("C:/work/Bracket & Plate.sindri");
  });

  it("embeds no remote content", () => {
    open();
    // happy-dom really does fetch an <iframe src>, so a frame reappearing here
    // would also start dialling out from the test suite.
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("gates global shortcuts for exactly its own lifetime", async () => {
    const w = open();
    expect(useModalStore().depth).toBe(1);
    w.unmount();
    await nextTick();
    expect(useModalStore().depth).toBe(0);
  });

  it("closes on Escape", async () => {
    open();
    const dialogs = useDialogStore();
    dialogs.welcome = true;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(dialogs.welcome).toBe(false);
  });

  it("remembers the show-on-startup choice", async () => {
    open();
    const box = document.querySelector<HTMLInputElement>(".welcome-startup input")!;
    expect(box.checked).toBe(true); // default is on
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    expect(localStorage.getItem("neocad.welcomeOnStartup")).toBe("false");
  });
});
