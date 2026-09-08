// The single owner of the #prompt banner. Any tool that wants to show a
// transient instruction routes through here so there's one convention.
//
// This is now a facade over stores/prompt.ts, rendered by
// components/shell/PromptBanner.vue. The signature is unchanged, so none of the
// ~25 call sites across src/features/**, src/sketch/** and viewport.ts had to
// move, which is the whole point: the sketch/tool layer stays imperative.
import { usePromptStore } from "../stores/prompt";

export function setPrompt(text: string | null) {
  usePromptStore().text = text;
}
