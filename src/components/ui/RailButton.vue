<script setup lang="ts">
import { computed, useId } from "vue";
import Icon from "../shell/Icon.vue";
import KeyChip from "./KeyChip.vue";
import { fmtKeys } from "../../input/platform";
import { useDisabled } from "./useDisabled";

const props = withDefaults(
  defineProps<{
    icon: string;
    label: string;
    /** the variant last used, or a hint such as the sketch being edited */
    sub?: string | undefined;
    keys?: string | undefined;
    active?: boolean;
    /** A toggle: sets `aria-pressed`. Its `sub` is then the state word, so it stays out of the name. */
    pressed?: boolean | undefined;
    /** has a flyout of variants */
    menu?: boolean;
    /** Opens a popup of this kind: sets `aria-haspopup` and `aria-expanded`, never `aria-pressed`. */
    popup?: "dialog" | "menu" | "listbox" | true | undefined;
    expanded?: boolean;
    disabled?: boolean;
    disabledReason?: string | undefined;
    clickable?: boolean;
    /** show the label pill beside the tile */
    labelled?: boolean;
    /** A tooltip other than the name, such as a group's tool count. The accessible name stays the label. */
    tip?: string | undefined;
    /** Words for the accessible name only, such as which tool of a family is on. */
    spoken?: string | undefined;
    iconSize?: number;
  }>(),
  {
    sub: "",
    keys: "",
    active: false,
    pressed: undefined,
    menu: false,
    popup: undefined,
    expanded: false,
    disabled: false,
    disabledReason: undefined,
    clickable: false,
    labelled: true,
    tip: undefined,
    spoken: undefined,
    iconSize: 22,
  },
);

const d = useDisabled(props);
const reasonId = useId();
const text = (sub: string) =>
  [props.label, sub, props.keys ? `(${fmtKeys(props.keys)})` : ""].filter(Boolean).join(" ");
const toggle = computed(() => props.pressed !== undefined && !props.popup);
const name = computed(() => {
  const base = text(toggle.value ? "" : props.sub);
  return props.spoken ? `${base}, ${props.spoken}` : base;
});
const spokenReason = computed(() => (d.isDisabled.value && props.disabledReason ? props.disabledReason : ""));
</script>

<template>
  <button
    v-bind="d.bind.value"
    type="button"
    class="rail-btn"
    :class="{ active, disabled }"
    :title="d.title(tip ?? text(sub))"
    :aria-label="name"
    :aria-pressed="toggle ? pressed : undefined"
    :aria-haspopup="popup || undefined"
    :aria-expanded="popup ? expanded : undefined"
    :aria-describedby="spokenReason ? reasonId : undefined"
  >
    <span class="rail-tile">
      <Icon :name="icon" :size="iconSize" />
      <span v-if="menu" class="rail-corner" aria-hidden="true"></span>
    </span>
    <span v-if="labelled" class="rail-pill">
      <span class="rail-line">
        <span class="rail-label">{{ label }}</span>
        <KeyChip v-if="keys" :keys="keys" in-title />
      </span>
      <span v-if="sub" class="rail-sub">{{ sub }}</span>
    </span>
    <span v-if="spokenReason" :id="reasonId" class="sr-only">{{ spokenReason }}</span>
  </button>
</template>
