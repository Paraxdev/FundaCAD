<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import Checkbox from "../ui/Checkbox.vue";
import Select from "../ui/Select.vue";
import { fmtKeys } from "../../input/platform";
import { a11yPrefs, asInterfaceSize, INTERFACE_SIZES, onA11yPrefsChange, setA11yPref } from "../../ui/a11yPrefs";

const size = ref(a11yPrefs().interfaceSize);
const comfortable = ref(a11yPrefs().comfortableText);
let off: (() => void) | null = null;
onMounted(() => {
  off = onA11yPrefsChange(() => {
    size.value = a11yPrefs().interfaceSize;
    comfortable.value = a11yPrefs().comfortableText;
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
</template>
