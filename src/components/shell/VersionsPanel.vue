<script setup lang="ts">
// Versions of the open document: save one, see what changed, go back to one, or
// branch off a version to try something without losing the line you were on.

import { computed, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue, useMetaValue } from "../../app/useDoc";
import { diffTrees, log, snapshotOf, versionById, type Version, type VersionDiff } from "../../document/versions";
import { featureMeta } from "../../ui/featureMeta";
import { toast } from "../../ui/toast";
import { plainError, SEE_CONSOLE } from "../../ui/plainError";
import { ago } from "../../ui/timeAgo";
import { t } from "../../i18n";
import Icon from "./Icon.vue";
import Button from "../ui/Button.vue";
import ListRow from "../ui/ListRow.vue";
import Select from "../ui/Select.vue";
import TextField from "../ui/TextField.vue";

const engine = useEngine();
const store = engine.store;

const tick = useMetaValue(() => ({}));
const docTick = useDocValue(() => ({}));

// The repo is mutated in place, so each view reads the ticks itself rather than
// through a computed that would keep returning the same object.
const branch = computed(() => {
  tick.value;
  docTick.value;
  return store.versionRepo?.current ?? "main";
});
const branches = computed(() => {
  tick.value;
  docTick.value;
  return Object.keys(store.versionRepo?.branches ?? {});
});
const history = computed(() => {
  tick.value;
  docTick.value;
  return store.versionRepo ? log(store.versionRepo) : [];
});
const unreadVersions = computed(() => {
  tick.value;
  docTick.value;
  return store.hasUnreadVersions();
});
const pending = computed<VersionDiff | null>(() => {
  docTick.value;
  tick.value;
  return store.changesSinceVersion();
});
const changeCount = computed(() => {
  const d = pending.value;
  return d ? d.added.length + d.removed.length + d.changed.length + (d.settings ? 1 : 0) : 0;
});
const canSave = computed(() => !history.value.length || changeCount.value > 0);

const message = ref("");
const expanded = ref<string | null>(null);
const branching = ref<string | null>(null);
const branchName = ref("");

function save() {
  const v = store.saveVersion(message.value);
  if (!v) {
    toast(t("versions.toast.nothing"));
    return;
  }
  message.value = "";
}

function restore(v: Version) {
  try {
    store.restoreVersion(v.id);
  } catch (e) {
    toast(t("versions.toast.restoreFailed", { name: v.message, detail: plainError(e, SEE_CONSOLE) }), {
      kind: "error",
      detail: e,
    });
    return;
  }
  const mark = store.undoMark;
  const undo = mark !== null ? { label: t("step.undo"), onClick: () => engine.undoIfLatest(mark) } : undefined;
  toast(t("versions.toast.restored", { name: v.message }), undo && { action: undo });
}

function startBranch(v: Version) {
  branching.value = v.id;
  branchName.value = "";
}

function makeBranch() {
  const from = branching.value;
  if (!from) return;
  try {
    const name = store.branchFromVersion(from, branchName.value);
    toast(t("versions.toast.onBranch", { name }));
    branching.value = null;
  } catch (e) {
    toast(plainError(e, t("versions.toast.branchFailed")), { kind: "error", detail: e });
  }
}

function switchTo(name: string) {
  if (name === branch.value) return;
  store.switchVersionBranch(name);
}

function diffOf(v: Version): VersionDiff {
  const r = store.versionRepo!;
  const parent = v.parent ? versionById(r, v.parent) : undefined;
  return diffTrees(r, parent?.tree ?? null, v.tree);
}

function summary(d: VersionDiff): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`+${d.added.length}`);
  if (d.changed.length) parts.push(`~${d.changed.length}`);
  if (d.removed.length) parts.push(`-${d.removed.length}`);
  if (d.settings) parts.push(t("versions.summary.settings"));
  return parts.join(" ") || t("versions.summary.none");
}

/** Names for the features a version touched, read from the version itself so a
 *  removed feature is still named. */
function changedNames(v: Version): { kind: "added" | "changed" | "removed"; name: string }[] {
  const r = store.versionRepo!;
  const d = diffOf(v);
  // An unreadable version is named by ids, so its Restore button still shows and reports why.
  const featuresOf = (id: string) => {
    try {
      return snapshotOf(r, id).features;
    } catch {
      return [];
    }
  };
  const here = featuresOf(v.id);
  const before = v.parent ? featuresOf(v.parent) : [];
  const label = (id: string, list: typeof here) => {
    const f = list.find((x) => x.id === id) as ({ name?: string } & (typeof here)[number]) | undefined;
    return f ? f.name || featureMeta(f).label : id;
  };
  return [
    ...d.added.map((id) => ({ kind: "added" as const, name: label(id, here) })),
    ...d.changed.map((id) => ({ kind: "changed" as const, name: label(id, here) })),
    ...d.removed.map((id) => ({ kind: "removed" as const, name: label(id, before) })),
  ];
}
</script>

<template>
  <div class="versions">
    <div class="versions-head">
      <span class="pop-section">{{ t("versions.title") }}</span>
      <Select
        v-if="branches.length > 1"
        class="versions-branch"
        size="sm"
        :label="t('versions.branch')"
        :tip="t('versions.branch')"
        :model-value="branch"
        :options="branches.map((b) => ({ value: b, label: b }))"
        @update:model-value="switchTo"
      />
      <span v-else-if="branches.length" class="versions-branch-name"
        ><Icon name="versions" :size="12" />{{ branch }}</span
      >
    </div>

    <p class="pop-note">
      <template v-if="unreadVersions">{{ t("versions.note.newer") }}</template>
      <template v-else-if="!history.length">{{ t("versions.note.empty") }}</template>
      <template v-else-if="changeCount">{{
        t("versions.note.changes", { n: changeCount, name: history[0]!.message })
      }}</template>
      <template v-else>{{ t("versions.note.unchanged", { name: history[0]!.message }) }}</template>
    </p>

    <!-- The guards stand in for a disabled submit button, which used to refuse Enter in the field too. -->
    <form class="versions-save" @submit.prevent="canSave && save()">
      <TextField
        v-model="message"
        class="versions-input"
        :placeholder="t('versions.message.placeholder')"
        :label="t('versions.message.label')"
        spellcheck="false"
        @keydown.stop
      />
      <Button type="submit" class="versions-save-btn" icon="commit" :disabled="!canSave">{{
        t("versions.save")
      }}</Button>
    </form>

    <div v-if="history.length" class="pop-rule"></div>

    <ol class="versions-list">
      <li
        v-for="(v, i) in history"
        :key="v.id"
        class="versions-row"
        :class="{ open: expanded === v.id, head: i === 0 }"
      >
        <ListRow
          class="versions-main"
          :label="v.message"
          :hint="`${ago(v.time)} · ${summary(diffOf(v))}`"
          :aria-expanded="expanded === v.id"
          @click="expanded = expanded === v.id ? null : v.id"
        >
          <template #leading><span class="versions-dot"></span></template>
        </ListRow>
        <div v-if="expanded === v.id" class="versions-detail">
          <ul class="versions-changes">
            <li v-for="(c, k) in changedNames(v)" :key="k" :class="c.kind">{{
              t("versions.change", { kind: c.kind, name: c.name })
            }}</li>
          </ul>
          <div class="versions-actions">
            <Button variant="ghost" @click="restore(v)">{{ t("versions.restore") }}</Button>
            <Button variant="ghost" @click="startBranch(v)">{{ t("versions.branchFrom") }}</Button>
          </div>
          <form v-if="branching === v.id" class="versions-save" @submit.prevent="branchName.trim() && makeBranch()">
            <TextField
              v-model="branchName"
              class="versions-input"
              :placeholder="t('versions.branchName')"
              :label="t('versions.branchName')"
              spellcheck="false"
              @keydown.stop
            />
            <Button type="submit" :disabled="!branchName.trim()">{{ t("versions.create") }}</Button>
          </form>
        </div>
      </li>
    </ol>
  </div>
</template>
