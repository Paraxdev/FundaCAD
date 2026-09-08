<script setup lang="ts">
// The log, on screen. Everything about WHAT is recorded lives in ui/logStore.ts;
// this is the view.
//
// Two rules it exists to keep, both of which the toast breaks:
//
//   * Nothing is truncated. Messages wrap, they never clip, a kernel sentence
//     is usually one long line and the tail is the part that says what to do.
//   * Nothing expires. A toast is gone in eight seconds, which is not long
//     enough to read a stack, let alone copy one.
//
// It subscribes with a plain counter rather than making the log reactive: the
// store has to be writable from places with no active pinia (a window error
// handler, module init), so the reactivity is on this side of the boundary.

import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import Icon from "../shell/Icon.vue";
import {
  clearLog,
  consoleOpen,
  formatEntry,
  formatLog,
  logEntries,
  onLogChange,
  setConsoleOpen,
  type LogEntry,
  type LogLevel,
} from "../../ui/logStore";

const tick = ref(0);
const stop = onLogChange(() => tick.value++);
onUnmounted(stop);

const open = computed(() => {
  tick.value;
  return consoleOpen();
});

/** Which levels are shown. Errors and warnings on by default: the reason to open
 *  this is almost always that something failed, and info is mostly the running
 *  commentary of a working session. */
const show = ref<Record<LogLevel, boolean>>({ error: true, warning: true, info: false });

/** Declared here rather than inline in the template: a TypeScript cast is not
 *  valid template-expression syntax, and the parser rejects it. */
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

// Follow the tail, but only when already at it: scrolling up to read something
// and being yanked back down by the next frame's error is the single most
// annoying thing a log panel can do.
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
    // Clipboard access can be refused; the text is still selectable by hand, so
    // failing silently here is better than a toast about a failed copy landing
    // in the very log the user is reading.
  }
}

const clockOf = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour12: false });
</script>

<template>
  <Teleport to="body">
    <!-- v-if, not hidden: a panel left in the DOM over the viewport steals the
         picks the geometry behind it should be getting. -->
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
        <button type="button" class="logcon-btn" title="Copy everything shown"
                @click="copy(formatLog(rows), null)">
          <Icon name="copy" :size="14" />
        </button>
        <!-- cleanUp, not a bin: the table has no bin, and an icon name that is
             not in it renders as a blank square rather than failing loudly. -->
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
        <div v-for="e in rows" :key="e.id" class="logcon-row" :class="`is-${e.level}`">
          <span class="logcon-time">{{ clockOf(e.at) }}</span>
          <span v-if="e.source" class="logcon-src">{{ e.source }}</span>
          <span class="logcon-msg">{{ e.message }}</span>
          <button
            v-if="e.detail"
            type="button"
            class="logcon-more"
            @click="toggleDetail(e.id)"
          >{{ expanded.has(e.id) ? "less" : "more" }}</button>
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
