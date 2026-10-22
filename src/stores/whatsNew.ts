import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { NotesGroup } from "../ui/whatsNew";

export const useWhatsNewStore = defineStore("whatsNew", () => {
  const notes = shallowRef<NotesGroup[]>([]);
  const version = ref("");
  return {
    notes,
    version,
    show: (v: string, groups: NotesGroup[]) => {
      version.value = v;
      notes.value = groups;
    },
    dismiss: () => {
      notes.value = [];
    },
  };
});
