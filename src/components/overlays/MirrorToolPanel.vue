<script setup lang="ts">
// The sketch MirrorFlow and the 3D MirrorTool own the picking and push a fresh view on every change.

import { computed } from "vue";
import { t } from "../../i18n";
import type { MirrorPanelView } from "../../stores/toolPanels";
import PickList from "./PickList.vue";
import Button from "../ui/Button.vue";
import Segmented from "../ui/Segmented.vue";

const props = defineProps<{ view: MirrorPanelView }>();

// Only the 3D tool offers base plane chips, so they tell a mirror plane from a sketch's mirror line.
const waitingFor = computed(() => {
  const filled = (key: string) => props.view.fields.some((f) => f.key === key && f.filled);
  const objects = filled("objects");
  const line = filled("line");
  if (props.view.ready || (objects && line)) return undefined;
  const missing = objects ? "line" : line ? "objects" : "both";
  return t("mirror.waiting", { missing, what: props.view.planes.length ? "plane" : "line" });
});

const emptyText = (key: string) => (key === "objects" ? t("ui.pickList.clickToAdd") : t("mirror.clickToSet"));

// Segmented ignores a pick of the value it holds, yet picking the plane again still hands the next click to Objects.
// Capture phase, so the chip still reads as checked when its own click runs.
function onChipClick(e: MouseEvent) {
  const checked = (e.target as Element).closest('[role="radio"]')?.getAttribute("aria-checked") === "true";
  if (checked && props.view.plane) props.view.onPlane(props.view.plane);
}
</script>

<template>
  <!-- Docked like the target editor. No close on Esc: the tool owns Escape. Pointer presses keep focus off the buttons so Enter still applies. -->
  <aside class="tgt-panel mirror-panel" role="dialog" :aria-label="t('mirror.panelLabel')" @pointerdown.prevent>
    <div class="tgt-head">
      <span class="tgt-title">{{ t("tool.mirror") }}</span>
      <span class="tgt-sub">{{ view.fields[0].value }}</span>
    </div>

    <PickList
      v-for="f in view.fields"
      :key="f.key"
      :data-field="f.key"
      :label="f.label"
      :rows="f.items.map((label) => ({ label }))"
      :active="view.active === f.key"
      :empty="view.active === f.key ? emptyText(f.key) : t('mirror.nothingPicked')"
      @click="view.onActivate(f.key)"
      @clear="view.onClear(f.key)"
      @remove="view.onRemove(f.key, $event)"
    />

    <div v-if="view.planes.length" class="mirror-chips" @click.capture="onChipClick">
      <Segmented
        :model-value="view.plane ?? ''"
        :options="view.planes.map((p) => ({ value: p, label: p }))"
        :label="t('mirror.planeChips')"
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
        {{ t("mirror.apply") }}
      </Button>
      <Button class="tgt-cancel" @click="view.onCancel()">{{ t("common.cancel") }}</Button>
    </div>
    <div class="tgt-hint">{{ t("mirror.panelHint") }}</div>
  </aside>
</template>
