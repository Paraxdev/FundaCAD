<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { t } from "../../i18n";
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
const LABEL_OPTIONS = computed<{ value: ViewportLabels; label: string }[]>(() => [
  { value: "s", label: t("prefs.viewportLabels.small") },
  { value: "m", label: t("prefs.viewportLabels.medium") },
  { value: "l", label: t("prefs.viewportLabels.large") },
  { value: "xl", label: t("prefs.viewportLabels.extraLarge") },
]);
const sizeKeys = computed(() => fmtKeys(t("prefs.size.keys")));
</script>

<template>
  <div class="pref-card" data-a11y-size="interface">
    <div class="pref-head">
      <label class="pref-title" for="prefs-interface-size">{{ t("prefs.size.title") }}</label>
      <Select
        id="prefs-interface-size"
        :label="t('prefs.size.title')"
        aria-describedby="prefs-interface-size-hint"
        :model-value="String(size)"
        :options="SIZE_OPTIONS"
        @update:model-value="pickSize"
      />
    </div>
    <p id="prefs-interface-size-hint" class="pref-hint">{{ t("prefs.size.hint", { keys: sizeKeys }) }}</p>
  </div>
  <div class="pref-card" data-a11y-size="comfortable">
    <Checkbox
      id="prefs-comfortable-text"
      class="pref-head pref-check"
      aria-describedby="prefs-comfortable-text-hint"
      :model-value="comfortable"
      @update:model-value="(on: boolean) => setA11yPref('comfortableText', on)"
      ><span class="pref-title">{{ t("prefs.comfortable.title") }}</span></Checkbox
    >
    <p id="prefs-comfortable-text-hint" class="pref-hint">{{ t("prefs.comfortable.hint") }}</p>
  </div>
  <!-- Wide: four worded sizes cut each other short in a 290 px card once the Interface size passes 125 percent. -->
  <div class="pref-card wide" data-a11y-size="labels">
    <div class="pref-head">
      <span class="pref-title">{{ t("prefs.viewportLabels.title") }}</span>
    </div>
    <Segmented
      id="prefs-viewport-labels"
      :label="t('prefs.viewportLabels.title')"
      aria-describedby="prefs-viewport-labels-hint"
      :model-value="labels"
      :options="LABEL_OPTIONS"
      @update:model-value="(v: ViewportLabels) => setA11yPref('viewportLabels', v)"
    />
    <p id="prefs-viewport-labels-hint" class="pref-hint">{{ t("prefs.viewportLabels.hint") }}</p>
  </div>
</template>
