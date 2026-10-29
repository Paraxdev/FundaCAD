<script setup lang="ts">
// The Report a problem form and its preview, what a report contains lives in ui/bugReporter.ts.

import { computed, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { useDialogStore } from "../../stores/dialogs";
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
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import Dialog from "../ui/Dialog.vue";
import TextField from "../ui/TextField.vue";

const dialogs = useDialogStore();
// Non-null whenever this is rendered, App.vue gates on the same field.
const deps = dialogs.bugDeps as BugReportDeps;

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

const desc = useTemplateRef<InstanceType<typeof TextField>>("desc");
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
  // The version comes from Tauri a tick late, so it is fetched after the dialog paints rather than awaited before.
  const [v, tail, sys] = await Promise.all([appVersion(), appLogTail(), systemInfo()]);
  version.value = v;
  logTail.value = tail;
  system.value = sys;
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <!-- Escape is this dialog's own handler above; the frame holds the modal gate, focus, its trap and its return. -->
  <Dialog
    title="Report a problem"
    panel-class="bug-report-card"
    :close-on-esc="false"
    initial-focus=".bug-desc textarea"
    @close="close()"
  >
    <TextField
      ref="desc"
      v-model="description"
      class="bug-desc"
      multiline
      rows="4"
      placeholder="What happened? What did you expect?"
    />
    <div v-if="askedForText && !description.trim()" class="bug-note bug-need-text" role="alert">
      Say what happened first, then send the report.
    </div>
    <Checkbox
      v-if="logTail !== null"
      v-model="includeLog"
      class="bug-check bug-log"
      label="Include the app log (user names hidden)"
    />
    <div class="bug-shot-row">
      <span>A picture of the 3D view helps, it shows your design.</span>
      <Button class="bug-shot" :disabled="busy" @click="shoot()">Save Picture…</Button>
    </div>
    <div v-if="picture" class="bug-shot-saved">
      <img :src="picture.url" alt="" />
      <span>Saved as {{ picture.name }}, drag it into the issue.</span>
    </div>
    <Checkbox
      v-model="includeDocument"
      class="bug-check bug-doc"
      label="Include the current document (contains your design)"
      :disabled="tooBig !== null"
    />
    <div v-if="tooBig !== null" class="bug-note bug-doc-big">
      The document is too big to paste ({{ formatSize(tooBig) }}). Attach the .funda file to the issue yourself, inside
      a .zip.
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
      <Button class="bug-again-copy" @click="copyAgain()">Copy Again</Button>
    </div>
    <div class="bug-note">Open on GitHub needs a GitHub account. Nothing is sent until you submit the issue there.</div>
    <template #footer>
      <Button class="bug-cancel" @click="close()">Cancel</Button>
      <Button class="bug-send" :disabled="busy" @click="send('copy')">Copy report</Button>
      <Button variant="primary" class="bug-github" :disabled="busy" @click="send('github')">Open on GitHub</Button>
    </template>
  </Dialog>
</template>
