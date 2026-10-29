<script setup lang="ts">
// The button, not a text field, is the control: the value column is 120px and typing invites paths that do not exist.
// Clear matters too, a moved or deleted heightmap fails every rebuild.

import Button from "../ui/Button.vue";
import IconButton from "../ui/IconButton.vue";
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
  // The native dialog exists only in the desktop app, and a silent no-op in a browser would read as a broken button.
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
      <Button class="file-pick" @click="browse">{{ value ? basename(value) : "Choose…" }}</Button>
      <IconButton
        v-if="value"
        class="file-clear"
        icon="close"
        tip="Clear the file"
        size="sm"
        variant="plain"
        :icon-size="12"
        @click="commit('')"
      />
    </div>
  </div>
</template>
