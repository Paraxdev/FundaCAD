<script setup lang="ts">
// What an assistant connected over MCP may do to the document that is open.
//
// This was written out in src/components/overlays/PreferencesDialog.vue, above
// the plugin list, on every machine — including the ones where nothing had ever
// connected and nothing ever would. A control that decides nothing is worse
// than a missing one: it is a question about a feature that is not there, and
// five lines of explanation for it.
//
// It is contributed now, by the plugin it is about, so it appears exactly when
// there is something for it to govern.

import { onMounted, onUnmounted, ref } from "vue";
import {
  asLiveEditingMode,
  liveEditingMode,
  onLiveEditingChange,
  setLiveEditingMode,
} from "../../src/ui/liveEditing";

const live = ref(liveEditingMode());
let off: (() => void) | null = null;
onMounted(() => { off = onLiveEditingChange(() => { live.value = liveEditingMode(); }); });
onUnmounted(() => off?.());

function onLive(ev: Event) {
  const v = asLiveEditingMode((ev.target as HTMLSelectElement).value);
  if (v) setLiveEditingMode(v);
}
</script>

<template>
  <label class="prefs-row">
    <span class="prefs-label">Live document</span>
    <select id="prefs-live" :value="live" @change="onLive">
      <option value="off">Do not share</option>
      <option value="read">Share, read only</option>
      <option value="edit">Share, and allow edits</option>
    </select>
  </label>
  <div class="sm-hint">
    An assistant works on the open document rather than on a copy. Each edit is
    one undo, and the title bar says who is connected.
  </div>
</template>
