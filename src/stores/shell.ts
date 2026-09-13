import { defineStore } from "pinia";
import { ref } from "vue";
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

/** The floating shell's own state: which cards are open and which popover or
 *  flyout is showing. Only one popover is open at a time, opening another
 *  closes the first. */
export const useShellStore = defineStore("shell", () => {
  const itemsOpen = ref(readOpen(ITEMS_KEY, true));
  const historyOpen = ref(readOpen(HISTORY_KEY, true));
  const popover = ref<string | null>(null);

  function setItems(on: boolean) {
    itemsOpen.value = on;
    writeOpen(ITEMS_KEY, on);
  }
  function setHistory(on: boolean) {
    historyOpen.value = on;
    writeOpen(HISTORY_KEY, on);
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
    setItems,
    setHistory,
    toggleItems: () => setItems(!itemsOpen.value),
    toggleHistory: () => setHistory(!historyOpen.value),
    togglePopover,
    closePopover,
  };
});
