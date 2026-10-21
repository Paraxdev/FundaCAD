import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import type { HomeCallbacks } from "../ui/home";

export const useHomeStore = defineStore("home", () => {
  const visible = ref(false);
  const callbacks = shallowRef<HomeCallbacks | null>(null);
  return {
    visible,
    callbacks,
    shown: computed(() => visible.value && !!callbacks.value),
    bind: (cb: HomeCallbacks) => { callbacks.value = markRaw(cb); },
  };
});
