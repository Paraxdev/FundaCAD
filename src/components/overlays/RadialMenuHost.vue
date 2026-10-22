<script setup lang="ts">
import { computed } from "vue";
import { useRadialMenuStore } from "../../stores/radialMenu";
import { radialSlot, RADIAL_DEADZONE_PX } from "../../ui/radialMenu";
import Icon from "../shell/Icon.vue";

const store = useRadialMenuStore();
const slots = computed(() => {
  const st = store.state;
  if (!st) return [];
  return st.items.map((it, i) => ({ it, i, ...radialSlot(i, st.items.length) }));
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.state"
      class="radial-menu"
      role="menu"
      data-radial-menu
      :style="{ left: `${store.state.x}px`, top: `${store.state.y}px` }"
    >
      <div
        class="radial-hub"
        :style="{ width: `${RADIAL_DEADZONE_PX * 2}px`, height: `${RADIAL_DEADZONE_PX * 2}px` }"
      ></div>
      <div
        v-for="s in slots"
        :key="s.i"
        class="radial-item"
        role="menuitem"
        :aria-disabled="s.it.disabled || undefined"
        :class="{ hot: store.state.hot === s.i, disabled: s.it.disabled, danger: s.it.danger }"
        :style="{ transform: `translate(calc(${s.x}px - 50%), calc(${s.y}px - 50%))` }"
      >
        <Icon v-if="s.it.icon" :name="s.it.icon" :size="16" />
        <span class="radial-label">{{ s.it.label }}</span>
        <Icon v-if="s.it.children?.length" name="caretRight" :size="10" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.radial-menu {
  position: fixed;
  width: 0;
  height: 0;
  z-index: 1000;
  pointer-events: none;
}
.radial-hub {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: color-mix(in srgb, var(--float-bg-solid) 70%, transparent);
}
.radial-item {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  white-space: nowrap;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  background: var(--float-bg-solid);
  color: var(--text);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.25);
}
.radial-item.hot {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 22%, var(--float-bg-solid));
}
.radial-item.disabled {
  opacity: 0.45;
}
.radial-item.danger .radial-label {
  color: var(--danger, #e5484d);
}
</style>
