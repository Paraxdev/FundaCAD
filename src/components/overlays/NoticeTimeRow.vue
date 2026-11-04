<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import Segmented from "../ui/Segmented.vue";
import { a11yPrefs, asNoticeTime, onA11yPrefsChange, setA11yPref, type NoticeTime } from "../../ui/a11yPrefs";

const OPTIONS: { value: NoticeTime; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "longer", label: "Longer" },
  { value: "until-dismissed", label: "Until dismissed" },
];

const time = ref<NoticeTime>(a11yPrefs().noticeTime);
let stop: (() => void) | undefined;
onMounted(() => {
  stop = onA11yPrefsChange(() => {
    time.value = a11yPrefs().noticeTime;
  });
});
onUnmounted(() => stop?.());

function pick(id: string) {
  const v = asNoticeTime(id);
  if (v) setA11yPref("noticeTime", v);
}
</script>

<template>
  <div class="pref-card wide">
    <div class="pref-head pref-wrap">
      <span class="pref-title">Notification time</span>
      <Segmented
        id="prefs-notice-time"
        label="Notification time"
        aria-describedby="prefs-notice-time-hint"
        :model-value="time"
        :options="OPTIONS"
        @update:model-value="pick"
      />
    </div>
    <p id="prefs-notice-time-hint" class="pref-hint">
      How long messages at the bottom of the window and in the title bar stay. Pointing at one or moving focus into it
      holds it, and one with a button stays at least 15 seconds. Until dismissed keeps each until you close it.
    </p>
  </div>
</template>
