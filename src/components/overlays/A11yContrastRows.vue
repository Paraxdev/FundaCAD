<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Directive } from "vue";
import { t } from "../../i18n";
import Checkbox from "../ui/Checkbox.vue";
import Segmented from "../ui/Segmented.vue";
import { a11yPrefs, asContrast, onA11yPrefsChange, setA11yPref } from "../../ui/a11yPrefs";
import { onOsAppearanceChange, osAppearance } from "../../ui/osTheme";
import { contrastSetting } from "../../ui/contrastSetting";
import { solidPanelsOn } from "../../ui/glassBlur";

const choice = ref(a11yPrefs().contrast);
const osMore = ref(osAppearance().contrast);
const solid = ref(solidPanelsOn());
const implied = ref(contrastSetting() !== "standard");

function sync() {
  choice.value = a11yPrefs().contrast;
  osMore.value = osAppearance().contrast;
  solid.value = solidPanelsOn();
  implied.value = contrastSetting() !== "standard";
}
const stops: (() => void)[] = [];
onMounted(() => stops.push(onA11yPrefsChange(sync), onOsAppearanceChange(sync)));
onUnmounted(() => stops.splice(0).forEach((stop) => stop()));

const CONTRAST = computed(() => [
  { value: "system", label: t("prefs.contrast.system") },
  { value: "standard", label: t("prefs.contrast.standard") },
  { value: "more", label: t("prefs.contrast.more") },
  { value: "maximum", label: t("prefs.contrast.maximum") },
]);
const osLevel = computed(() => (osMore.value ? "more" : "standard"));
function pickContrast(id: string) {
  const v = asContrast(id);
  if (v) setA11yPref("contrast", v);
}
function setSolid(on: boolean) {
  setA11yPref("solidPanels", on);
}

// Note: Checkbox puts fallthrough attributes on its label, so the box itself takes the hint here.
const vBoxHint: Directive<HTMLElement, string> = {
  mounted(el, { value }) {
    el.querySelector("input[type=checkbox]")?.setAttribute("aria-describedby", value);
  },
};
</script>

<template>
  <div class="pref-card wide" data-a11y-contrast>
    <div class="pref-head pref-wrap">
      <span class="pref-title">{{ t("prefs.contrast.title") }}</span>
      <Segmented
        id="prefs-contrast"
        :label="t('prefs.contrast.title')"
        aria-describedby="prefs-contrast-hint"
        :model-value="choice"
        :options="CONTRAST"
        @update:model-value="pickContrast"
      />
    </div>
    <p id="prefs-contrast-hint" class="pref-hint">
      {{ t("prefs.contrast.hint") }}
      <template v-if="choice === 'system'">{{ t("prefs.contrast.systemNow", { level: osLevel }) }}</template>
    </p>
  </div>
  <div class="pref-card">
    <Checkbox
      id="prefs-solid-panels"
      v-box-hint="'prefs-solid-panels-hint'"
      class="pref-head pref-check"
      :model-value="solid"
      :disabled="implied"
      @update:model-value="setSolid"
      ><span class="pref-title">{{ t("prefs.solid.title") }}</span></Checkbox
    >
    <p id="prefs-solid-panels-hint" class="pref-hint">{{ t("prefs.solid.hint") }}</p>
  </div>
</template>
