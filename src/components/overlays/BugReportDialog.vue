<script setup lang="ts">
// The Report a problem form and its preview, what a report contains lives in ui/bugReporter.ts.

import { computed, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { useDialogStore } from "../../stores/dialogs";
import { useModalGate } from "../../composables/useModalGate";
import {
  appLogTail,
  composeReport,
  copyAgain,
  copyReport,
  formatSize,
  lastReport,
  openIssue,
  reportSnapshot,
  savePicture,
  type BugReportDeps,
} from "../../ui/bugReporter";
import { appVersion } from "../../ui/updates";
import { systemInfo, type SystemInfo } from "../../ui/systemInfo";

const dialogs = useDialogStore();
// Non-null whenever this is rendered, App.vue gates on the same field.
const deps = dialogs.bugDeps as BugReportDeps;

useModalGate();

const close = () => {
  dialogs.bugReport = false;
};

const description = ref("");
const includeDocument = ref(false);
const includeLog = ref(true);
const logTail = ref<string | null>(null);
const version = ref("…");
const system = ref<SystemInfo>({ system: "…", webview: null });
const busy = ref(false);
const picture = ref<{ name: string; url: string } | null>(null);
const previous = lastReport();

const snap = reportSnapshot(deps);

const choices = (withDocument: boolean) => ({
  description: description.value.trim(),
  version: version.value,
  system: system.value,
  log: includeLog.value ? logTail.value : null,
  includeDocument: withDocument,
});

// Measured with the document in, so the box can say so before it is ticked.
const tooBig = computed(() => composeReport(snap, choices(true)).report.documentLeftOut);
const composed = computed(() => composeReport(snap, choices(includeDocument.value && tooBig.value === null)));

const previousAt = previous
  ? new Date(previous.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  : null;

const desc = useTemplateRef<HTMLTextAreaElement>("desc");
const askedForText = ref(false);

function described(): boolean {
  if (description.value.trim()) return true;
  askedForText.value = true;
  desc.value?.focus();
  return false;
}

async function send(how: "github" | "copy") {
  if (!described() || busy.value) return;
  busy.value = true;
  const text = composed.value.report.text;
  const ok =
    how === "github"
      ? await openIssue(
          text,
          { description: description.value.trim(), version: version.value, system: system.value.system },
          picture.value?.name ?? null,
        )
      : await copyReport(text);
  busy.value = false;
  // A refused clipboard leaves the dialog up rather than closing over text the user cannot get back.
  if (ok) close();
}

async function shoot() {
  if (busy.value) return;
  busy.value = true;
  try {
    picture.value = (await savePicture(deps.viewport)) ?? picture.value;
  } finally {
    busy.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  desc.value?.focus();
  // The version comes from Tauri a tick late, so it is fetched after focus rather than awaited before paint.
  const [v, tail, sys] = await Promise.all([appVersion(), appLogTail(), systemInfo()]);
  version.value = v;
  logTail.value = tail;
  system.value = sys;
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <Teleport to="body">
    <div class="choice-backdrop" @click.self="close()">
      <div class="choice-card bug-report-card" role="dialog" aria-modal="true" aria-labelledby="bug-report-title">
        <div id="bug-report-title" class="choice-title">Report a problem</div>
        <textarea
          ref="desc"
          v-model="description"
          class="sm-input bug-desc"
          rows="4"
          placeholder="What happened? What did you expect?"
        ></textarea>
        <div v-if="askedForText && !description.trim()" class="bug-note bug-need-text" role="alert">
          Say what happened first, then send the report.
        </div>
        <label v-if="logTail !== null" class="bug-check">
          <input v-model="includeLog" type="checkbox" class="bug-log" />
          Include the app log (user names hidden)
        </label>
        <div class="bug-shot-row">
          <span>A picture of the 3D view helps, it shows your design.</span>
          <button type="button" class="btn bug-shot" :disabled="busy" @click="shoot()">Save Picture…</button>
        </div>
        <div v-if="picture" class="bug-shot-saved">
          <img :src="picture.url" alt="" />
          <span>Saved as {{ picture.name }}, drag it into the issue.</span>
        </div>
        <label class="bug-check">
          <input v-model="includeDocument" type="checkbox" class="bug-doc" :disabled="tooBig !== null" />
          Include the current document (contains your design)
        </label>
        <div v-if="tooBig !== null" class="bug-note bug-doc-big">
          The document is too big to paste ({{ formatSize(tooBig) }}). Attach the .funda file to the issue yourself,
          inside a .zip.
        </div>
        <details class="bug-preview">
          <summary>What will be sent</summary>
          <div class="bug-note">
            Your words, then technical notes for whoever fixes it: the version, your system, the last steps and errors.
          </div>
          <pre>{{ composed.preview }}</pre>
        </details>
        <div v-if="previous" class="bug-again">
          <span>Last report, {{ previousAt }}.</span>
          <button type="button" class="btn bug-again-copy" @click="copyAgain()">Copy Again</button>
        </div>
        <div class="choice-row">
          <button class="choice-btn choice-primary bug-github" :disabled="busy" @click="send('github')">
            <span>Open on GitHub</span>
          </button>
          <button class="choice-btn bug-send" :disabled="busy" @click="send('copy')"><span>Copy report</span></button>
          <button class="choice-btn bug-cancel" @click="close()"><span>Cancel</span></button>
        </div>
        <div class="bug-note"
          >Open on GitHub needs a GitHub account. Nothing is sent until you submit the issue there.</div
        >
      </div>
    </div>
  </Teleport>
</template>
