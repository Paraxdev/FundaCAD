<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import Checkbox from "../ui/Checkbox.vue";
import Segmented from "../ui/Segmented.vue";
import Select from "../ui/Select.vue";
import { fmtKeys } from "../../input/platform";
import {
  a11yPrefs,
  asInterfaceSize,
  INTERFACE_SIZES,
  onA11yPrefsChange,
  setA11yPref,
  type ViewportLabels,
} from "../../ui/a11yPrefs";

const size = ref(a11yPrefs().interfaceSize);
const comfortable = ref(a11yPrefs().comfortableText);
const labels = ref(a11yPrefs().viewportLabels);
let off: (() => void) | null = null;
onMounted(() => {
  off = onA11yPrefsChange(() => {
    size.value = a11yPrefs().interfaceSize;
    comfortable.value = a11yPrefs().comfortableText;
    labels.value = a11yPrefs().viewportLabels;
  });
});
onUnmounted(() => off?.());

const SIZE_OPTIONS = INTERFACE_SIZES.map((s) => ({
  value: String(s),
  label: `${s}%`,
}));
function pickSize(v: string) {
  const n = asInterfaceSize(v);
  if (n !== null) setA11yPref("interfaceSize", n);
}
const LABEL_OPTIONS: { value: ViewportLabels; label: string }[] = [
  { value: "s", label: "Small" },
  { value: "m", label: "Medium" },
  { value: "l", label: "Large" },
  { value: "xl", label: "Extra large" },
];
const sizeKeys = fmtKeys("Ctrl+Plus and Ctrl+Minus step it from anywhere in the app, and Ctrl+0 puts it back to 100%.");
</script>

<template>
  <div class="pref-card" data-a11y-size="interface">
    <div class="pref-head">
      <label class="pref-title" for="prefs-interface-size">Interface size</label>
      <Select
        id="prefs-interface-size"
        label="Interface size"
        aria-describedby="prefs-interface-size-hint"
        :model-value="String(size)"
        :options="SIZE_OPTIONS"
        @update:model-value="pickSize"
      />
    </div>
    <p id="prefs-interface-size-hint" class="pref-hint">
      Makes every panel, menu and label larger or smaller. {{ sizeKeys }}
    </p>
  </div>
  <div class="pref-card" data-a11y-size="comfortable">
    <Checkbox
      id="prefs-comfortable-text"
      class="pref-head pref-check"
      aria-describedby="prefs-comfortable-text-hint"
      :model-value="comfortable"
      @update:model-value="(on: boolean) => setA11yPref('comfortableText', on)"
      ><span class="pref-title">Comfortable text</span></Checkbox
    >
    <p id="prefs-comfortable-text-hint" class="pref-hint">
      Spaces lines, letters and words further apart, which some people with low vision or dyslexia read more easily.
      Buttons and labels grow to fit.
    </p>
  </div>
  <!-- Wide: four worded sizes cut each other short in a 290 px card once the Interface size passes 125 percent. -->
  <div class="pref-card wide" data-a11y-size="labels">
    <div class="pref-head">
      <span class="pref-title">Viewport labels</span>
    </div>
    <Segmented
      id="prefs-viewport-labels"
      label="Viewport labels"
      aria-describedby="prefs-viewport-labels-hint"
      :model-value="labels"
      :options="LABEL_OPTIONS"
      @update:model-value="(v: ViewportLabels) => setA11yPref('viewportLabels', v)"
    />
    <p id="prefs-viewport-labels-hint" class="pref-hint">
      Sizes the sketch dimensions, constraint marks and plane names drawn over the model, and the view cube.
    </p>
  </div>
</template>
