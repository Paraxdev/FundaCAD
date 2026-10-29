<script setup lang="ts" generic="T extends string">
import { computed, ref, useId, useTemplateRef, watch } from "vue";
import Dialog from "./Dialog.vue";
import { useDisabled } from "./useDisabled";
import { useRovingFocus } from "./useRovingFocus";

const props = withDefaults(
  defineProps<{
    title: string;
    message?: string | undefined;
    options: readonly { value: T; label: string; hint?: string | undefined; primary?: boolean | undefined }[];
    /** Paints the primary choice, or the multi confirm, as destructive. */
    danger?: boolean;
    /** A checklist with Cancel and a confirm button instead of one button per choice. */
    multi?: boolean;
    /** Multi: the fewest ticks the confirm accepts. */
    min?: number;
    confirmLabel?: string;
    cancelLabel?: string;
  }>(),
  { message: undefined, danger: false, multi: false, min: 1, confirmLabel: "OK", cancelLabel: "Cancel" },
);
const emit = defineEmits<{ pick: [T]; confirm: [T[]]; cancel: [] }>();

const row = useTemplateRef<HTMLElement>("row");
const primary = computed(() => props.options.findIndex((o) => o.primary));
const messageId = useId();
const roving = useRovingFocus({
  items: () => props.options.map(() => ({ disabled: false })),
  active: primary,
  container: row,
});

const ticked = ref<boolean[]>([]);
watch(
  () => props.options,
  (opts) => (ticked.value = opts.map(() => false)),
  { immediate: true },
);
const picked = computed(() => props.options.filter((_, i) => ticked.value[i]).map((o) => o.value));
const ok = useDisabled({
  get disabled() {
    return picked.value.length < props.min;
  },
});
const confirm = ok.guard(() => emit("confirm", picked.value));
</script>

<template>
  <Dialog
    :title="title"
    size="sm"
    panel-class="ui-confirm"
    :initial-focus="!multi && primary >= 0 ? '.ui-confirm-primary' : 'first'"
    :described-by="message ? messageId : undefined"
    @close="emit('cancel')"
  >
    <template v-if="message || multi" #default>
      <p v-if="message" :id="messageId" class="ui-confirm-message">{{ message }}</p>
      <div v-if="multi" class="ui-confirm-checklist">
        <label v-for="(o, i) in options" :key="o.value" class="ui-confirm-check">
          <input v-model="ticked[i]" type="checkbox" />
          <span>{{ o.label }}</span>
          <small v-if="o.hint" class="ui-confirm-hint">{{ o.hint }}</small>
        </label>
      </div>
    </template>
    <template #footer>
      <div v-if="!multi" ref="row" class="ui-confirm-choices" role="group" @keydown="roving.onKeydown">
        <button
          v-for="(o, i) in options"
          :key="o.value"
          type="button"
          class="btn ui-confirm-choice"
          :class="{ 'btn-primary ui-confirm-primary': o.primary, 'ui-confirm-danger': danger && o.primary }"
          data-roving
          :tabindex="roving.tabindex(i)"
          @focus="roving.onFocus(i)"
          @click="emit('pick', o.value)"
        >
          <span>{{ o.label }}</span>
          <small v-if="o.hint" class="ui-confirm-hint">{{ o.hint }}</small>
        </button>
      </div>
      <template v-else>
        <button type="button" class="btn ui-confirm-cancel" @click="emit('cancel')">{{ cancelLabel }}</button>
        <button
          type="button"
          class="btn btn-primary ui-confirm-ok"
          :class="{ 'ui-confirm-danger': danger }"
          v-bind="ok.bind.value"
          @click="confirm"
        >
          {{ confirmLabel }}
        </button>
      </template>
    </template>
  </Dialog>
</template>
