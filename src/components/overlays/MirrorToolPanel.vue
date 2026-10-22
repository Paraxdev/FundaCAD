<script setup lang="ts">
// The sketch MirrorFlow and the 3D MirrorTool own the picking and push a fresh view on every change.

import { computed } from "vue";
import type { MirrorPanelView } from "../../stores/toolPanels";
import FloatingPanel from "./FloatingPanel.vue";
import IconButton from "../ui/IconButton.vue";
import Icon from "../shell/Icon.vue";

const props = defineProps<{ view: MirrorPanelView }>();

const waitingFor = computed(() =>
  props.view.ready
    ? undefined
    : `Pick ${props.view.fields
        .filter((f) => !f.filled)
        .map((f) => f.label.toLowerCase())
        .join(" and ")} first`,
);
</script>

<template>
  <!-- No close on Esc: the tool owns Escape. Pointer presses keep focus off the buttons so Enter still applies. -->
  <FloatingPanel :open="true" panel-class="mirror-panel">
    <div class="measure-title">Mirror</div>
    <div
      v-for="f in view.fields"
      :key="f.key"
      class="mirror-field"
      :class="{ active: view.active === f.key }"
      :data-field="f.key"
      @pointerdown.prevent
      @click="view.onActivate(f.key)"
    >
      <IconButton :icon="f.icon" :title="`Pick ${f.label.toLowerCase()}`" :active="view.active === f.key" :size="16" />
      <span class="mirror-field-k">{{ f.label }}</span>
      <span class="mirror-field-v">{{ f.value }}</span>
      <button
        type="button"
        class="float-card-close"
        :title="`Clear ${f.label.toLowerCase()}`"
        :aria-label="`Clear ${f.label.toLowerCase()}`"
        :disabled="!f.filled"
        @click.stop="view.onClear(f.key)"
      >
        <Icon name="close" :size="14" />
      </button>
    </div>
    <div v-if="view.planes.length" class="mirror-chips">
      <button
        v-for="p in view.planes"
        :key="p"
        type="button"
        class="rd-chip"
        :class="{ active: view.plane === p }"
        :aria-pressed="view.plane === p"
        @pointerdown.prevent
        @click="view.onPlane(p)"
      >
        {{ p }}
      </button>
    </div>
    <div class="mirror-actions">
      <button type="button" class="btn" @pointerdown.prevent @click="view.onCancel()">Cancel</button>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="!view.ready"
        :title="waitingFor"
        @pointerdown.prevent
        @click="view.onCommit()"
      >
        <Icon name="check" :size="14" />
        Mirror
      </button>
    </div>
    <div class="measure-hint">Enter to apply · Shift adds more · Tab switches field · Esc to cancel</div>
  </FloatingPanel>
</template>
