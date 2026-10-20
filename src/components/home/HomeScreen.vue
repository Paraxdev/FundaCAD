<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useHomeStore } from "../../stores/home";
import { useModalStore } from "../../stores/modals";
import { useModalGate } from "../../composables/useModalGate";
import { welcomeOnStartup, setWelcomeOnStartup } from "../../ui/welcome";
import { forgetRecent, getRecentFiles } from "../../io/recentFiles";
import { library, type FileStat, type FolderListing } from "../../io/library";
import { addFolder, getFolders, removeFolder } from "../../io/homeFolders";
import { setSaveFolder } from "../../io/saveFolder";
import { useContextMenuStore } from "../../stores/contextMenu";
import { choose } from "../../ui/choice";
import { contextMenu } from "../../ui/menu";
import { escapeClaimed } from "../../ui/escapeClaim";
import { buildEntries, filterEntries, folderEntries, folderName, folderSort, sortEntries, type HomeEntry, type SortMode } from "../../ui/homeList";
import { readSetting } from "../../ui/storedSetting";
import { thumbQueueFor } from "../../ui/thumbQueue";
import { getTheme, onThemeChange, themeMode } from "../../ui/theme";
import Icon from "../shell/Icon.vue";
import DocCard from "./DocCard.vue";
import HomeSidebar from "./HomeSidebar.vue";
import VersionsDrawer from "./VersionsDrawer.vue";
import { liveSummary } from "../../ui/homeVersions";
import NewStrip from "./NewStrip.vue";
import logoDarkUrl from "../../../assets/brand/fundacad-lockup-app.svg";
import logoLightUrl from "../../../assets/brand/fundacad-lockup-app-light.svg";

const home = useHomeStore();
const modals = useModalStore();
const cb = home.callbacks!;
const ctx = useContextMenuStore();
const lib = library();
const thumbs = lib ? thumbQueueFor(lib) : null;

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
    if (drawer.value) drawer.value = null;
    else if (e.target === searchField.value && query.value) query.value = "";
    else close();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    e.stopImmediatePropagation();
    searchField.value?.focus();
    searchField.value?.select();
    return;
  }
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
const query = ref("");
const SORT_KEY = "fundacad.home.sort";
const SORTS: { value: SortMode; label: string }[] = [
  { value: "opened", label: "Last opened" },
  { value: "edited", label: "Last edited" },
  { value: "name", label: "Name" },
];
const stored = readSetting(SORT_KEY);
const sort = ref<SortMode>(SORTS.some((s) => s.value === stored) ? (stored as SortMode) : "opened");
watch(sort, (v) => {
  try { localStorage.setItem(SORT_KEY, v); } catch { /* blocked storage keeps the default */ }
});
const searchField = ref<HTMLInputElement | null>(null);

const folders = ref(getFolders());
/** "recent" or the path of a folder. */
const view = ref("recent");
const listings = ref(new Map<string, FolderListing | Error>());
const loading = ref<string | null>(null);
const inFolder = computed(() => view.value !== "recent");
const listing = computed(() => (inFolder.value ? listings.value.get(view.value) ?? null : null));

const sorts = computed(() => (inFolder.value ? SORTS.filter((s) => s.value !== "opened") : SORTS));
const shownSort = computed<SortMode>({
  get: () => (inFolder.value ? folderSort(sort.value) : sort.value),
  set: (v) => { sort.value = v; },
});

const all = computed(() => {
  if (!inFolder.value) return buildEntries(recents.value, cb.currentPath(), stats.value);
  const l = listing.value;
  return l && !(l instanceof Error) ? folderEntries(l.files, recents.value, cb.currentPath()) : [];
});
const entries = computed(() => sortEntries(filterEntries(all.value, query.value), shownSort.value));
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

async function showView(next: string): Promise<void> {
  view.value = next;
  if (next === "recent" || !lib) return;
  loading.value = next;
  let got: FolderListing | Error;
  try {
    got = await lib.list(next);
  } catch (err) {
    got = err instanceof Error ? err : new Error(String(err));
  }
  listings.value = new Map(listings.value).set(next, got);
  if (loading.value === next) loading.value = null;
}

async function pickFolder(): Promise<void> {
  if (!lib) return;
  const dir = await lib.pickFolder();
  if (!dir) return;
  addFolder(dir);
  folders.value = getFolders();
  if (folders.value.some((f) => f.path === dir)) await showView(dir);
}

function dropFolder(dir: string): void {
  removeFolder(dir);
  folders.value = getFolders();
  if (view.value === dir) view.value = "recent";
}

function folderMenu(dir: string, ev: MouseEvent): void {
  contextMenu(ev.clientX, ev.clientY, [{ label: "Remove from Home", onClick: () => dropFolder(dir) }]);
}

/** Only once Home has closed is the new document the one on screen, a refused discard leaves it up. */
async function startNew(start: () => Promise<void>): Promise<void> {
  const dir = inFolder.value ? view.value : null;
  await start();
  if (dir && !home.visible) setSaveFolder(dir);
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

const drawer = ref<HomeEntry | null>(null);

/** The open document's history is read live, it may hold versions the file does not have yet. */
function loadVersions(entry: HomeEntry) {
  return async () => {
    if (entry.path === cb.currentPath()) return liveSummary(cb.currentVersions());
    return lib ? lib.summary(entry.path) : null;
  };
}

async function versionAction(act: Promise<boolean>): Promise<void> {
  if (await act) {
    drawer.value = null;
    close();
  }
}

function entryMenu(entry: HomeEntry, ev: MouseEvent): void {
  contextMenu(ev.clientX, ev.clientY, [
    { label: "Open", onClick: () => void openEntry(entry) },
    ...(entry.missing ? [] : [{ label: "Versions", onClick: () => { drawer.value = entry; } }]),
    ...(inFolder.value ? [] : [{ label: "Remove from list", onClick: () => forget(entry.path) }]),
    { separator: true, label: "" },
    { label: "Copy path", onClick: () => void navigator.clipboard?.writeText(entry.path).catch(() => {}) },
  ]);
}

function onViewSelect(el: HTMLSelectElement): void {
  if (el.value === "add") {
    // A cancelled dialog changes no view, so nothing would re-render the select.
    el.value = view.value;
    void pickFolder();
    return;
  }
  void showView(el.value);
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
      <HomeSidebar
        :folders="folders"
        :view="view"
        :loading="loading"
        :can-add="!!lib"
        @view="(v) => void showView(v)"
        @add="pickFolder()"
        @menu="folderMenu"
      />
    </aside>

    <div class="home-main">
      <div class="home-head">
        <NewStrip
          @blank="startNew(() => cb.newDocument())"
          @open="cb.openDoc()"
          @template="(id) => startNew(() => cb.newFromTemplate(id))"
        />
        <button class="modal-close" aria-label="Back to the document" title="Back to the document" @click="close()">
          <Icon name="close" :size="15" />
        </button>
      </div>

      <div v-if="lib && (all.length || folders.length)" class="home-tools">
        <select
          class="home-view-select"
          :value="view"
          aria-label="Show"
          @change="onViewSelect($event.target as HTMLSelectElement)"
        >
          <option value="recent">Recent</option>
          <option v-for="f in folders" :key="f.path" :value="f.path">{{ folderName(f.path) }}</option>
          <option value="add">Add folder…</option>
        </select>
        <input
          ref="searchField"
          v-model="query"
          class="home-search"
          type="search"
          placeholder="Search documents"
          aria-label="Search documents"
          spellcheck="false"
        />
        <select v-model="shownSort" class="home-sort" aria-label="Sort by">
          <option v-for="s in sorts" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </div>

      <p v-if="listing && !(listing instanceof Error) && listing.truncated" class="home-note">
        Showing the first 2000 documents
      </p>
      <div v-if="lib && entries.length" class="home-grid">
        <DocCard
          v-for="e in entries"
          :key="e.path"
          :entry="e"
          :unreadable="unreadable.has(e.path)"
          :thumbs="thumbs"
          @open="openEntry(e)"
          @menu="entryMenu(e, $event)"
          @versions="drawer = e"
        />
      </div>
      <p v-else-if="lib && all.length" class="home-empty">No documents match</p>
      <p v-else-if="listing instanceof Error" class="home-empty">{{ folderName(view) }} could not be read.</p>
      <p v-else-if="inFolder && listing" class="home-empty">No documents in this folder.</p>
      <p v-else-if="inFolder" class="home-empty">Looking for documents…</p>
      <p v-else-if="lib" class="home-empty">Documents you open or save appear here.</p>
      <p v-else class="home-empty">Recent documents appear here in the desktop app.</p>

      <VersionsDrawer
        v-if="drawer"
        :key="drawer.path"
        :name="drawer.name"
        :load="loadVersions(drawer)"
        @close="drawer = null"
        @restore="(id) => versionAction(cb.openVersion(drawer!.path, id, false))"
        @copy="(id) => versionAction(cb.openVersion(drawer!.path, id, true))"
        @branch="(name) => versionAction(cb.openBranch(drawer!.path, name))"
      />

      <div class="home-foot">
        <label class="home-startup">
          <input v-model="showOnStartup" type="checkbox" />
          Show Home on startup
        </label>
      </div>
    </div>
  </div>
</template>
