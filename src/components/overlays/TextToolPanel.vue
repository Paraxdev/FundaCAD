<script setup lang="ts">
// DimInput is numeric only, so the sketch Text tool gets its own panel.

import { computed, onMounted, onUnmounted, reactive, useId, useTemplateRef } from "vue";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import IconButton from "../ui/IconButton.vue";
import Segmented from "../ui/Segmented.vue";
import Select from "../ui/Select.vue";
import TextField from "../ui/TextField.vue";
import {
  initialTextForm,
  textFormErrors,
  textPanelPos,
  toTextValues,
  type TextForm,
  type TextValues,
} from "../../sketch/textForm";
import { useToolPanelStore, type TextReq } from "../../stores/toolPanels";
import { claimEscape } from "../../ui/escapeClaim";

const props = defineProps<{ req: TextReq }>();
const panels = useToolPanelStore();

// App.vue keys this on req.id, so a second show() remounts and rebuilds the form from the new `initial`.
const form = reactive(initialTextForm(props.req.initial));
const pos = textPanelPos(props.req.screen, window);
const at = { left: `${pos.left}px`, top: `${pos.top}px` };

const errors = computed(() => textFormErrors(form));
const ta = useTemplateRef<InstanceType<typeof TextField>>("ta");
const id = useId();

const fonts = computed(() => [
  { value: "", label: "Default font" },
  ...props.req.fonts.map((f) => ({ value: f, label: f })),
]);
const aligns: { value: TextValues["align"]; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

// Every edit feeds the live preview.
function set<K extends keyof TextForm>(key: K, value: TextForm[K]) {
  form[key] = value;
  props.req.onChange(toTextValues(form));
}

function commit() {
  panels.commitText(toTextValues(form));
}

// Capture phase: Escape must cancel the text tool before SketchMode's global handler cancels something else. An open
// list inside the panel takes the Escape first, on the window, so it closes the list only.
function onEsc(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  panels.cancelText();
}

// The window's other Escape listeners skip a focused text field only, so a focused list, box or button here claims it.
const root = useTemplateRef<HTMLElement>("root");
let release: (() => void) | null = null;
function onFocusIn() {
  release ??= claimEscape();
}
function onFocusOut(e: FocusEvent) {
  if (root.value?.contains(e.relatedTarget as Node | null)) return;
  release?.();
  release = null;
}

// The global keymap skips a focused text field only, so a key typed on the font list, a box or a button stops here
// rather than starting a tool. Shortcuts with Ctrl or Cmd still pass.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape" && !e.ctrlKey && !e.metaKey) e.stopPropagation();
}

onMounted(() => {
  document.addEventListener("keydown", onEsc, true);
  ta.value?.focus();
});
onUnmounted(() => {
  document.removeEventListener("keydown", onEsc, true);
  release?.();
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="float-card text-tool-panel"
      :style="at"
      @focusin="onFocusIn"
      @focusout="onFocusOut"
      @keydown="onKeydown"
    >
      <TextField
        ref="ta"
        class="text-tool-text"
        :model-value="form.text"
        multiline
        rows="2"
        placeholder="Text…"
        aria-label="Text"
        @update:model-value="set('text', $event)"
        @keydown.enter.ctrl.prevent="commit"
        @keydown.enter.meta.prevent="commit"
      />

      <Select
        :model-value="form.font"
        :options="fonts"
        size="sm"
        tip="Font"
        @update:model-value="set('font', $event)"
      />

      <div class="text-tool-row">
        <label class="text-tool-label" :for="`${id}-height`">Size</label>
        <TextField
          :id="`${id}-height`"
          class="text-tool-num"
          :model-value="form.height"
          size="sm"
          inputmode="decimal"
          :error="errors.height"
          @update:model-value="set('height', $event)"
        />
        <label class="text-tool-label" :for="`${id}-angle`">Angle°</label>
        <TextField
          :id="`${id}-angle`"
          class="text-tool-num"
          :model-value="form.angle"
          size="sm"
          inputmode="decimal"
          :error="errors.angle"
          @update:model-value="set('angle', $event)"
        />
      </div>

      <div class="text-tool-row">
        <Checkbox :model-value="form.bold" label="B" tip="Bold" @update:model-value="set('bold', $event)" />
        <Checkbox :model-value="form.italic" label="I" tip="Italic" @update:model-value="set('italic', $event)" />
        <Segmented
          :model-value="form.align"
          :options="aligns"
          label="Alignment"
          size="sm"
          @update:model-value="set('align', $event)"
        />
      </div>

      <div class="text-tool-row">
        <label class="text-tool-label" :for="`${id}-box`">Box width (mm)</label>
        <TextField
          :id="`${id}-box`"
          class="text-tool-wide"
          :model-value="form.boxWidth"
          size="sm"
          inputmode="decimal"
          placeholder="0 = no box"
          :error="errors.boxWidth"
          @update:model-value="set('boxWidth', $event)"
        />
      </div>

      <div v-for="(msg, k) in errors" :key="k" class="text-tool-problem" data-testid="text-field-error">{{ msg }}</div>

      <!-- pointerdown, not click: the buttons have to act before the field next
           to them can blur, or a commit loses the last keystroke. -->
      <div class="text-tool-actions">
        <Button class="text-tool-add" variant="primary" size="sm" icon="check" @pointerdown.prevent.stop="commit">
          Add
        </Button>
        <IconButton
          class="text-tool-cancel"
          icon="close"
          tip="Cancel"
          size="md"
          variant="plain"
          @pointerdown.prevent.stop="panels.cancelText()"
        />
      </div>
    </div>
  </Teleport>
</template>
