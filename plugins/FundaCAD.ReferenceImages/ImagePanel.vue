<script setup lang="ts">
// The selected image's settings, and the distance box of a calibration.

import { computed, nextTick, onUnmounted, ref, watch, type CSSProperties } from "vue";
import { displayRound, fieldNumber, useEngine } from "fundacad";
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
const error = ref<string | null>(null);
const distance = ref<HTMLInputElement | null>(null);

watch(step, async (s) => {
  error.value = null;
  if (s === "distance") {
    await nextTick();
    distance.value?.focus();
  }
});

function set(change: Partial<RefImage>, coalesce?: string) {
  if (r.value) tool.value?.write(r.value.id, change, coalesce);
}

function onWidth(ev: Event) {
  const el = ev.target as HTMLInputElement;
  const next = r.value ? withWidth(r.value, fieldNumber(el.value)) : null;
  if (next) set({ width: next.width });
  else el.value = String(displayRound(r.value?.width ?? 0));
}

function onAngle(ev: Event) {
  const el = ev.target as HTMLInputElement;
  const a = fieldNumber(el.value);
  if (Number.isFinite(a)) set({ angle: a });
  else el.value = String(r.value?.angle ?? 0);
}

function onDistance(ev: KeyboardEvent) {
  if (ev.key === "Escape") {
    tool.value?.cancel();
    return;
  }
  if (ev.key !== "Enter") return;
  error.value = tool.value?.finishCalibrate((ev.target as HTMLInputElement).value) ?? null;
}

const prompt = computed(() =>
  step.value === "first"
    ? "Click the first point on the image."
    : step.value === "second"
      ? "Click the second point."
      : step.value === "distance"
        ? "The real distance between them:"
        : null,
);

const root: CSSProperties = {
  position: "fixed",
  bottom: "60px",
  right: "16px",
  zIndex: "50",
  padding: "8px",
  background: "var(--panel, #20242c)",
  border: "1px solid var(--line-strong, #3a4150)",
  borderRadius: "var(--r-md, 6px)",
  boxShadow: "var(--shadow-2, 0 6px 20px rgba(0,0,0,0.4))",
  font: "12px system-ui, sans-serif",
  color: "var(--text, #dce3ee)",
  width: "260px",
  maxWidth: "calc(100vw - 24px)",
  boxSizing: "border-box",
};
const title: CSSProperties = {
  fontWeight: "600",
  marginBottom: "6px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const row: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "72px 1fr",
  gap: "6px",
  alignItems: "center",
  marginBottom: "4px",
};
const muted: CSSProperties = { color: "var(--text-mute, #8b93a3)", marginBottom: "6px" };
const errorStyle: CSSProperties = { color: "var(--error, #ff5c5c)", marginTop: "4px" };
const field: CSSProperties = {
  background: "var(--panel-2, #161a20)",
  color: "var(--text, #dce3ee)",
  border: "1px solid var(--line-strong, #3a4150)",
  borderRadius: "var(--r-sm, 3px)",
  padding: "3px 4px",
  font: "inherit",
  width: "100%",
  boxSizing: "border-box",
  minWidth: "0",
};
const btn: CSSProperties = {
  border: "none",
  borderRadius: "var(--r-sm, 4px)",
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
};
const okBtn: CSSProperties = { ...btn, background: "var(--accent, #2b6)", color: "var(--on-accent, #fff)" };
const noBtn: CSSProperties = { ...btn, background: "var(--raised, #555)", color: "var(--text, #fff)" };
const actions: CSSProperties = { display: "flex", gap: "6px", justifyContent: "flex-end", marginTop: "8px" };
</script>

<template>
  <Teleport v-if="r" to="body">
    <div data-panel="reference-image" :style="root">
      <div :style="title" :title="r.name">{{ r.name }}</div>
      <template v-if="prompt">
        <div :style="muted">{{ prompt }}</div>
        <input
          v-if="step === 'distance'"
          ref="distance"
          data-field="distance"
          :style="field"
          placeholder="100 mm"
          @keydown="onDistance"
        />
        <div v-if="error" :style="errorStyle">{{ error }}</div>
        <div :style="actions">
          <button :style="noBtn" data-action="cancel" @click="tool?.cancel()">Cancel</button>
        </div>
      </template>
      <template v-else>
        <label :style="row">
          <span>Width</span>
          <input
            data-field="width"
            :style="field"
            :value="displayRound(r.width)"
            :disabled="r.locked"
            @change="onWidth"
          />
        </label>
        <div :style="row">
          <span>Height</span>
          <span>{{ displayRound(heightOf(r)) }} mm</span>
        </div>
        <label :style="row">
          <span>Angle</span>
          <input data-field="angle" :style="field" :value="r.angle" :disabled="r.locked" @change="onAngle" />
        </label>
        <label :style="row">
          <span>Opacity</span>
          <input
            data-field="opacity"
            type="range"
            :min="MIN_OPACITY * 100"
            max="100"
            :value="Math.round(r.opacity * 100)"
            @input="set({ opacity: Number(($event.target as HTMLInputElement).value) / 100 }, 'opacity')"
            @change="tool?.endGesture()"
          />
        </label>
        <div :style="row">
          <span>Flip</span>
          <span>
            <label
              ><input
                data-field="flipX"
                type="checkbox"
                :checked="r.flipX"
                :disabled="r.locked"
                @change="set({ flipX: !r.flipX })"
              />
              X</label
            >
            <label style="margin-left: 10px"
              ><input
                data-field="flipY"
                type="checkbox"
                :checked="r.flipY"
                :disabled="r.locked"
                @change="set({ flipY: !r.flipY })"
              />
              Y</label
            >
          </span>
        </div>
        <label :style="row">
          <span>Lock</span>
          <input data-field="locked" type="checkbox" :checked="r.locked" @change="set({ locked: !r.locked })" />
        </label>
        <div v-if="!r.locked" :style="muted">Shift drag the image to move it.</div>
        <div :style="actions">
          <button :style="noBtn" data-action="close" @click="selected = null">Close</button>
          <button :style="okBtn" data-action="calibrate" :disabled="r.locked" @click="tool?.startCalibrate(r.id)"
            >Calibrate</button
          >
        </div>
      </template>
    </div>
  </Teleport>
</template>
