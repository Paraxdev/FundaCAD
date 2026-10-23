<script setup lang="ts">
// Empty can mean something (a shell with no faces is sealed, a texture with none covers the body), describeTarget owns
// the wording. Edit hands off to features/targetEditTool, a profile area opens its feature's own tool instead.

import { computed } from "vue";
import Icon from "./Icon.vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue } from "../../app/useDoc";
import { describeTarget, readTarget, type TargetField } from "../../features/selectionTargets";

const props = defineProps<{ featureId: string; target: TargetField }>();

const engine = useEngine();

// useDocValue, not a computed: store.document keeps its identity across an in-place mutate, so a computed would see an
// equal value and skip the update (see app/useDoc.ts).
const count = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  return f ? readTarget(f, props.target).length : 0;
});

const summary = computed(() => describeTarget(props.target, count.value));

/** True while the editor is open on this row, so the button says so instead of offering a second one. */
const editing = computed(
  () =>
    engine.tools.targetEdit.active &&
    engine.tools.targetEdit.editingId === props.featureId &&
    engine.tools.targetEdit.field?.field === props.target.field,
);

function edit() {
  // toolBusy covers the editor too, so a second row is refused while one is open: two rollbacks at once is no state.
  if (engine.toolBusy()) return;
  if (props.target.shape === "regionPoint") {
    engine.editFeature(props.featureId);
    return;
  }
  engine.tools.targetEdit.start(props.featureId, props.target);
}
</script>

<template>
  <div class="param-row">
    <label>{{ target.label }}</label>
    <div class="param-value target-value">
      <span class="target-count" :class="{ 'target-empty': count === 0 }">{{ summary }}</span>
      <button
        type="button"
        class="target-edit"
        :disabled="editing"
        :title="editing ? 'Editing this selection' : `Change which ${target.kind}s this acts on`"
        @click="edit"
      >
        <Icon name="pen" :size="12" />
        Edit
      </button>
    </div>
  </div>
</template>
