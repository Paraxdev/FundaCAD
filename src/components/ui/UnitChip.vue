<script setup lang="ts">
import { computed } from "vue";
import Select from "./Select.vue";
import { unitById } from "../../ui/measure";

const props = withDefaults(
  defineProps<{
    /** A ui/measure unit id shows its label ("deg" as °), any other text shows as written. */
    unit: string;
    /** Unit ids to pick from. Without them the chip is a caption. */
    options?: readonly string[] | undefined;
    /** The picker's name, and the caption's title. */
    tip?: string | undefined;
    keys?: string | undefined;
    disabled?: boolean | undefined;
    disabledReason?: string | undefined;
  }>(),
  { tip: undefined, disabled: false },
);
const emit = defineEmits<{ "update:unit": [string] }>();

const label = (id: string) => unitById(id)?.label ?? id;
const choices = computed(() => (props.options ?? []).map((id) => ({ value: id, label: label(id) })));
</script>

<template>
  <Select
    v-if="choices.length"
    variant="chip"
    size="sm"
    :model-value="unit"
    :options="choices"
    :tip="tip ?? 'Unit'"
    :keys="keys"
    :disabled="disabled"
    :disabled-reason="disabledReason"
    @update:model-value="emit('update:unit', $event)"
  />
  <span v-else class="ui-unit-chip" :title="tip">{{ label(unit) }}</span>
</template>
