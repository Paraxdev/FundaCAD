import { defineStore } from "pinia";
import { ref } from "vue";

/** The viewport instruction banner (#prompt), written through `setPrompt(text | null)` in ui/prompt.ts. */
export const usePromptStore = defineStore("prompt", () => {
  const text = ref<string | null>(null);
  return { text };
});
