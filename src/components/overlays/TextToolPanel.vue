<script setup lang="ts">
// Floating panel for the sketch Text tool. DimInput is numeric-only, so text
// gets its own small panel: a multi-line string, a system-font picker (fonts
// come from the sidecar's listFonts op), size, bold/italic, alignment and
// rotation. On every edit it fires onChange for a live preview; Add/Enter
// commits, Cancel/Esc cancels.
//
// Replaces the DOM half of sketch/textPanel.ts, which stays as the facade
// SketchMode calls. The inline styles are carried over verbatim rather than
// promoted to SCSS: this panel has never had a stylesheet entry, and inventing
// one in the same commit as the port would make the port unreviewable.

import { onMounted, onUnmounted, reactive, useTemplateRef, type CSSProperties } from "vue";
import Icon from "../shell/Icon.vue";
import { initialTextForm, textPanelPos, toTextValues } from "../../sketch/textForm";
import { useToolPanelStore, type TextReq } from "../../stores/toolPanels";

const props = defineProps<{ req: TextReq }>();
const panels = useToolPanelStore();

// Local form state. App.vue keys this component on req.id, so a second show()
// remounts it and this is rebuilt from the new `initial`, there is no reset
// path to get wrong, and no chance of a stale field surviving into a different
// text object.
const form = reactive(initialTextForm(props.req.initial));
const pos = textPanelPos(props.req.screen, window);

const ta = useTemplateRef<HTMLTextAreaElement>("ta");

function emitChange() {
  props.req.onChange(toTextValues(form));
}

function commit() {
  panels.commitText(toTextValues(form));
}

// Capture phase, matching the class: Escape has to cancel the text tool before
// it reaches SketchMode's own global handler and cancels something else.
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

// --- inline styles, carried over from the class verbatim ------------------
const root: CSSProperties = {
  position: "fixed", zIndex: "50", padding: "8px",
  background: "#20242c", border: "1px solid #3a4150", borderRadius: "6px",
  boxShadow: "0 6px 20px rgba(0,0,0,0.4)", font: "12px system-ui, sans-serif",
  color: "#dce3ee", width: "300px", maxWidth: "calc(100vw, 24px)", boxSizing: "border-box",
  colorScheme: "dark", // native <select> dropdown + number spinners render dark
  left: `${pos.left}px`, top: `${pos.top}px`,
};
const row: CSSProperties = { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" };
const field: CSSProperties = {
  background: "#161a20", color: "#dce3ee", border: "1px solid #3a4150",
  borderRadius: "3px", padding: "3px 5px", font: "inherit",
};
const lbl: CSSProperties = { whiteSpace: "nowrap", cursor: "pointer" };
const textArea: CSSProperties = { ...field, width: "100%", resize: "vertical" };
const fontSelect: CSSProperties = { ...field, flex: "1", minWidth: "0", maxWidth: "100%" };
const num: CSSProperties = { ...field, width: "56px" };
const wide: CSSProperties = { ...field, flex: "1", minWidth: "0" };
const btnRow: CSSProperties = { ...row, marginBottom: "0", justifyContent: "flex-end" };
const btn: CSSProperties = { color: "#fff", border: "none", borderRadius: "4px", padding: "4px 10px", cursor: "pointer", font: "inherit" };
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
        <input v-model="form.height" type="number" min="0.1" :style="num" @input="emitChange" @change="emitChange" />
        <label :style="lbl">Angle°</label>
        <input v-model="form.angle" type="number" :style="num" @input="emitChange" @change="emitChange" />
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
          v-model="form.boxWidth" type="number" min="0" step="0.5" placeholder="0 = no box"
          :style="wide" @input="emitChange" @change="emitChange"
        />
      </div>

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
