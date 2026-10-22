// The single owner of the #prompt banner, a facade over stores/prompt.ts so the tool layer stays imperative.
import { usePromptStore } from "../stores/prompt";

export function setPrompt(text: string | null) {
  usePromptStore().text = text;
}

/** Clears the banner only while it still shows `text`, so a tool put away after another took over leaves that one's. */
export function clearPrompt(text: string) {
  const store = usePromptStore();
  if (store.text === text) store.text = null;
}
