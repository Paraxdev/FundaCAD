<script setup lang="ts">
// Laid out like Preferences: a General page with the app's own keys and one page per plugin that moves or adds keys.
// A key is changed by clicking it and pressing the new one; the choice is kept per row in input/shortcuts.ts.

import { computed, onMounted, onUnmounted, ref } from "vue";
import { useDialogStore } from "../../stores/dialogs";
import { useModalStore } from "../../stores/modals";
import { escapeClaimed } from "../../ui/escapeClaim";
import { fmtKeys } from "../../input/platform";
import {
  SHORTCUTS,
  formatShortcut,
  onShortcutsChange,
  resetUserShortcuts,
  setUserShortcut,
  shortcutGroupsOf,
  shortcutHudGroups,
  userShortcutIds,
  type HudGroup,
  type ShortcutProblem,
} from "../../input/shortcuts";
import { contributedKeymaps, onContribChange } from "../../plugins/contrib";
import { shippedPlugins } from "../../plugins/shipped";
import { sameId } from "../../plugins/manifest";
import Button from "../ui/Button.vue";
import Dialog from "../ui/Dialog.vue";
import TextField from "../ui/TextField.vue";

const dialogs = useDialogStore();
const close = () => {
  dialogs.shortcuts = false;
};

const modals = useModalStore();
let ownDepth = 0;

interface Page {
  id: string;
  label: string;
  groups: HudGroup[];
}

const tick = ref(0);
const pages = computed<Page[]>(() => {
  void tick.value;
  const maps = contributedKeymaps();
  const core = new Set(SHORTCUTS.map((s) => s.action));
  const theirs = new Set(maps.flatMap((m) => m.keymap.map((o) => o.action).filter((a) => !core.has(a))));
  const nameOf = (id: string) => shippedPlugins().find((p) => sameId(p.manifest.id, id))?.manifest.name ?? id;
  return [
    { id: "general", label: "General", groups: shortcutHudGroups(theirs) },
    ...maps.map((m) => ({
      id: m.plugin,
      label: nameOf(m.plugin),
      groups: shortcutGroupsOf(new Set(m.keymap.map((o) => o.action))),
    })),
  ];
});
const mine = computed(() => {
  void tick.value;
  return new Set(userShortcutIds());
});

const category = ref("general");
const current = computed(() => pages.value.find((p) => p.id === category.value) ?? pages.value[0]!);
const query = ref("");

const matches = (r: { key: string; label: string }, q: string) => `${r.label} ${r.key}`.toLowerCase().includes(q);
const shown = computed<Page[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [current.value];
  return pages.value
    .map((p) => ({
      ...p,
      groups: p.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => matches(r, q)) })).filter((g) => g.rows.length),
    }))
    .filter((p) => p.groups.length);
});

const resettable = computed(() =>
  current.value.groups.flatMap((g) => g.rows.flatMap((r) => (r.id && mine.value.has(r.id) ? [r.id] : []))),
);

const wide = (g: HudGroup) => ["Conflicts", "Mouse", "Always"].includes(g.name);

const capturing = ref<string | null>(null);
interface Pending {
  id: string;
  keys: { key: string; shift: boolean; ctrl: boolean };
  name: string;
  problem: ShortcutProblem;
}
const pending = ref<Pending | null>(null);

function startCapture(id: string, ev: MouseEvent) {
  pending.value = null;
  capturing.value = id;
  (ev.currentTarget as HTMLElement).focus();
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

function capture(e: KeyboardEvent, id: string) {
  e.preventDefault();
  e.stopImmediatePropagation();
  if (MODIFIERS.has(e.key)) return;
  if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    capturing.value = null;
    return;
  }
  // "?" arrives with shift held and keymap.ts resolves it without, so it is stored that way.
  const keys = {
    key: e.key.toLowerCase(),
    shift: e.key === "?" ? false : e.shiftKey,
    ctrl: e.ctrlKey || e.metaKey,
  };
  const problem = setUserShortcut(id, { ...keys, alt: e.altKey });
  capturing.value = null;
  if (!problem) return;
  pending.value = { id, keys, problem, name: formatShortcut({ ...keys, action: "", context: "global", label: "" }) };
}

function problemText(p: Pending): string {
  const p0 = p.problem;
  if ("conflict" in p0) return `${fmtKeys(p.name)} is already used by ${p0.conflict.label}`;
  if ("reserved" in p0) return `${fmtKeys(p.name)} is taken by ${p0.reserved}`;
  return p0.refused;
}

function replace() {
  const p = pending.value;
  if (p) setUserShortcut(p.id, p.keys, true);
  pending.value = null;
}

function reset(ids: string[]) {
  pending.value = null;
  resetUserShortcuts(ids);
}

function onKey(e: KeyboardEvent) {
  if (capturing.value) return capture(e, capturing.value);
  if (e.key !== "Escape" || modals.current !== null || modals.depth !== ownDepth || escapeClaimed()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (pending.value) pending.value = null;
  else if (query.value) query.value = "";
  else close();
}

const stops: (() => void)[] = [];
onMounted(() => {
  ownDepth = modals.depth;
  window.addEventListener("keydown", onKey, true);
  stops.push(
    onShortcutsChange(() => tick.value++),
    onContribChange(() => tick.value++),
  );
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey, true);
  for (const stop of stops) stop();
});
</script>

<template>
  <!-- Escape is this dialog's own layered handler above; the frame holds the modal gate, focus and its return. -->
  <Dialog
    title="Keyboard shortcuts"
    panel-class="prefs-panel shortcuts-panel"
    :close-on-esc="false"
    :body="false"
    initial-focus="[data-shortcut-search]"
    @close="close()"
  >
    <div class="modal-body prefs">
      <nav class="prefs-nav" aria-label="Shortcut pages">
        <button
          v-for="p in pages"
          :key="p.id"
          type="button"
          class="prefs-nav-btn"
          :class="{ active: !query.trim() && current.id === p.id }"
          :aria-current="!query.trim() && current.id === p.id ? 'page' : undefined"
          :data-category="p.id"
          @click="
            category = p.id;
            query = '';
          "
          >{{ p.label }}</button
        >
      </nav>

      <div class="prefs-panes">
        <TextField
          v-model="query"
          class="sc-search"
          type="search"
          spellcheck="false"
          placeholder="Search shortcuts"
          aria-label="Search shortcuts"
          data-shortcut-search
        />

        <div v-if="!shown.length" class="pref-hint">No shortcut matches that.</div>
        <section v-for="p in shown" :key="p.id" class="prefs-pane" :data-page="p.id">
          <div class="sc-head">
            <h3 class="prefs-pane-title">{{ p.label }}</h3>
            <Button v-if="!query.trim() && resettable.length" size="sm" class="sc-reset-all" @click="reset(resettable)"
              >Reset all</Button
            >
          </div>
          <div class="prefs-grid">
            <div v-for="g in p.groups" :key="g.name" class="pref-card" :class="{ wide: wide(g) }">
              <div class="pref-head">
                <span class="pref-title">{{ g.name }}</span>
              </div>
              <div v-for="(r, i) in g.rows" :key="r.id ?? i" class="sc-row" :class="{ changed: r.changed }">
                <span class="sc-label">{{ r.label }}</span>
                <span v-if="r.changed" class="sc-changed">changed</span>
                <template v-if="r.id">
                  <button
                    type="button"
                    class="sc-key"
                    :class="{ capturing: capturing === r.id, unset: !r.key }"
                    :title="capturing === r.id ? 'Press the new keys, Esc cancels' : 'Click to change'"
                    @click="startCapture(r.id, $event)"
                    @blur="capturing === r.id && (capturing = null)"
                    ><template v-if="capturing === r.id">Press keys…</template
                    ><kbd v-else-if="r.key">{{ fmtKeys(r.key) }}</kbd
                    ><template v-else>Not set</template></button
                  >
                  <button
                    v-if="mine.has(r.id)"
                    type="button"
                    class="sc-reset"
                    title="Back to the default"
                    @click="reset([r.id])"
                    >Reset</button
                  >
                </template>
                <template v-else>
                  <kbd>{{ fmtKeys(r.key) }}</kbd>
                  <span class="sc-fixed" title="This one cannot be changed here">fixed</span>
                </template>
                <div v-if="pending && pending.id === r.id" class="sc-problem" role="alert">
                  <span>{{ problemText(pending) }}</span>
                  <Button v-if="'conflict' in pending.problem" size="sm" variant="primary" @click="replace()"
                    >Replace</Button
                  >
                  <Button size="sm" @click="pending = null">Cancel</Button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <template #footer>
      <Button variant="primary" @click="close()">Done</Button>
    </template>
  </Dialog>
</template>
