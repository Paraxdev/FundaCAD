<script setup lang="ts">
import { computed } from "vue";
import Select from "../ui/Select.vue";
import { languageChoices, languageFileStatus, languageSetting, setLanguage, t, type MessageKey } from "../../i18n";
import { MAX_OVERRIDE_BYTES, type OverrideResult } from "../../i18n/overrides";

const FILE_ERRORS: Record<NonNullable<OverrideResult["error"]>, MessageKey> = {
  "too-large": "prefs.language.error.tooLarge",
  "not-json": "prefs.language.error.notJson",
  "not-flat": "prefs.language.error.notFlat",
};

const fileError = computed(() => {
  const error = languageFileStatus()?.error;
  return error ? t(FILE_ERRORS[error], { kb: MAX_OVERRIDE_BYTES / 1024 }) : "";
});

function pick(next: string) {
  void setLanguage(next);
}
</script>

<template>
  <div class="pref-card wide">
    <div class="pref-head">
      <label class="pref-title" for="prefs-language">{{ t("prefs.language.title") }}</label>
      <Select
        id="prefs-language"
        :label="t('prefs.language.title')"
        aria-describedby="prefs-language-hint"
        :model-value="languageSetting()"
        :options="languageChoices()"
        @update:model-value="pick"
      />
    </div>
    <p id="prefs-language-hint" class="pref-hint">{{ t("prefs.language.hint") }}</p>
    <p id="prefs-language-error" class="pref-hint prefs-theme-error" role="alert">{{ fileError }}</p>
  </div>
</template>
