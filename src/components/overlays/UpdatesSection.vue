<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import Select from "../ui/Select.vue";
import { updatesSupported } from "../../ui/updates";
import {
  asUpdatePeriod,
  autoUpdateCheck,
  onUpdatePrefsChange,
  setAutoUpdateCheck,
  setUpdatePeriod,
  UPDATE_PERIODS,
  updatePeriod,
} from "../../ui/updatePrefs";

const auto = ref(autoUpdateCheck());
const period = ref(updatePeriod());
// Null until the install is known, so no control flashes in for an install that cannot update itself.
const supported = ref<boolean | null>(null);
const options = UPDATE_PERIODS.map((p) => ({ value: p.id, label: p.label }));

let stop = () => {};
onMounted(() => {
  stop = onUpdatePrefsChange(() => {
    auto.value = autoUpdateCheck();
    period.value = updatePeriod();
  });
  void updatesSupported().then((ok) => (supported.value = ok));
});
onUnmounted(() => stop());

function onAuto(ev: Event) {
  setAutoUpdateCheck((ev.target as HTMLInputElement).checked);
}
function onPeriod(v: string) {
  const p = asUpdatePeriod(v);
  if (p) setUpdatePeriod(p);
}
</script>

<template>
  <h3 class="prefs-pane-title">Updates</h3>
  <div class="prefs-grid">
    <div v-if="supported === false" class="pref-card wide" data-updates-unsupported>
      <p class="pref-hint">
        This install updates through its package manager, the GitHub releases page or the SourceForge mirror.
      </p>
    </div>
    <template v-else-if="supported">
      <div class="pref-card">
        <label class="pref-head pref-check">
          <span class="check">
            <input id="prefs-update-auto" type="checkbox" :checked="auto" @change="onAuto" />
            <span class="check-box"></span>
          </span>
          <span class="pref-title">Check for updates automatically</span>
        </label>
        <p class="pref-hint">Off sends nothing until you use Help > Check for Updates.</p>
      </div>
      <div class="pref-card">
        <div class="pref-head">
          <label class="pref-title" for="prefs-update-period">Check</label>
          <Select
            id="prefs-update-period"
            :model-value="period"
            :options="options"
            :disabled="!auto"
            @update:model-value="onPeriod"
          />
        </div>
      </div>
    </template>
  </div>
</template>
