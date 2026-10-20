<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useHomeStore } from "../../stores/home";
import { useModalStore } from "../../stores/modals";
import { useModalGate } from "../../composables/useModalGate";
import { welcomeOnStartup, setWelcomeOnStartup } from "../../ui/welcome";
import { forgetRecent, getRecentFiles } from "../../io/recentFiles";
import { library, type FileStat } from "../../io/library";
import { useContextMenuStore } from "../../stores/contextMenu";
import { choose } from "../../ui/choice";
import { contextMenu } from "../../ui/menu";
import { escapeClaimed } from "../../ui/escapeClaim";
import { buildEntries, type HomeEntry } from "../../ui/homeList";
import { getTheme, onThemeChange, themeMode } from "../../ui/theme";
import Icon from "../shell/Icon.vue";
import DocCard from "./DocCard.vue";
import NewStrip from "./NewStrip.vue";
import logoDarkUrl from "../../../assets/brand/fundacad-lockup-app.svg";
import logoLightUrl from "../../../assets/brand/fundacad-lockup-app-light.svg";

const home = useHomeStore();
const modals = useModalStore();
const cb = home.callbacks!;
const ctx = useContextMenuStore();
const lib = library();

const close = () => { home.visible = false; };

useModalGate();
let ownDepth = 0;
const onTop = () => modals.current === null && modals.depth === ownDepth;

const UNDO_KEYS = new Set(["z", "y"]);

function onKey(e: KeyboardEvent): void {
  if (!onTop()) return;
  if (e.key === "Escape") {
    if (ctx.open || escapeClaimed()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const inField = e.target instanceof HTMLInputElement && e.target.type !== "checkbox";
  if (mod && UNDO_KEYS.has(e.key.toLowerCase()) && !inField) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

const logoUrl = ref(themeMode(getTheme()) === "light" ? logoLightUrl : logoDarkUrl);
const offTheme = onThemeChange(() => {
  logoUrl.value = themeMode(getTheme()) === "light" ? logoLightUrl : logoDarkUrl;
});

const recents = ref(getRecentFiles());
const stats = ref(new Map<string, FileStat>());
const entries = computed(() => buildEntries(recents.value, cb.currentPath(), stats.value));
const unreadable = ref(new Set<string>());

async function refreshStats(): Promise<void> {
  if (!lib || !recents.value.length) return;
  try {
    const list = await lib.stat(recents.value.map((r) => r.path));
    stats.value = new Map(list.map((s) => [s.path, s]));
  } catch (err) {
    console.warn("[home] stat failed", err);
  }
}

function forget(path: string): void {
  forgetRecent(path);
  recents.value = getRecentFiles();
}

async function openEntry(entry: HomeEntry): Promise<void> {
  if (entry.open) return close();
  if (entry.missing) {
    const pick = await choose(`${entry.name} was not found.`, [
      { value: "remove", label: "Remove from list" },
      { value: "cancel", label: "Cancel" },
    ]);
    if (pick === "remove") forget(entry.path);
    return;
  }
  const outcome = await cb.openPath(entry.path);
  if (outcome === "ok") close();
  else if (outcome === "unreadable") unreadable.value = new Set(unreadable.value).add(entry.path);
}

function entryMenu(entry: HomeEntry, ev: MouseEvent): void {
  contextMenu(ev.clientX, ev.clientY, [
    { label: "Open", onClick: () => void openEntry(entry) },
    { label: "Remove from list", onClick: () => forget(entry.path) },
    { separator: true, label: "" },
    { label: "Copy path", onClick: () => void navigator.clipboard?.writeText(entry.path).catch(() => {}) },
  ]);
}

const showOnStartup = ref(welcomeOnStartup());
watch(showOnStartup, setWelcomeOnStartup);

onMounted(() => {
  ownDepth = modals.depth;
  window.addEventListener("keydown", onKey, true);
  void refreshStats();
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey, true);
  offTheme();
});
</script>

<template>
  <div class="home" role="dialog" aria-label="Home">
    <aside class="home-side">
      <img :src="logoUrl" alt="FundaCAD" class="home-logo" />
      <nav class="home-nav">
        <button class="home-nav-row active">Recent</button>
      </nav>
    </aside>

    <div class="home-main">
      <div class="home-head">
        <NewStrip @blank="cb.newDocument()" @open="cb.openDoc()" />
        <button class="modal-close" aria-label="Back to the document" title="Back to the document" @click="close()">
          <Icon name="close" :size="15" />
        </button>
      </div>

      <div v-if="lib && entries.length" class="home-grid">
        <DocCard
          v-for="e in entries"
          :key="e.path"
          :entry="e"
          :unreadable="unreadable.has(e.path)"
          @open="openEntry(e)"
          @menu="entryMenu(e, $event)"
        />
      </div>
      <p v-else-if="lib" class="home-empty">Documents you open or save appear here.</p>
      <p v-else class="home-empty">Recent documents appear here in the desktop app.</p>

      <div class="home-foot">
        <label class="home-startup">
          <input v-model="showOnStartup" type="checkbox" />
          Show Home on startup
        </label>
      </div>
    </div>
  </div>
</template>
