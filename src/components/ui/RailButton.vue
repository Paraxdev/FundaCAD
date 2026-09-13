<script setup lang="ts">
import { computed } from "vue";
import Icon from "../shell/Icon.vue";
import KeyChip from "./KeyChip.vue";

const props = withDefaults(
  defineProps<{
    icon: string;
    label: string;
    /** the variant last used, or a hint such as the sketch being edited */
    sub?: string | undefined;
    keys?: string | undefined;
    active?: boolean;
    /** has a flyout of variants */
    menu?: boolean;
    disabled?: boolean;
    /** show the label pill beside the tile */
    labelled?: boolean;
  }>(),
  { sub: "", keys: "", active: false, menu: false, disabled: false, labelled: true },
);

const title = computed(() => [props.label, props.sub, props.keys ? `(${props.keys})` : ""].filter(Boolean).join(" "));
</script>

<template>
  <button
    type="button"
    class="rail-btn"
    :class="{ active, disabled }"
    :disabled="disabled"
    :title="title"
    :aria-label="title"
  >
    <span class="rail-tile">
      <Icon :name="icon" :size="22" />
      <span v-if="menu" class="rail-corner" aria-hidden="true"></span>
    </span>
    <span v-if="labelled" class="rail-pill">
      <span class="rail-line">
        <span class="rail-label">{{ label }}</span>
        <KeyChip v-if="keys" :keys="keys" />
      </span>
      <span v-if="sub" class="rail-sub">{{ sub }}</span>
    </span>
  </button>
</template>
