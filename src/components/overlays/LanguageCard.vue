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
  openLanguageFolder,
  reloadLanguageFiles,
  removeLanguageFile,
  setLanguage,
  t,
  type MessageKey,
} from "../../i18n";
import type { DropInFileError } from "../../i18n/catalog";
import { MAX_LINE_CHARS, MAX_OVERRIDE_BYTES, shownKey } from "../../i18n/overrides";
import { safeMode } from "../../ui/safeMode";

const SHOWN_SKIPS = 5;

const FILE_ERRORS: Record<DropInFileError, MessageKey> = {
  "too-large": "prefs.language.error.tooLarge",
  "not-json": "prefs.language.error.notJson",
  "not-flat": "prefs.language.error.notFlat",
  "bad-name": "prefs.language.error.badName",
  unreadable: "prefs.language.error.unreadable",
  storage: "prefs.language.error.storage",
  "not-read": "prefs.language.error.notRead",
  folder: "prefs.language.error.folder",
};
// A refused pick leaves the file before in use, so its message must not read as if that file were refused.
const PICKED_ERRORS: Partial<Record<DropInFileError, MessageKey>> = {
  "too-large": "prefs.language.error.pickedTooLarge",
  "not-json": "prefs.language.error.pickedNotJson",
  "not-flat": "prefs.language.error.pickedNotFlat",
};

const source = languageFileSource();
// Safe mode reads none of the user's files; its folder buttons stay in view, off, so the reason can show.
const locked = safeMode() !== null;
const problem = ref<DropInFileError | null>(null);
const status = computed(() => languageFileStatus());

const fileError = computed(() => {
  const key = problem.value
    ? (PICKED_ERRORS[problem.value] ?? FILE_ERRORS[problem.value])
    : status.value?.error && FILE_ERRORS[status.value.error];
  return key ? t(key, { kb: MAX_OVERRIDE_BYTES / 1024 }) : "";
});

const skipped = computed(() => (status.value?.error ? [] : (status.value?.skipped ?? [])));

// Select option keys are plain words, so the reason's dash goes.
const skipLines = computed(() =>
  skipped.value.slice(0, SHOWN_SKIPS).map(({ key, reason, arg }) =>
    t("prefs.language.skip", {
      key: shownKey(key),
      reason: reason.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
      max: MAX_LINE_CHARS,
      tag: "<b>",
      arg: shownKey(`{${arg ?? ""}}`),
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

async function openFolder() {
  problem.value = await openLanguageFolder();
}

async function reload() {
  problem.value = null;
  await reloadLanguageFiles();
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
    <div v-if="source === 'folder' || locked" class="prefs-actions">
      <Button
        class="prefs-language-open"
        :disabled="locked"
        :disabled-reason="locked ? t('prefs.language.safeMode') : undefined"
        @click="openFolder"
        >{{ t("prefs.language.open") }}</Button
      >
      <Button
        class="prefs-language-reload"
        :disabled="locked"
        :disabled-reason="locked ? t('prefs.language.safeMode') : undefined"
        @click="reload"
        >{{ t("prefs.language.reload") }}</Button
      >
    </div>
    <div v-else-if="source === 'browser'" class="prefs-actions">
      <Button class="prefs-language-load" @click="loadFile">{{ t("prefs.language.load") }}</Button>
      <Button v-if="status" class="prefs-language-remove" @click="removeLines">{{ t("prefs.language.remove") }}</Button>
    </div>
    <p v-if="locked" class="pref-hint prefs-language-locked" role="note">{{ t("prefs.language.safeMode") }}</p>
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
