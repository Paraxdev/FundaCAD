<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { t } from "../../i18n";
import Segmented from "../ui/Segmented.vue";
import { a11yPrefs, asNoticeTime, onA11yPrefsChange, setA11yPref, type NoticeTime } from "../../ui/a11yPrefs";

const OPTIONS = computed<{ value: NoticeTime; label: string }[]>(() => [
  { value: "normal", label: t("prefs.notice.normal") },
  { value: "longer", label: t("prefs.notice.longer") },
  { value: "until-dismissed", label: t("prefs.notice.untilDismissed") },
]);

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
      <span class="pref-title">{{ t("prefs.notice.title") }}</span>
      <Segmented
        id="prefs-notice-time"
        :label="t('prefs.notice.title')"
        aria-describedby="prefs-notice-time-hint"
        :model-value="time"
        :options="OPTIONS"
        @update:model-value="pick"
      />
    </div>
    <p id="prefs-notice-time-hint" class="pref-hint">{{ t("prefs.notice.hint") }}</p>
  </div>
</template>
