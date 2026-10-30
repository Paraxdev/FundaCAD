<script setup lang="ts">
import { onMounted, onUnmounted, ref, type Directive } from "vue";
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

const CONTRAST = [
  { value: "system", label: "Follow system" },
  { value: "standard", label: "Standard" },
  { value: "more", label: "More" },
  { value: "maximum", label: "Maximum" },
];
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
      <span class="pref-title">Contrast</span>
      <Segmented
        id="prefs-contrast"
        label="Contrast"
        aria-describedby="prefs-contrast-hint"
        :model-value="choice"
        :options="CONTRAST"
        @update:model-value="pickContrast"
      />
    </div>
    <p id="prefs-contrast-hint" class="pref-hint">
      More brightens muted text and control edges and widens the focus ring, Maximum draws all text, lines and edges in
      the full text colour. Follow system takes More while a Windows contrast theme, Increase contrast on macOS or High
      contrast on GNOME is on.
      <template v-if="choice === 'system'"
        >Right now the system asks for {{ osMore ? "more" : "standard" }} contrast.</template
      >
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
      ><span class="pref-title">Solid panels</span></Checkbox
    >
    <p id="prefs-solid-panels-hint" class="pref-hint">
      Panels, menus and the floating cards draw opaque instead of glass, so no model colour shows through behind their
      text. More and Maximum contrast turn it on.
    </p>
  </div>
</template>
