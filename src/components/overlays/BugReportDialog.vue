<script setup lang="ts">
// The bug-report form and its preview, what a report contains lives in ui/bugReporter.ts.

import { computed, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { useDialogStore } from "../../stores/dialogs";
import { useModalGate } from "../../composables/useModalGate";
import { appLogTail, bugContext, submitBugReport, type BugReportDeps } from "../../ui/bugReporter";
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
const copying = ref(false);

// Snapshotted at open, not at send: see BugReportForm.
const { connected, crumbs, pipeline, faults, errors } = bugContext(deps);

const desc = useTemplateRef<HTMLTextAreaElement>("desc");

// No esc(): {{ }} escapes already, and a second pass would show the entities.
const preview = computed(() =>
  [
    `FundaCAD ${version.value} · ${navigator.userAgent.slice(0, 80)}`,
    `geometry engine connected: ${connected}`,
    `recent events (${crumbs.length}):`,
    ...crumbs.slice(-5).map((c) => `  ${c}`),
    // Faults go in the preview, not only the attached log, so a reporter sees the app noticed them too.
    faults
      ? `render pipeline: FAULTS DETECTED, ${pipeline.length} lines attached`
      : `render pipeline: no faults, ${pipeline.length} lines attached`,
    ...(logTail.value === null
      ? []
      : [`+ app log, last ${Math.ceil(logTail.value.length / 1024)} KB, user names hidden (if checked)`]),
    `+ current document (only if checked)`,
  ].join("\n"),
);

async function copy() {
  const text = description.value.trim();
  if (!text) {
    desc.value?.focus();
    return;
  }
  if (copying.value) return;
  copying.value = true;
  const ok = await submitBugReport(deps, {
    description: text,
    includeDocument: includeDocument.value,
    version: version.value,
    connected,
    crumbs,
    pipeline,
    errors,
    system: system.value,
    logTail: includeLog.value ? logTail.value : null,
  });
  copying.value = false;
  // A refused clipboard leaves the dialog up rather than closing over text the user cannot get back.
  if (ok) close();
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
      <div class="choice-card bug-report-card">
        <div class="choice-title">Report a bug</div>
        <textarea
          ref="desc"
          v-model="description"
          class="bug-desc"
          rows="4"
          placeholder="What happened? What did you expect?"
        ></textarea>
        <label class="bug-check">
          <input v-model="includeDocument" type="checkbox" class="bug-doc" />
          Include current document (contains your design)
        </label>
        <label v-if="logTail !== null" class="bug-check">
          <input v-model="includeLog" type="checkbox" class="bug-log" />
          Include the app log (user names hidden)
        </label>
        <details class="bug-preview">
          <summary>What will be copied</summary>
          <pre>{{ preview }}</pre>
        </details>
        <div class="choice-row">
          <button class="choice-btn bug-send" :disabled="copying" @click="copy()">
            <span>Copy report</span>
          </button>
          <button class="choice-btn bug-cancel" @click="close()"><span>Cancel</span></button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
