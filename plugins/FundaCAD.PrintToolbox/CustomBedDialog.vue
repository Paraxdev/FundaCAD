<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from "vue";
import { readAs } from "fundacad";
import { Button, FieldRow, ModalFrame, NumberField } from "fundacad/ui";
import { parseCustomBedSize } from "./bedFit";
import type { CustomBedRequest } from "./customBedDialog";

const props = defineProps<{ req: CustomBedRequest }>();

const FIELDS = [
  { label: "Width", testid: "bed-custom-width" },
  { label: "Depth", testid: "bed-custom-depth" },
  { label: "Height", testid: "bed-custom-height" },
] as const;
const readLength = readAs("length");

const sizes = reactive<(number | null)[]>([...props.req.initial]);
// A field holding text that is no number keeps its last value, so its refusal is what Confirm judges it by.
const refused = reactive<(string | null)[]>(FIELDS.map(() => null));
const error = ref("");

// Inline, because a plugin has nowhere to ship a stylesheet.
const S = {
  form: { minWidth: "340px", display: "flex", flexDirection: "column", gap: "var(--s-3)" },
  error: { color: "var(--error)" },
} as const;

function confirm() {
  const bad = refused.findIndex((why) => why);
  if (bad >= 0) {
    error.value = `${FIELDS[bad]!.label}: ${refused[bad]}`;
    return;
  }
  const [width, depth, height] = sizes.map((v) => v ?? Number.NaN) as [number, number, number];
  const result = parseCustomBedSize(width, depth, height);
  if (!result.ok) {
    error.value = result.message;
    return;
  }
  props.req.resolve(result.size);
}
const cancel = () => props.req.resolve(null);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    confirm();
  }
}
onMounted(() => window.addEventListener("keydown", onKey, true));
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <ModalFrame panel-class="bed-custom-dialog" @close="cancel()">
    <template #title>Custom bed size</template>

    <div class="modal-body">
      <div :style="S.form">
        <FieldRow v-for="(f, i) in FIELDS" :key="f.label" v-slot="{ id }" :label="f.label">
          <NumberField
            :id="id"
            :label="f.label"
            unit="mm"
            size="sm"
            commit="live"
            nullable
            :parse="readLength"
            :model-value="sizes[i] ?? null"
            :data-testid="f.testid"
            :autofocus="i === 0 || undefined"
            @update:model-value="sizes[i] = $event"
            @error="refused[i] = $event"
          />
        </FieldRow>
        <div v-if="error" class="sm-hint" role="alert" :style="S.error" data-testid="bed-custom-error"
          >Error: {{ error }}</div
        >
      </div>
    </div>

    <div class="modal-foot">
      <Button data-testid="bed-custom-cancel" @click="cancel()">Cancel</Button>
      <Button variant="primary" data-testid="bed-custom-confirm" @click="confirm()">OK</Button>
    </div>
  </ModalFrame>
</template>
