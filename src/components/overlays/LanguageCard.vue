<script setup lang="ts">
import { computed, ref } from "vue";
import Button from "../ui/Button.vue";
import Select from "../ui/Select.vue";
import { pickFile } from "../ui/dom";
import {
  languageChoices,
  languageFileSource,
  languageFileStatus,
  languageSetting,
  loadLanguageFile,
  removeLanguageFile,
  setLanguage,
  t,
  type MessageKey,
} from "../../i18n";
import type { DropInFileError } from "../../i18n/catalog";
import { MAX_LINE_CHARS, MAX_OVERRIDE_BYTES, shownKey } from "../../i18n/overrides";

const SHOWN_SKIPS = 5;

const FILE_ERRORS: Record<DropInFileError, MessageKey> = {
  "too-large": "prefs.language.error.tooLarge",
  "not-json": "prefs.language.error.notJson",
  "not-flat": "prefs.language.error.notFlat",
  "bad-name": "prefs.language.error.badName",
  unreadable: "prefs.language.error.unreadable",
  storage: "prefs.language.error.storage",
};

const browser = languageFileSource() === "browser";
const problem = ref<DropInFileError | null>(null);
const status = computed(() => languageFileStatus());

const fileError = computed(() => {
  const error = problem.value ?? status.value?.error;
  return error ? t(FILE_ERRORS[error], { kb: MAX_OVERRIDE_BYTES / 1024 }) : "";
});

const skipped = computed(() => (status.value?.error ? [] : (status.value?.skipped ?? [])));

// Select option keys are plain words, so the reason's dash goes.
const skipLines = computed(() =>
  skipped.value.slice(0, SHOWN_SKIPS).map(({ key, reason }) =>
    t("prefs.language.skip", {
      key: shownKey(key),
      reason: reason.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
      max: MAX_LINE_CHARS,
    }),
  ),
);

function pick(next: string) {
  problem.value = null;
  void setLanguage(next);
}

async function loadFile() {
  const file = await pickFile("application/json,.json");
  if (file) problem.value = await loadLanguageFile(file);
}

async function removeLines() {
  problem.value = await removeLanguageFile();
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
    <div v-if="browser" class="prefs-actions">
      <Button class="prefs-language-load" @click="loadFile">{{ t("prefs.language.load") }}</Button>
      <Button v-if="status" class="prefs-language-remove" @click="removeLines">{{ t("prefs.language.remove") }}</Button>
    </div>
    <div class="prefs-language-status" role="status">
      <p v-if="status && !status.error" class="pref-hint">{{ t("prefs.language.inUse", { n: status.lines }) }}</p>
      <template v-if="skipped.length">
        <p class="pref-hint">{{ t("prefs.language.skipped", { n: skipped.length }) }}</p>
        <ul class="pref-hint prefs-language-skipped">
          <li v-for="(skip, i) in skipLines" :key="i">{{ skip }}</li>
          <li v-if="skipped.length > SHOWN_SKIPS">{{
            t("prefs.language.more", { n: skipped.length - SHOWN_SKIPS })
          }}</li>
        </ul>
      </template>
    </div>
    <p id="prefs-language-error" class="pref-hint prefs-theme-error" role="alert">{{ fileError }}</p>
  </div>
</template>
