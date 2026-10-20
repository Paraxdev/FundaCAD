<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Icon from "../shell/Icon.vue";
import type { DocSummary } from "../../io/library";
import { ago } from "../../ui/timeAgo";
import { branchLog, branchNames } from "../../ui/homeVersions";

const props = defineProps<{ name: string; load: () => Promise<DocSummary | null> }>();
const emit = defineEmits<{ close: []; restore: [id: string]; copy: [id: string]; branch: [name: string] }>();

const summary = ref<DocSummary | null>(null);
const state = ref<"loading" | "ready" | "old" | "failed">("loading");
const picked = ref<string | null>(null);

const branches = computed(() => (summary.value ? branchNames(summary.value) : []));
const shown = computed(() => picked.value ?? summary.value?.current ?? null);
const rows = computed(() => (summary.value && shown.value ? branchLog(summary.value, shown.value) : []));

onMounted(async () => {
  try {
    const s = await props.load();
    summary.value = s;
    state.value = s ? "ready" : "old";
  } catch (err) {
    console.warn("[home] versions could not be read", err);
    state.value = "failed";
  }
});
</script>

<template>
  <aside class="home-drawer" role="region" :aria-label="`Versions of ${name}`">
    <div class="home-drawer-head">
      <span class="home-drawer-title">{{ name }}</span>
      <button class="home-drawer-close" aria-label="Close versions" title="Close versions" @click="emit('close')">
        <Icon name="close" :size="13" />
      </button>
    </div>

    <p v-if="state === 'loading'" class="home-drawer-note">Reading versions…</p>
    <p v-else-if="state === 'old'" class="home-drawer-note">Open the document to see its versions.</p>
    <p v-else-if="state === 'failed'" class="home-drawer-note">The versions could not be read.</p>
    <p v-else-if="!summary?.versions.length" class="home-drawer-note">No versions saved in this document.</p>
    <template v-else>
      <div class="home-drawer-section">Branches</div>
      <div
        v-for="b in branches"
        :key="b"
        class="home-branch"
        :class="{ shown: b === shown }"
      >
        <button class="home-branch-name" :title="`Show the versions on ${b}`" @click="picked = b">
          {{ b }}<span v-if="b === summary!.current" class="home-branch-current">current</span>
        </button>
        <button class="home-drawer-act home-branch-open" :title="`Open the document on ${b}`" @click="emit('branch', b)">Open</button>
      </div>

      <div class="home-drawer-section">Versions on {{ shown }}</div>
      <p class="home-drawer-hint">Restore brings a version back into the document, Ctrl+Z undoes it. Open copy starts a new document from it.</p>
      <div v-for="v in rows" :key="v.id" class="home-version">
        <div class="home-version-text">
          <span class="home-version-msg">{{ v.message || "Untitled version" }}</span>
          <span class="home-version-time">{{ ago(v.time) }}</span>
        </div>
        <div class="home-version-acts">
          <button class="home-drawer-act home-version-restore" title="Bring this version back into the document" @click="emit('restore', v.id)">Restore</button>
          <button class="home-drawer-act home-version-copy" title="Start a new untitled document from this version" @click="emit('copy', v.id)">Open copy</button>
        </div>
      </div>
    </template>
  </aside>
</template>
