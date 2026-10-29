<script setup lang="ts">
import { onMounted, onUnmounted, ref, type Directive } from "vue";
import Checkbox from "../ui/Checkbox.vue";
import { onA11yPrefsChange } from "../../ui/a11yPrefs";
import { largeTargetsOn, setLargeTargets } from "../../ui/targets";

const on = ref(largeTargetsOn());
let stop: (() => void) | undefined;
onMounted(() => {
  stop = onA11yPrefsChange(() => {
    on.value = largeTargetsOn();
  });
});
onUnmounted(() => stop?.());

// Note: Checkbox puts fallthrough attributes on its label, so the box itself takes the hint here.
const vBoxHint: Directive<HTMLElement, string> = {
  mounted(el, { value }) {
    el.querySelector("input[type=checkbox]")?.setAttribute("aria-describedby", value);
  },
};
</script>

<template>
  <div class="pref-card">
    <Checkbox
      id="prefs-larger-targets"
      v-box-hint="'prefs-larger-targets-hint'"
      class="pref-head pref-check"
      :model-value="on"
      @update:model-value="setLargeTargets"
      ><span class="pref-title">Larger click targets</span></Checkbox
    >
    <p id="prefs-larger-targets-hint" class="pref-hint">
      Every button, box and handle reacts to the pointer over about 32 pixels, the size a finger gets, so a shaky hand
      or a head pointer hits it more easily. Nothing moves or changes size on screen.
    </p>
  </div>
</template>
