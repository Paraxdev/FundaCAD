import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { HomeCallbacks } from "../ui/home";

export const useHomeStore = defineStore("home", () => {
  const visible = ref(false);
  const callbacks = shallowRef<HomeCallbacks | null>(null);
  return {
    visible,
    callbacks,
    bind: (cb: HomeCallbacks) => { callbacks.value = markRaw(cb); },
  };
});
