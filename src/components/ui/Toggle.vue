<script setup lang="ts">
import Icon from "../shell/Icon.vue";

const props = withDefaults(defineProps<{ modelValue: boolean; label: string; icon?: string; disabled?: boolean }>(), {
  icon: "",
  disabled: false,
});
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

function flip() {
  if (!props.disabled) emit("update:modelValue", !props.modelValue);
}
</script>

<template>
  <div class="float-toggle" :class="{ disabled }" @click="flip">
    <span class="ft-label">
      <Icon v-if="icon" :name="icon" :size="16" />
      {{ label }}
    </span>
    <span class="ft-state">{{ modelValue ? "On" : "Off" }}</span>
    <button
      type="button"
      role="switch"
      class="ft-switch"
      :class="{ on: modelValue }"
      :aria-checked="modelValue"
      :aria-label="label"
      :disabled="disabled"
      @click.stop="flip"
    ><i></i></button>
  </div>
</template>
