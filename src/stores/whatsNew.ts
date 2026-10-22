import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { NotesGroup } from "../ui/whatsNew";

export const useWhatsNewStore = defineStore("whatsNew", () => {
  const notes = shallowRef<NotesGroup[]>([]);
  const version = ref("");
  let onSeen: (() => void) | null = null;
  // Recorded only once the card was read or hidden, so a start that closes Home at once does not use the notes up.
  const markSeen = () => {
    const fn = onSeen;
    onSeen = null;
    fn?.();
  };
  return {
    notes,
    version,
    show: (v: string, groups: NotesGroup[], seen: (() => void) | null = null) => {
      version.value = v;
      notes.value = groups;
      onSeen = seen;
    },
    markSeen,
    dismiss: () => {
      notes.value = [];
      markSeen();
    },
  };
});
