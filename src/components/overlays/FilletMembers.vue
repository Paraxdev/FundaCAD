<script setup lang="ts">
// The Fillet and Chamfer member list, the only way to reach unresolved members (saved selectors whose edge the
// current geometry no longer draws).

import { onMounted, onUnmounted, shallowRef } from "vue";
import { useEngine } from "../../app/engineKey";
import Icon from "../shell/Icon.vue";
import Button from "../ui/Button.vue";
import Card from "../ui/Card.vue";
import IconButton from "../ui/IconButton.vue";
import SwitchRow from "../ui/SwitchRow.vue";
import { t } from "../../i18n";
import type { EdgeMemberRow } from "../../features/edgeFeatureTool";

const engine = useEngine();
const tool = () => engine.tools.edgeFeature;

const active = shallowRef(false);
const kind = shallowRef<"fillet" | "chamfer">("fillet");
const rows = shallowRef<EdgeMemberRow[]>([]);
const tangent = shallowRef(true);

function refresh(): boolean {
  const edge = tool();
  const on = edge.editingMembers();
  active.value = on;
  if (on) {
    rows.value = edge.memberRows();
    kind.value = edge.blendKind();
    tangent.value = edge.includesTangentEdges();
  } else {
    rows.value = [];
  }
  return on;
}

let raf = 0;
// Polled while a blend is edited: the tool mutates its member array imperatively on pointer events.
function tick() {
  raf = 0;
  if (refresh()) raf = requestAnimationFrame(tick);
}
function wake() {
  if (!raf) raf = requestAnimationFrame(tick);
}

let unsubs: (() => void)[] = [];
onMounted(() => {
  window.addEventListener("pointerup", wake);
  window.addEventListener("keyup", wake);
  unsubs = [engine.store.onBuild(() => wake()), engine.store.onDocChange(() => wake())];
  wake();
});
onUnmounted(() => {
  window.removeEventListener("pointerup", wake);
  window.removeEventListener("keyup", wake);
  for (const off of unsubs) off();
  unsubs = [];
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
});

function remove(key: string) {
  tool().removeMemberByKey(key);
  refresh();
  wake();
}
function setTangent(on: boolean) {
  tool().setIncludeTangentEdges(on);
  refresh();
  wake();
}
function add() {
  tool().promptAddMember();
}

const resolvedCount = () => rows.value.filter((r) => r.resolved).length;
const unresolvedCount = () => rows.value.filter((r) => !r.resolved).length;
</script>

<template>
  <Card
    v-if="active && rows.length"
    class="fm-card"
    role="group"
    :title="kind === 'fillet' ? t('tool.fillet') : t('tool.chamfer')"
  >
    <template #head-actions>
      <span class="fm-count">{{ t("rail.count.edge", { n: resolvedCount() }) }}</span>
      <span v-if="unresolvedCount()" class="fm-warn-count">{{ t("fillet.unresolved", { n: unresolvedCount() }) }}</span>
    </template>
    <ul class="fm-list">
      <li v-for="r in rows" :key="r.key" class="fm-row" :class="{ unresolved: !r.resolved }">
        <Icon :name="r.resolved ? 'edge' : 'warning'" :size="15" class="fm-mark" />
        <span class="fm-label">{{ r.label }}</span>
        <IconButton
          class="fm-x"
          icon="close"
          :tip="t('fillet.remove', { label: r.label })"
          size="sm"
          variant="danger"
          :icon-size="13"
          @pointerdown.prevent.stop="remove(r.key)"
        />
      </li>
    </ul>
    <template #foot>
      <SwitchRow
        class="fm-tangent"
        :label="t('fillet.includeTangent')"
        :model-value="tangent"
        @update:model-value="setTangent"
      />
      <Button class="fm-add" icon="plus" size="sm" block @pointerdown.prevent.stop="add()">{{
        t("fillet.addEdge")
      }}</Button>
    </template>
  </Card>
</template>
