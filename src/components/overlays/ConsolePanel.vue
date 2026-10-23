<script setup lang="ts">
// The log view (ui/logStore.ts records it). Unlike a toast nothing is clipped or expires, a stack must be readable whole.

import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import Icon from "../shell/Icon.vue";
import {
  clearLog,
  clearRevealed,
  consoleOpen,
  formatEntry,
  formatLog,
  logEntries,
  onLogChange,
  revealedEntry,
  setConsoleOpen,
  type LogEntry,
  type LogLevel,
} from "../../ui/logStore";

// A plain counter, not a reactive log: the store is written where no pinia is active (window error handler, module init).
const tick = ref(0);
const stop = onLogChange(() => tick.value++);
onUnmounted(stop);

const open = computed(() => {
  tick.value;
  return consoleOpen();
});

/** Errors and warnings on by default, info is mostly running commentary. */
const show = ref<Record<LogLevel, boolean>>({ error: true, warning: true, info: false });

/** Not inline in the template: a TypeScript cast is not valid template-expression syntax. */
const LEVELS: LogLevel[] = ["error", "warning", "info"];

const rows = computed<LogEntry[]>(() => {
  tick.value;
  return logEntries().filter((e) => show.value[e.level]);
});

const counts = computed(() => {
  tick.value;
  const c: Record<LogLevel, number> = { error: 0, warning: 0, info: 0 };
  for (const e of logEntries()) c[e.level]++;
  return c;
});

const expanded = ref<Set<number>>(new Set());
function toggleDetail(id: number) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

const body = ref<HTMLElement | null>(null);
const copied = ref<number | null>(null);
const flashed = ref<number | null>(null);

// The error notice was clicked: show that entry whole, whatever the filters.
watch(
  tick,
  async () => {
    const id = revealedEntry();
    if (id === null) return;
    clearRevealed();
    const entry = logEntries().find((x) => x.id === id);
    if (!entry) return;
    show.value[entry.level] = true;
    if (entry.detail) expanded.value = new Set(expanded.value).add(id);
    flashed.value = id;
    await nextTick();
    body.value?.querySelector(`[data-log-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  },
  { immediate: true },
);

// Follow the tail only when already at it, so reading scrolled up is not yanked back down.
watch(rows, async () => {
  const el = body.value;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  await nextTick();
  if (atBottom) el.scrollTop = el.scrollHeight;
});

async function copy(text: string, id: number | null) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = id;
    setTimeout(() => {
      if (copied.value === id) copied.value = null;
    }, 1200);
  } catch {
    // A refused copy fails silently: the text is still selectable, and a toast would land in this very log.
  }
}

const clockOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });
</script>

<template>
  <Teleport to="body">
    <!-- v-if, not hidden: a panel left in the DOM over the viewport steals its picks. -->
    <div v-if="open" class="logcon" role="dialog" aria-label="Console">
      <div class="logcon-head">
        <span class="logcon-title">Console</span>
        <button
          v-for="lvl in LEVELS"
          :key="lvl"
          type="button"
          class="logcon-filter"
          :class="[`is-${lvl}`, { on: show[lvl] }]"
          :aria-pressed="show[lvl] ? 'true' : 'false'"
          @click="show[lvl] = !show[lvl]"
        >
          {{ lvl }} <span class="logcon-count">{{ counts[lvl] }}</span>
        </button>
        <span class="logcon-spacer"></span>
        <button type="button" class="logcon-btn" title="Copy everything shown" @click="copy(formatLog(rows), null)">
          <Icon name="copy" :size="14" />
        </button>
        <!-- cleanUp, not bin: the icon table has no bin, and an unknown name renders as a blank square. -->
        <button type="button" class="logcon-btn" title="Clear" @click="clearLog()">
          <Icon name="cleanUp" :size="14" />
        </button>
        <button type="button" class="logcon-btn" title="Close" @click="setConsoleOpen(false)">
          <Icon name="close" :size="14" />
        </button>
      </div>

      <div ref="body" class="logcon-body">
        <p v-if="!rows.length" class="logcon-empty">
          Nothing here. Errors and warnings are kept in full, and stay until cleared.
        </p>
        <div
          v-for="e in rows"
          :key="e.id"
          class="logcon-row"
          :class="[`is-${e.level}`, { 'is-revealed': flashed === e.id }]"
          :data-log-id="e.id"
        >
          <span class="logcon-time">{{ clockOf(e.at) }}</span>
          <span v-if="e.source" class="logcon-src">{{ e.source }}</span>
          <span class="logcon-msg">{{ e.message }}</span>
          <button v-if="e.detail" type="button" class="logcon-more" @click="toggleDetail(e.id)">{{
            expanded.has(e.id) ? "less" : "more"
          }}</button>
          <button
            type="button"
            class="logcon-copy"
            :title="copied === e.id ? 'Copied' : 'Copy this entry'"
            @click="copy(formatEntry(e), e.id)"
          >
            <Icon :name="copied === e.id ? 'check' : 'copy'" :size="12" />
          </button>
          <pre v-if="e.detail && expanded.has(e.id)" class="logcon-detail">{{ e.detail }}</pre>
        </div>
      </div>
    </div>
  </Teleport>
</template>
