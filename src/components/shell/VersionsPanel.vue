<script setup lang="ts">
// Versions of the open document: save one, see what changed, go back to one, or
// branch off a version to try something without losing the line you were on.

import { computed, ref } from "vue";
import { useEngine } from "../../app/engineKey";
import { useDocValue, useMetaValue } from "../../app/useDoc";
import { diffTrees, log, snapshotOf, versionById, type Version, type VersionDiff } from "../../document/versions";
import { featureMeta } from "../../ui/featureMeta";
import { toast } from "../../ui/toast";
import Icon from "./Icon.vue";

const engine = useEngine();
const store = engine.store;

const tick = useMetaValue(() => ({}));
const docTick = useDocValue(() => ({}));

// The repo is mutated in place, so each view reads the ticks itself rather than
// through a computed that would keep returning the same object.
const branch = computed(() => { tick.value; docTick.value; return store.versionRepo?.current ?? "main"; });
const branches = computed(() => { tick.value; docTick.value; return Object.keys(store.versionRepo?.branches ?? {}); });
const history = computed(() => { tick.value; docTick.value; return store.versionRepo ? log(store.versionRepo) : []; });
const pending = computed<VersionDiff | null>(() => { docTick.value; tick.value; return store.changesSinceVersion(); });
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
    toast("Nothing has changed since the last version");
    return;
  }
  message.value = "";
}

function restore(v: Version) {
  store.restoreVersion(v.id);
  toast(`Back at "${v.message}". Undo brings back what you had.`);
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
    toast(`On branch ${name}`);
    branching.value = null;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { kind: "error" });
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
  if (d.settings) parts.push("settings");
  return parts.join(" ") || "no change";
}

/** Names for the features a version touched, read from the version itself so a
 *  removed feature is still named. */
function changedNames(v: Version): { kind: string; name: string }[] {
  const r = store.versionRepo!;
  const d = diffOf(v);
  const here = snapshotOf(r, v.id).features;
  const before = v.parent ? snapshotOf(r, v.parent).features : [];
  const label = (id: string, list: typeof here) => {
    const f = list.find((x) => x.id === id) as ({ name?: string } & (typeof here)[number]) | undefined;
    return f ? f.name || featureMeta(f).label : id;
  };
  return [
    ...d.added.map((id) => ({ kind: "added", name: label(id, here) })),
    ...d.changed.map((id) => ({ kind: "changed", name: label(id, here) })),
    ...d.removed.map((id) => ({ kind: "removed", name: label(id, before) })),
  ];
}

function ago(time: number): string {
  const s = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(time).toLocaleDateString();
}
</script>

<template>
  <div class="versions">
    <div class="versions-head">
      <span class="pop-section">Versions</span>
      <select
        v-if="branches.length > 1"
        class="versions-branch"
        :value="branch"
        title="Branch"
        @change="switchTo(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="b in branches" :key="b" :value="b">{{ b }}</option>
      </select>
      <span v-else-if="branches.length" class="versions-branch-name"><Icon name="versions" :size="12" />{{ branch }}</span>
    </div>

    <p class="pop-note">
      <template v-if="!history.length">No versions yet. Save one to be able to come back to this point.</template>
      <template v-else-if="changeCount">{{ changeCount }} change{{ changeCount === 1 ? "" : "s" }} since "{{ history[0]!.message }}"</template>
      <template v-else>Nothing changed since "{{ history[0]!.message }}"</template>
    </p>

    <form class="versions-save" @submit.prevent="save()">
      <input v-model="message" class="versions-input" placeholder="What changed" spellcheck="false" @keydown.stop />
      <button type="submit" class="pop-wide versions-save-btn" :disabled="!canSave">
        <Icon name="commit" :size="14" /> Save version
      </button>
    </form>

    <div v-if="history.length" class="pop-rule"></div>

    <ol class="versions-list">
      <li v-for="(v, i) in history" :key="v.id" class="versions-row" :class="{ open: expanded === v.id, head: i === 0 }">
        <button type="button" class="versions-main" @click="expanded = expanded === v.id ? null : v.id">
          <span class="versions-dot"></span>
          <span class="versions-text">
            <span class="versions-msg">{{ v.message }}</span>
            <span class="versions-meta">{{ ago(v.time) }} · {{ summary(diffOf(v)) }}</span>
          </span>
        </button>
        <div v-if="expanded === v.id" class="versions-detail">
          <ul class="versions-changes">
            <li v-for="(c, k) in changedNames(v)" :key="k" :class="c.kind">{{ c.kind }} {{ c.name }}</li>
          </ul>
          <div class="versions-actions">
            <button type="button" class="pop-wide ghost" @click="restore(v)">Restore</button>
            <button type="button" class="pop-wide ghost" @click="startBranch(v)">Branch from here</button>
          </div>
          <form v-if="branching === v.id" class="versions-save" @submit.prevent="makeBranch()">
            <input v-model="branchName" class="versions-input" placeholder="Branch name" spellcheck="false" @keydown.stop />
            <button type="submit" class="pop-wide" :disabled="!branchName.trim()">Create</button>
          </form>
        </div>
      </li>
    </ol>
  </div>
</template>
