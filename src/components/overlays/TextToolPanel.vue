<script setup lang="ts">
// DimInput is numeric only, so the sketch Text tool gets its own panel. Its inline styles came over verbatim from
// sketch/textPanel.ts, it has no stylesheet entry.

import { computed, onMounted, onUnmounted, reactive, useTemplateRef, type CSSProperties } from "vue";
import Icon from "../shell/Icon.vue";
import { initialTextForm, textFormErrors, textPanelPos, toTextValues } from "../../sketch/textForm";
import { useToolPanelStore, type TextReq } from "../../stores/toolPanels";

const props = defineProps<{ req: TextReq }>();
const panels = useToolPanelStore();

// App.vue keys this on req.id, so a second show() remounts and rebuilds the form from the new `initial`.
const form = reactive(initialTextForm(props.req.initial));
const pos = textPanelPos(props.req.screen, window);

const errors = computed(() => textFormErrors(form));
const ta = useTemplateRef<HTMLTextAreaElement>("ta");

function emitChange() {
  props.req.onChange(toTextValues(form));
}

function commit() {
  panels.commitText(toTextValues(form));
}

// Capture phase: Escape must cancel the text tool before SketchMode's global handler cancels something else.
function onEsc(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  panels.cancelText();
}

onMounted(() => {
  document.addEventListener("keydown", onEsc, true);
  ta.value?.focus();
});
onUnmounted(() => document.removeEventListener("keydown", onEsc, true));

const root: CSSProperties = {
  position: "fixed",
  zIndex: "50",
  padding: "8px",
  background: "#20242c",
  border: "1px solid #3a4150",
  borderRadius: "6px",
  boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
  font: "12px system-ui, sans-serif",
  color: "#dce3ee",
  width: "300px",
  maxWidth: "calc(100vw, 24px)",
  boxSizing: "border-box",
  colorScheme: "dark", // native <select> dropdown + number spinners render dark
  left: `${pos.left}px`,
  top: `${pos.top}px`,
};
const row: CSSProperties = { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" };
const field: CSSProperties = {
  background: "#161a20",
  color: "#dce3ee",
  border: "1px solid #3a4150",
  borderRadius: "3px",
  padding: "3px 5px",
  font: "inherit",
};
const lbl: CSSProperties = { whiteSpace: "nowrap", cursor: "pointer" };
const textArea: CSSProperties = { ...field, width: "100%", resize: "vertical" };
const fontSelect: CSSProperties = { ...field, flex: "1", minWidth: "0", maxWidth: "100%" };
const num: CSSProperties = { ...field, width: "56px" };
const wide: CSSProperties = { ...field, flex: "1", minWidth: "0" };
const bad: CSSProperties = { borderColor: "var(--error, #f0564a)" };
const problem: CSSProperties = { color: "var(--error, #f0564a)", fontSize: "11px", marginBottom: "6px" };
const btnRow: CSSProperties = { ...row, marginBottom: "0", justifyContent: "flex-end" };
const btn: CSSProperties = {
  color: "#fff",
  border: "none",
  borderRadius: "4px",
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
};
const okBtn: CSSProperties = { ...btn, background: "#2b6" };
const noBtn: CSSProperties = { ...btn, background: "#555" };
</script>

<template>
  <Teleport to="body">
    <div :style="root">
      <textarea
        ref="ta"
        v-model="form.text"
        rows="2"
        placeholder="Text…"
        :style="textArea"
        @input="emitChange"
        @change="emitChange"
        @keydown.enter.ctrl.prevent="commit"
        @keydown.enter.meta.prevent="commit"
      ></textarea>
      <div style="height: 6px"></div>

      <div :style="row">
        <select v-model="form.font" :style="fontSelect" @input="emitChange" @change="emitChange">
          <option value="">Default font</option>
          <option v-for="f in req.fonts" :key="f" :value="f">{{ f }}</option>
        </select>
      </div>

      <div :style="row">
        <label :style="lbl">Size</label>
        <input
          v-model="form.height"
          type="text"
          inputmode="decimal"
          :title="errors.height"
          :style="[num, errors.height ? bad : {}]"
          @input="emitChange"
          @change="emitChange"
        />
        <label :style="lbl">Angle°</label>
        <input
          v-model="form.angle"
          type="text"
          inputmode="decimal"
          :title="errors.angle"
          :style="[num, errors.angle ? bad : {}]"
          @input="emitChange"
          @change="emitChange"
        />
      </div>

      <div :style="row">
        <label :style="lbl">B</label>
        <input v-model="form.bold" type="checkbox" @input="emitChange" @change="emitChange" />
        <label :style="lbl">I</label>
        <input v-model="form.italic" type="checkbox" @input="emitChange" @change="emitChange" />
        <select v-model="form.align" :style="field" @input="emitChange" @change="emitChange">
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </select>
      </div>

      <div :style="row">
        <label :style="lbl">Box width (mm)</label>
        <input
          v-model="form.boxWidth"
          type="text"
          inputmode="decimal"
          placeholder="0 = no box"
          :title="errors.boxWidth"
          :style="[wide, errors.boxWidth ? bad : {}]"
          @input="emitChange"
          @change="emitChange"
        />
      </div>

      <div v-for="(msg, k) in errors" :key="k" :style="problem" data-testid="text-field-error">{{ msg }}</div>

      <!-- pointerdown, not click: the buttons have to act before the field next
           to them can blur, or a commit loses the last keystroke. -->
      <div :style="btnRow">
        <button :style="okBtn" @pointerdown.prevent.stop="commit"><Icon name="check" :size="13" /> Add</button>
        <button :style="noBtn" aria-label="Cancel" @pointerdown.prevent.stop="panels.cancelText()">
          <Icon name="close" :size="13" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
