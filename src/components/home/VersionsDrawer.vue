<script setup lang="ts">
import { fmtKeys } from "../../input/platform";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Button from "../ui/Button.vue";
import Chip from "../ui/Chip.vue";
import IconButton from "../ui/IconButton.vue";
import ListRow from "../ui/ListRow.vue";
import { focusReturn } from "../ui/focusables";
import type { DocSummary } from "../../io/library";
import { t } from "../../i18n";
import { ago } from "../../ui/timeAgo";
import { branchLog, branchNames } from "../../ui/homeVersions";

/** `returnTo` finds the control that opened the drawer, for when the opener is gone or WebKit never focused it. */
const props = defineProps<{
  name: string;
  load: () => Promise<DocSummary | null>;
  returnTo?: () => HTMLElement | null;
}>();
const emit = defineEmits<{ close: []; restore: [id: string]; copy: [id: string]; branch: [name: string] }>();

const summary = ref<DocSummary | null>(null);
const state = ref<"loading" | "ready" | "old" | "failed">("loading");
const picked = ref<string | null>(null);

const branches = computed(() => (summary.value ? branchNames(summary.value) : []));
const shown = computed(() => picked.value ?? summary.value?.current ?? null);
const rows = computed(() => (summary.value && shown.value ? branchLog(summary.value, shown.value) : []));
const titled = (v: { message: string; time: number }) =>
  t("home.versions.named", { name: v.message || t("home.versions.untitled"), when: ago(v.time) });
// Plain saves share a message and ago() rounds the time, so a name that repeats also says where its row sits.
const named = computed(() => {
  const counts = new Map<string, number>();
  for (const v of rows.value) counts.set(titled(v), (counts.get(titled(v)) ?? 0) + 1);
  const n = rows.value.length;
  return rows.value.map((v, i) =>
    counts.get(titled(v))! > 1 ? t("home.versions.place", { name: titled(v), i: i + 1, n }) : titled(v),
  );
});

const root = ref<HTMLElement | null>(null);
const heading = ref<HTMLElement | null>(null);
const back = focusReturn(() => props.returnTo?.(), props.returnTo?.() ?? document.activeElement);

onMounted(async () => {
  heading.value?.focus();
  try {
    const s = await props.load();
    summary.value = s;
    state.value = s ? "ready" : "old";
  } catch (err) {
    console.warn("[home] versions could not be read", err);
    state.value = "failed";
  }
});
onBeforeUnmount(() => back.restore((n) => !!root.value?.contains(n)));
</script>

<template>
  <aside ref="root" class="home-drawer" role="region" :aria-label="t('home.versions.region', { name })">
    <div class="home-drawer-head">
      <h2 ref="heading" class="home-drawer-title" tabindex="-1" data-focus-landing>{{ name }}</h2>
      <IconButton
        class="home-drawer-close"
        icon="close"
        :tip="t('home.versions.close')"
        size="sm"
        variant="plain"
        :icon-size="13"
        @click="emit('close')"
      />
    </div>

    <p v-if="state === 'loading'" class="home-drawer-note">{{ t("home.versions.loading") }}</p>
    <p v-else-if="state === 'old'" class="home-drawer-note">{{ t("home.versions.old") }}</p>
    <p v-else-if="state === 'failed'" class="home-drawer-note">{{ t("home.versions.failed") }}</p>
    <p v-else-if="!summary?.versions.length" class="home-drawer-note">{{ t("home.versions.none") }}</p>
    <template v-else>
      <div class="home-drawer-section">{{ t("home.versions.branches") }}</div>
      <div v-for="b in branches" :key="b" class="home-branch">
        <ListRow
          class="home-branch-name"
          :label="b"
          :selected="b === shown"
          :title="t('home.versions.showBranch', { branch: b })"
          @click="picked = b"
        >
          <template v-if="b === summary!.current" #trailing>
            <Chip class="home-branch-current">{{ t("home.versions.current") }}</Chip>
          </template>
        </ListRow>
        <Button
          size="sm"
          class="home-drawer-act home-branch-open"
          :title="t('home.versions.openBranchTip', { branch: b })"
          :aria-label="t('home.versions.openBranchTip', { branch: b })"
          @click="emit('branch', b)"
          >{{ t("home.versions.openBranch") }}</Button
        >
      </div>

      <div class="home-drawer-section">{{ t("home.versions.on", { branch: shown ?? "" }) }}</div>
      <p class="home-drawer-hint">{{ t("home.versions.hint", { keys: fmtKeys("Ctrl+Z") }) }}</p>
      <div v-for="(v, i) in rows" :key="v.id" class="home-version">
        <div class="home-version-text">
          <span class="home-version-msg">{{ v.message || t("home.versions.untitled") }}</span>
          <span class="home-version-time">{{ ago(v.time) }}</span>
        </div>
        <div class="home-version-acts">
          <Button
            size="sm"
            class="home-drawer-act home-version-restore"
            :title="t('home.versions.restoreTip')"
            :aria-label="t('home.versions.restoreLabel', { version: named[i] ?? '' })"
            @click="emit('restore', v.id)"
            >{{ t("home.versions.restore") }}</Button
          >
          <Button
            size="sm"
            class="home-drawer-act home-version-copy"
            :title="t('home.versions.copyTip')"
            :aria-label="t('home.versions.copyLabel', { version: named[i] ?? '' })"
            @click="emit('copy', v.id)"
            >{{ t("home.versions.copy") }}</Button
          >
        </div>
      </div>
    </template>
  </aside>
</template>
