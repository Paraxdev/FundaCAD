<script setup lang="ts">
// The button, not a text field, is the control: the value column is 120px and typing invites paths that do not exist.
// Clear matters too, a moved or deleted heightmap fails every rebuild.

import { useId } from "vue";
import Button from "../ui/Button.vue";
import FieldRow from "../ui/FieldRow.vue";
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

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

const pickId = useId();
const clearId = useId();

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
  <FieldRow
    v-slot="{ labelId }"
    layout="param"
    :label="label"
    :for="null"
    control-class="param-file"
    :title="value || rowTitle"
  >
    <Button :id="pickId" class="file-pick" :aria-labelledby="`${labelId} ${pickId}`" @click="browse">{{
      value ? basename(value) : "Choose…"
    }}</Button>
    <IconButton
      v-if="value"
      :id="clearId"
      class="file-clear"
      icon="close"
      tip="Clear the file"
      size="sm"
      variant="plain"
      :icon-size="12"
      :aria-labelledby="`${labelId} ${clearId}`"
      @click="commit('')"
    />
  </FieldRow>
</template>
