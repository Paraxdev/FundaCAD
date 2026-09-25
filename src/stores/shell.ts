import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { readSetting } from "../ui/storedSetting";

const ITEMS_KEY = "fundacad.shell.items";
const HISTORY_KEY = "fundacad.shell.history";

function readOpen(key: string, fallback: boolean): boolean {
  const raw = readSetting(key);
  return raw === "1" ? true : raw === "0" ? false : fallback;
}

function writeOpen(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* private mode: the choice just doesn't survive the session */
  }
}

export type Drawer = "items" | "history";

/** The floating shell's own state: which cards are open and which popover or
 *  flyout is showing. Only one popover is open at a time, opening another
 *  closes the first.
 *
 *  On a narrow stage the Items and History cards no longer fit beside the rail
 *  and the view controls, so they turn into drawers: closed until asked for,
 *  one at a time, and never written over the remembered wide-layout choice. */
export const useShellStore = defineStore("shell", () => {
  const itemsOpen = ref(readOpen(ITEMS_KEY, true));
  const historyOpen = ref(readOpen(HISTORY_KEY, true));
  const popover = ref<string | null>(null);
  const narrow = ref(false);
  const drawer = ref<Drawer | null>(null);

  const itemsShown = computed(() => (narrow.value ? drawer.value === "items" : itemsOpen.value));
  const historyShown = computed(() => (narrow.value ? drawer.value === "history" : historyOpen.value));

  function setDrawer(which: Drawer, on: boolean) {
    if (on) drawer.value = which;
    else if (drawer.value === which) drawer.value = null;
  }
  function setItems(on: boolean) {
    if (narrow.value) return setDrawer("items", on);
    itemsOpen.value = on;
    writeOpen(ITEMS_KEY, on);
  }
  function setHistory(on: boolean) {
    if (narrow.value) return setDrawer("history", on);
    historyOpen.value = on;
    writeOpen(HISTORY_KEY, on);
  }
  function setNarrow(on: boolean) {
    if (narrow.value === on) return;
    narrow.value = on;
    drawer.value = null;
  }
  function closeDrawer() {
    drawer.value = null;
  }
  function togglePopover(id: string) {
    popover.value = popover.value === id ? null : id;
  }
  function closePopover(id?: string) {
    if (!id || popover.value === id) popover.value = null;
  }

  return {
    itemsOpen,
    historyOpen,
    popover,
    narrow,
    drawer,
    itemsShown,
    historyShown,
    setItems,
    setHistory,
    setNarrow,
    closeDrawer,
    toggleItems: () => setItems(!itemsShown.value),
    toggleHistory: () => setHistory(!historyShown.value),
    togglePopover,
    closePopover,
  };
});
