<script setup lang="ts">
// The sketch MirrorFlow and the 3D MirrorTool own the picking and push a fresh view on every change.

import { computed } from "vue";
import type { MirrorPanelView } from "../../stores/toolPanels";
import PickList from "./PickList.vue";
import Button from "../ui/Button.vue";
import Segmented from "../ui/Segmented.vue";

const props = defineProps<{ view: MirrorPanelView }>();

const waitingFor = computed(() =>
  props.view.ready
    ? undefined
    : `Pick ${props.view.fields
        .filter((f) => !f.filled)
        .map((f) => f.label.toLowerCase())
        .join(" and ")} first`,
);

const emptyText = (key: string) => (key === "objects" ? "Click geometry to add" : "Click to set");
</script>

<template>
  <!-- Docked like the target editor. No close on Esc: the tool owns Escape. Pointer presses keep focus off the buttons so Enter still applies. -->
  <aside class="tgt-panel mirror-panel" role="dialog" aria-label="Mirror selection" @pointerdown.prevent>
    <div class="tgt-head">
      <span class="tgt-title">Mirror</span>
      <span class="tgt-sub">{{ view.fields[0].value }}</span>
    </div>

    <PickList
      v-for="f in view.fields"
      :key="f.key"
      :data-field="f.key"
      :label="f.label"
      :rows="f.items.map((label) => ({ label }))"
      :active="view.active === f.key"
      :empty="view.active === f.key ? emptyText(f.key) : 'Nothing picked'"
      @click="view.onActivate(f.key)"
      @clear="view.onClear(f.key)"
      @remove="view.onRemove(f.key, $event)"
    />

    <div v-if="view.planes.length" class="mirror-chips">
      <Segmented
        :model-value="view.plane ?? ''"
        :options="view.planes.map((p) => ({ value: p, label: p }))"
        label="Mirror plane"
        variant="chips"
        size="sm"
        @update:model-value="view.onPlane($event)"
      />
    </div>

    <div class="tgt-actions">
      <Button
        class="tgt-done"
        variant="primary"
        :disabled="!view.ready"
        :disabled-reason="waitingFor"
        @click="view.onCommit()"
      >
        Mirror
      </Button>
      <Button class="tgt-cancel" @click="view.onCancel()">Cancel</Button>
    </div>
    <div class="tgt-hint">Enter: next list, then apply · Shift adds to Objects · Esc cancels</div>
  </aside>
</template>
