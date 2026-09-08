<script setup lang="ts">
// A labelled row whose value is a path on disk.
//
// The fourth kind of row, and the one that existed nowhere: a feature could
// carry a file (a heightmap, so far) but only the tool that made it could
// choose one. Pick Heightmap in Properties on a committed texture and the
// pattern changed to one that reads an image, with no way to say which image,
// so the only route to a different picture was to delete the feature and make
// it again.
//
// The button, not the text, is the control. A path is long, the value column is
// 120px, and a text field would invite someone to type one, which is a way to
// author a path that does not exist. So the name of the file is shown and the
// dialog is what changes it, which is also what the tool panel does.
//
// Clearing matters as much as choosing: a heightmap you have moved or deleted
// leaves a feature that fails every rebuild, and Clear is the way back to a
// pattern that builds.

import { openDialog } from "../../plugins/host";
import { toast } from "../../ui/toast";

const props = defineProps<{
  label: string;
  value: string;
  commit: (value: string) => void;
  filters?: { name: string; extensions: string[] }[] | undefined;
  rowTitle?: string | undefined;
}>();

/** The last segment of a path, whichever separator it uses. The whole path is
 *  the row's tooltip, so nothing is hidden, only shortened. */
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

async function browse() {
  // The native dialog only exists in the desktop app. In a browser (the dev
  // server, a test) there is no filesystem to name, and a silent no-op would
  // read as a button that does not work.
  if (!("__TAURI_INTERNALS__" in window)) {
    toast("Choosing a file needs the desktop app", { kind: "warning" });
    return;
  }
  const picked = await openDialog(props.filters ? { filters: props.filters } : {});
  if (picked === null) return; // dismissed: keep what is there
  props.commit(picked);
}
</script>

<template>
  <div class="param-row" :title="value || rowTitle">
    <label>{{ label }}</label>
    <div class="param-value param-file">
      <button type="button" class="file-pick" @click="browse">
        {{ value ? basename(value) : "Choose…" }}
      </button>
      <button
        v-if="value"
        type="button"
        class="file-clear"
        title="Clear the file"
        @click="commit('')"
      >&times;</button>
    </div>
  </div>
</template>
