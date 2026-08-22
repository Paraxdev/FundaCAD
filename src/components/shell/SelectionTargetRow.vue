<script setup lang="ts">
// A labelled row whose value is GEOMETRY: "Edges — 4 edges — Edit".
//
// The other half of a feature. Every row beside this one edits a number or a
// choice; this one shows what the feature is applied to, which until now was
// picked once at creation and then invisible for the rest of the document's
// life. A fillet that caught one edge too many was cheaper to delete and redo
// than to correct, because there was nothing to correct it with.
//
// The count is not a decoration and not always a count: several targets mean
// something specific when EMPTY — a shell with no faces is a sealed hollow, a
// texture with none covers the whole body — so the row says that instead of
// "0 faces". features/selectionTargets.describeTarget owns the wording.
//
// Pressing Edit hands the whole gesture to features/targetEditTool, which rolls
// the model back to before this feature so the geometry it consumed is on screen
// to be clicked. Nothing about that lives here.

import { computed } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue } from "../../app/useDoc";
import { describeTarget, readTarget, type TargetField } from "../../features/selectionTargets";

const props = defineProps<{ featureId: string; target: TargetField }>();

const engine = useEngine();

// useDocValue rather than a computed over the feature: store.document keeps the
// same object identity across an in-place mutate, so a plain computed recomputes
// to a value === its last one and Vue short-circuits the notification — the
// hazard app/useDoc.ts documents, and the reason a set edited in the viewport
// would leave this row showing the old count.
const count = useDocValue((doc) => {
  const f = doc.features.find((x) => x.id === props.featureId);
  return f ? readTarget(f, props.target).length : 0;
});

const summary = computed(() => describeTarget(props.target, count.value));

/** True while the editor is open on THIS row, so the button says so rather than
 *  offering to open a second one. */
const editing = computed(
  () =>
    engine.tools.targetEdit.active &&
    engine.tools.targetEdit.editingId === props.featureId &&
    engine.tools.targetEdit.field?.field === props.target.field,
);

function edit() {
  // toolBusy covers the editor itself, so this also refuses a second row while
  // one is open — which is the right answer: two rollbacks at once is not a
  // state the document has.
  if (engine.toolBusy()) return;
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
        Edit
      </button>
    </div>
  </div>
</template>
