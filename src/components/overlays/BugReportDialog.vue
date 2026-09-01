<script setup lang="ts">
// The bug-report form. Everything about what a report CONTAINS — the text,
// the open-sketch snapshot, the clipboard write — is in ui/bugReporter.ts; this
// is the form and the "what will be copied" preview.

import { computed, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { useDialogStore } from "../../stores/dialogs";
import { useModalGate } from "../../composables/useModalGate";
import { bugContext, submitBugReport, type BugReportDeps } from "../../ui/bugReporter";
import { appVersion } from "../../ui/updates";

const dialogs = useDialogStore();
// Non-null whenever this is rendered — App.vue gates on the same field.
const deps = dialogs.bugDeps as BugReportDeps;

useModalGate();

const close = () => { dialogs.bugReport = false; };

const description = ref("");
const includeDocument = ref(false);
const version = ref("…");
const copying = ref(false);

// Snapshotted at open, not at send: see BugReportForm.
const { connected, crumbs } = bugContext(deps);

const desc = useTemplateRef<HTMLTextAreaElement>("desc");

// No esc(): this was innerHTML'd into a <pre> and needed one; {{ }} escapes on
// its own, and a second pass would show the entities.
const preview = computed(() =>
  [
    `FundaCAD ${version.value} · ${navigator.userAgent.slice(0, 80)}`,
    `geometry engine connected: ${connected}`,
    `recent events (${crumbs.length}):`,
    ...crumbs.slice(-5).map((c) => `  ${c}`),
    `+ sidecar log tail (if checked), usernames/paths redacted`,
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
  });
  copying.value = false;
  // A refused clipboard leaves the dialog up rather than closing over text the
  // user cannot get back.
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
  // The version comes from Tauri, so it lands a tick late. The dialog used to
  // await it BEFORE painting, which meant the click had no visible effect
  // until the round-trip finished.
  version.value = await appVersion();
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
