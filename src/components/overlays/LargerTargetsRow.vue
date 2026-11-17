<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { t } from "../../i18n";
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
</script>

<template>
  <div class="pref-card">
    <Checkbox
      id="prefs-larger-targets"
      aria-describedby="prefs-larger-targets-hint"
      class="pref-head pref-check"
      :model-value="on"
      @update:model-value="setLargeTargets"
      ><span class="pref-title">{{ t("prefs.targets.title") }}</span></Checkbox
    >
    <p id="prefs-larger-targets-hint" class="pref-hint">{{ t("prefs.targets.hint") }}</p>
  </div>
</template>
