import { defineStore } from "pinia";
import { ref } from "vue";

/** The dispatcher is bound by the engine, not imported: stores/ must not reach up into app/, and handleAction is built
 *  late. */
export const useCommandPaletteStore = defineStore("commandPalette", () => {
  const open = ref(false);
  const context = ref<"model" | "sketch">("model");

  let run: ((id: string) => void) | null = null;
  function bind(fn: (id: string) => void) {
    run = fn;
  }

  let labelFor: (id: string) => string | null = () => null;
  /** A provider for commands whose label names the document's state, as Undo names its step; null keeps the label. */
  function bindLabels(fn: (id: string) => string | null) {
    labelFor = fn;
  }
  const labelOf = (c: { id: string; label: string }) => labelFor(c.id) ?? c.label;

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

  /** Close first: several commands open a modal or start a tool the palette must not cover. */
  function runCommand(id: string) {
    close();
    run?.(id);
  }

  return { open, context, bind, bindLabels, labelOf, show, close, toggle, runCommand };
});
