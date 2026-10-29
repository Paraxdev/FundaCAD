<script setup lang="ts">
import { computed, inject, mergeProps, onMounted, onUnmounted, useSlots, useTemplateRef } from "vue";
import { fmtKeys } from "../../input/platform";
import Icon from "../shell/Icon.vue";
import Menu from "./Menu.vue";
import { MENU, type MenuEntry } from "./menuContext";
import { useDisabled } from "./useDisabled";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    label: string;
    icon?: string | undefined;
    keys?: string | undefined;
    tip?: string | undefined;
    /** A toggle: the row becomes a menuitemcheckbox, and every row of its menu keeps the check gutter. */
    checked?: boolean | undefined;
    danger?: boolean;
    disabled?: boolean;
    disabledReason?: string | undefined;
  }>(),
  { icon: undefined, keys: undefined, tip: undefined, checked: undefined, disabledReason: undefined },
);
const emit = defineEmits<{ select: [] }>();
// The default slot holds the submenu's items.
const slots = useSlots();

const ctx = inject(MENU, null);
if (!ctx) throw new Error("MenuItem must sit inside a Menu");

const row = useTemplateRef<HTMLElement>("row");
const d = useDisabled(props);
const me: MenuEntry = {
  el: () => row.value,
  disabled: () => d.isDisabled.value,
  label: () => props.label,
  checkable: () => props.checked !== undefined,
  hasSub: () => !!slots.default,
  select: () => emit("select"),
};
let unregister = () => {};
onMounted(() => (unregister = ctx.register(me)));
onUnmounted(() => unregister());

const subOpen = computed(() => ctx.openItem.value === me);
const hasSub = computed(() => !!slots.default);
</script>

<template>
  <div
    ref="row"
    v-bind="mergeProps($attrs, d.bind.value)"
    class="ui-menu-item"
    :class="{ 'is-danger': danger, 'is-open': subOpen }"
    :role="checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
    :aria-checked="checked === undefined ? undefined : checked"
    :aria-haspopup="hasSub ? 'menu' : undefined"
    :aria-expanded="hasSub ? subOpen : undefined"
    :aria-keyshortcuts="keys"
    :title="d.title(tip)"
    :tabindex="ctx.tabindex(me)"
    data-roving
    @click="ctx.activate(me)"
    @focus="ctx.onItemFocus(me)"
    @pointerenter="ctx.hoverItem(me)"
  >
    <span v-if="ctx.hasChecks.value" class="ui-menu-check">
      <Icon v-if="checked" name="check" :size="12" />
    </span>
    <Icon v-if="icon" class="ui-menu-icon" :name="icon" :size="14" />
    <span class="ui-menu-label">{{ label }}</span>
    <span v-if="keys" class="ui-menu-keys">{{ fmtKeys(keys) }}</span>
    <Icon v-if="hasSub" class="ui-menu-caret" name="caretRight" :size="10" />
  </div>
  <Menu
    v-if="hasSub && subOpen"
    submenu
    :anchor="row"
    side="right"
    :gap="2"
    :label="label"
    :focus="ctx.subFocus.value ? 'first' : 'none'"
    @close="ctx.closeSub()"
  >
    <slot />
  </Menu>
</template>
