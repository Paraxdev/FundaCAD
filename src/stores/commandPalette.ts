import { defineStore } from "pinia";
import { ref } from "vue";

/** Cmd/Ctrl-K command palette: open/closed plus which command set applies.
 *
 *  The dispatcher is bound by the engine rather than imported, for the same
 *  reason every other facade does it, stores/ must not reach up into app/, and
 *  handleAction is built late (it closes over the whole engine record). */
export const useCommandPaletteStore = defineStore("commandPalette", () => {
  const open = ref(false);
  const context = ref<"model" | "sketch">("model");

  let run: ((id: string) => void) | null = null;
  function bind(fn: (id: string) => void) {
    run = fn;
  }

  function show(ctx: "model" | "sketch") {
    context.value = ctx;
    open.value = true;
  }
  function close() {
    open.value = false;
  }
  function toggle(ctx: "model" | "sketch") {
    if (open.value) close();
    else show(ctx);
  }

  /** Close FIRST, then dispatch, several commands open a modal or start an
   *  interactive tool, and the palette must not still be over the top of it. */
  function runCommand(id: string) {
    close();
    run?.(id);
  }

  return { open, context, bind, show, close, toggle, runCommand };
});
