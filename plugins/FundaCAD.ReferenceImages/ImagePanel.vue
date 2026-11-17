<script setup lang="ts">
// The selected image's settings, and the distance box of a calibration.

import { computed, nextTick, onUnmounted, reactive, ref, useTemplateRef, watch } from "vue";
import { numberText, useEngine } from "fundacad";
import { Button, Checkbox, FieldRow, NumberField, Panel, Slider, Switch } from "fundacad/ui";
import { heightOf, withWidth } from "./calibrate";
import { MIN_OPACITY, readRefImage, type RefImage } from "./refImage";
import { calibrating, selected, tool } from "./state";

const engine = useEngine();
const list = ref<RefImage[]>([]);
const off = engine.store.onReferenceImagesChange((l) => {
  list.value = l.map(readRefImage).filter((r): r is RefImage => r !== null);
  if (selected.value && !list.value.some((r) => r.id === selected.value)) selected.value = null;
});
onUnmounted(off);

const r = computed(() => list.value.find((x) => x.id === (calibrating.value?.id ?? selected.value)) ?? null);
const step = computed(() => calibrating.value?.stage ?? null);
const body = useTemplateRef<HTMLElement>("body");
const distance = ref<number | null>(null);
// A number field refuses typed text itself and says why, the reasons land here by field, with the calibration's own.
const refused = reactive<Record<string, string | null>>({});
const problems = computed(() => Object.values(refused).filter((why): why is string => !!why));

function refuse(key: string, label: string, why: string | null) {
  refused[key] = why && `${label}: ${why}`;
}

watch(step, async (s) => {
  for (const k of Object.keys(refused)) delete refused[k];
  distance.value = null;
  if (s === "distance") {
    await nextTick();
    body.value?.querySelector<HTMLInputElement>("[data-field=distance]")?.focus();
  }
});

function set(change: Partial<RefImage>, coalesce?: string) {
  if (r.value) tool.value?.write(r.value.id, change, coalesce);
}

function onWidth(width: number | null) {
  const next = r.value && width !== null ? withWidth(r.value, width) : null;
  if (next) set({ width: next.width });
}

function onDistance(value: number | null) {
  if (value === null) return;
  const why = tool.value?.finishCalibrate(String(value)) ?? null;
  refused.finish = why;
}

function onDistanceKey(ev: KeyboardEvent) {
  if (ev.key === "Escape") tool.value?.cancel();
}

const positive = (v: number) => (v > 0 ? null : "Type a length above zero");

const prompt = computed(() =>
  step.value === "first"
    ? "Click the first point on the image."
    : step.value === "second"
      ? "Click the second point."
      : step.value === "distance"
        ? "The real distance between them:"
        : null,
);
</script>

<template>
  <Panel :open="!!r" :title="r?.name" panel-class="ref-image-window">
    <div v-if="r" ref="body" class="ref-image-panel" data-panel="reference-image">
      <template v-if="prompt">
        <div class="ref-image-prompt" role="status">{{ prompt }}</div>
        <FieldRow v-if="step === 'distance'" v-slot="{ id }" layout="param" label="Distance">
          <NumberField
            :id="id"
            v-model="distance"
            data-field="distance"
            label="Distance"
            unit="mm"
            size="sm"
            commit="change"
            placeholder="100 mm"
            :validate="positive"
            @update:model-value="onDistance"
            @keydown="onDistanceKey"
            @error="refuse('distance', 'Distance', $event)"
          />
        </FieldRow>
      </template>
      <template v-else>
        <FieldRow v-slot="{ id }" layout="param" label="Width">
          <NumberField
            :id="id"
            data-field="width"
            label="Width"
            unit="mm"
            size="sm"
            commit="change"
            :model-value="r.width"
            :disabled="r.locked"
            :validate="positive"
            @update:model-value="onWidth"
            @error="refuse('width', 'Width', $event)"
          />
        </FieldRow>
        <FieldRow layout="param" label="Height" :for="null">
          <span>{{ numberText(heightOf(r)) }} mm</span>
        </FieldRow>
        <FieldRow v-slot="{ id }" layout="param" label="Angle">
          <NumberField
            :id="id"
            data-field="angle"
            label="Angle"
            unit="deg"
            size="sm"
            commit="change"
            :model-value="r.angle"
            :disabled="r.locked"
            @update:model-value="(a) => a !== null && set({ angle: a })"
            @error="refuse('angle', 'Angle', $event)"
          />
        </FieldRow>
        <FieldRow v-slot="{ labelId }" layout="param" label="Opacity" :for="null">
          <Slider
            :labelledby="labelId"
            data-field="opacity"
            unit="%"
            :min="MIN_OPACITY * 100"
            :max="100"
            show-value
            :model-value="Math.round(r.opacity * 100)"
            @update:model-value="set({ opacity: $event / 100 }, 'opacity')"
            @commit="tool?.endGesture()"
          />
        </FieldRow>
        <div class="ref-image-flip">
          <Checkbox
            data-field="flipX"
            :model-value="!!r.flipX"
            :disabled="r.locked"
            @update:model-value="set({ flipX: $event })"
            >Flip X</Checkbox
          >
          <Checkbox
            data-field="flipY"
            :model-value="!!r.flipY"
            :disabled="r.locked"
            @update:model-value="set({ flipY: $event })"
            >Flip Y</Checkbox
          >
        </div>
        <FieldRow v-slot="{ id }" layout="param" label="Lock">
          <Switch
            :id="id"
            data-field="locked"
            label="Lock"
            :model-value="r.locked"
            @update:model-value="set({ locked: !r.locked })"
          />
        </FieldRow>
        <div v-if="!r.locked" class="measure-hint">Shift drag the image to move it.</div>
      </template>
      <div v-for="why in problems" :key="why" class="ref-image-problem" role="alert">Error: {{ why }}</div>
    </div>
    <template #foot>
      <template v-if="r && prompt">
        <Button data-action="cancel" @click="tool?.cancel()">Cancel</Button>
      </template>
      <template v-else-if="r">
        <Button data-action="close" @click="selected = null">Close</Button>
        <Button variant="primary" data-action="calibrate" :disabled="r.locked" @click="tool?.startCalibrate(r.id)">
          Calibrate
        </Button>
      </template>
    </template>
  </Panel>
</template>
