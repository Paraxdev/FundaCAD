<script setup lang="ts">
// Built-in capabilities only toggle, an installed plugin needs consent first. Origin shows for anything not from our
// releases, and what a plugin asked for and did not both come off plugins/manifest.ts, so neither half goes stale.

import { t } from "../../i18n";
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { describeGrants, sandboxNote } from "../../plugins/manifest";
import { pluginName, pluginSummary } from "../../plugins/pluginNames";
import { contributedSettings, onContribChange } from "../../plugins/contrib";
import { removePluginSettings, settingMatches } from "../../plugins/settings";
import { pluginFocus } from "../../plugins/settingsFocus";
import PluginSettingsForm from "./PluginSettingsForm.vue";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import TextField from "../ui/TextField.vue";
import {
  inspectFile,
  inspectUrl,
  installCandidate,
  installPlugin,
  installedManifest,
  installedPlugins,
  officialPlugins,
  pickBundle,
  removePlugin,
  type Candidate,
  type InstalledPlugin,
  type OfficialPlugin,
} from "../../plugins";
import { onPluginChange, pluginEnabled, setPluginEnabled } from "../../plugins/registry";
import { updateFor } from "../../plugins/updates";
import { confirmDanger } from "../../ui/choice";
import { toast } from "../../ui/toast";
import { plainError, SEE_CONSOLE } from "../../ui/plainError";

const suggested = ref<OfficialPlugin[]>(officialPlugins());

const installed = ref<InstalledPlugin[]>([]);
/** the id whose permission list is open, at most one */
const showing = ref("");
/** the id being installed or removed, so its buttons can say so */
const busy = ref("");

/** what the user typed, before anything has been fetched */
const url = ref("");
/** A bundle read and not installed, at most one: two consent screens compete for the same attention. The consent is
 *  inline, not a second modal, since a dialog over a dialog gets dismissed unread. */
const candidate = ref<Candidate | null>(null);
const reading = ref(false);

// Mirrored because the registry stays Vue-free for the headless suite. Off is not Remove: the bundle stays on disk and
// what it wrote stays in the document.
const on = ref<Record<string, boolean>>({});
const readState = () => {
  const next: Record<string, boolean> = {};
  for (const rec of installed.value) next[rec.id] = pluginEnabled(rec.id);
  on.value = next;
};
let offPlugins: (() => void) | null = null;
onMounted(() => {
  offPlugins = onPluginChange(readState);
});
onUnmounted(() => offPlugins?.());

function toggle(id: string, run: boolean, name: string) {
  setPluginEnabled(id, run).catch((err: unknown) =>
    toast(
      t(run ? "plugins.toast.onFailed" : "plugins.toast.offFailed", { name, detail: plainError(err, SEE_CONSOLE) }),
      {
        kind: "error",
        detail: err,
      },
    ),
  );
  readState();
}

const record = (id: string) => installed.value.find((r) => r.id === id);

const sections = shallowRef(contributedSettings());
let offContrib: (() => void) | null = null;
onMounted(() => {
  offContrib = onContribChange(() => {
    sections.value = contributedSettings();
  });
});
onUnmounted(() => offContrib?.());

const sectionsOf = (id: string) => sections.value.filter((x) => x.plugin === id).map((x) => x.section);

/** the ids whose settings are expanded */
const expanded = ref<Set<string>>(new Set());
const query = ref("");
/** ids whose Remove also forgets their settings */
const forget = ref<Record<string, boolean>>({});

function toggleSettings(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function nameOf(id: string): string {
  const rec = record(id);
  const manifest = (rec && installedManifest(rec)) || suggested.value.find((p) => p.manifest.id === id)?.manifest;
  return manifest ? pluginName(manifest) : id;
}

const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" });

/** Whether a plugin's name, id or a setting matches the search; true for all while it is empty. */
function matches(id: string): boolean {
  const q = query.value.trim();
  if (!q) return true;
  const low = q.toLowerCase();
  if (id.toLowerCase().includes(low) || nameOf(id).toLowerCase().includes(low)) return true;
  return sectionsOf(id).some((s) => s.settings?.schema.props.some((p) => settingMatches(p, q)));
}

const settingsOpen = (id: string) => expanded.value.has(id) || (!!query.value.trim() && matches(id));

async function resetAll(id: string) {
  const name = nameOf(id);
  const ok = await confirmDanger(
    t("plugins.reset.title", { name }),
    t("plugins.reset.action"),
    t("plugins.reset.body"),
  );
  if (!ok) return;
  for (const s of sectionsOf(id)) s.settings?.reset();
  toast(t("plugins.reset.done", { name }));
}

const hasDeclared = (id: string) => sectionsOf(id).some((s) => s.settings);

async function focusPlugin(id: string | null) {
  if (!id) return;
  query.value = "";
  expanded.value = new Set([...expanded.value, id]);
  pluginFocus.value = null;
  await nextTick();
  document.querySelector(`[data-plugin-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
}
watch(pluginFocus, focusPlugin);
onMounted(() => void focusPlugin(pluginFocus.value));

const rows = computed(() =>
  installed.value
    .map((rec) => ({
      rec,
      manifest: installedManifest(rec),
      update: updateFor(rec, suggested.value),
    }))
    .filter((r) => matches(r.rec.id))
    .sort((a, b) => byName(a.rec.id, b.rec.id)),
);

/** Plugins a development build runs from this repository without installing
 *  them, so their settings have a row to sit under. */
const fromSource = computed(() => {
  const ids = [...new Set(sections.value.map((x) => x.plugin))].filter((id) => !record(id) && matches(id)).sort(byName);
  return ids.map((id) => ({ id, manifest: suggested.value.find((p) => p.manifest.id === id)?.manifest ?? null }));
});

/** An update whose promise grew installs only from its own consent screen. */
function update(u: NonNullable<ReturnType<typeof updateFor>>) {
  if (u.covered) void accept(u.offer, "updated");
  else showing.value = `update:${u.offer.manifest.id}`;
}

/** Suggestions not yet installed, an installed one becomes an ordinary row above. */
const notYet = computed(() => suggested.value.filter((p) => !record(p.manifest.id)));

/** Where a row came from, for anything we did not publish. Ours says nothing, a label on every row goes unread. */
function whereFrom(rec: InstalledPlugin): string {
  if (rec.official) return "";
  if (!rec.source.startsWith("https://")) return t("plugins.from.file");
  try {
    return t("plugins.from.host", { host: new URL(rec.source).host });
  } catch {
    return t("plugins.from.unknown");
  }
}

async function refresh() {
  try {
    installed.value = await installedPlugins();
    readState();
  } catch (err) {
    // Not a toast: a failed directory read while browsing Preferences is worth logging, not interrupting for.
    console.error("[plugins] could not list what is installed:", err);
  }
}
onMounted(refresh);

async function accept(plugin: OfficialPlugin, done: "installed" | "updated" = "installed") {
  busy.value = plugin.manifest.id;
  try {
    await installPlugin(plugin);
    showing.value = "";
    await refresh();
    toast(
      t(done === "updated" ? "plugins.toast.updated" : "plugins.toast.installed", {
        name: pluginName(plugin.manifest),
      }),
    );
  } catch (err) {
    // A refusal names itself, so its own sentence is kept: "install failed" cannot be told from a flat network.
    toast(
      t("plugins.toast.installFailed", { name: pluginName(plugin.manifest), detail: plainError(err, SEE_CONSOLE) }),
      {
        kind: "error",
        detail: err,
      },
    );
  } finally {
    busy.value = "";
  }
}

/** Reads a bundle so it can be described, nothing is installed by this. */
async function read(from: () => Promise<Candidate | null>) {
  reading.value = true;
  candidate.value = null;
  try {
    candidate.value = await from();
  } catch (err) {
    toast(t("plugins.toast.readFailed", { detail: plainError(err, SEE_CONSOLE) }), { kind: "error", detail: err });
  } finally {
    reading.value = false;
  }
}

const readUrl = () => {
  const want = url.value.trim();
  if (!want) return;
  return read(() => inspectUrl(want));
};

const readFile = () =>
  read(async () => {
    const path = await pickBundle();
    return path ? await inspectFile(path) : null;
  });

async function acceptCandidate(c: Candidate) {
  busy.value = c.manifest.id;
  try {
    await installCandidate(c);
    candidate.value = null;
    url.value = "";
    await refresh();
    toast(t("plugins.toast.installed", { name: pluginName(c.manifest) }));
  } catch (err) {
    toast(t("plugins.toast.installFailed", { name: pluginName(c.manifest), detail: plainError(err, SEE_CONSOLE) }), {
      kind: "error",
      detail: err,
    });
  } finally {
    busy.value = "";
  }
}

async function drop(id: string, name: string) {
  const body = !sectionsOf(id).length
    ? t("plugins.remove.body")
    : forget.value[id]
      ? t("plugins.remove.bodyForget")
      : t("plugins.remove.bodyKeep");
  if (!(await confirmDanger(t("plugins.remove.title", { name }), t("plugins.remove"), body))) return;
  busy.value = id;
  try {
    await removePlugin(id);
    if (forget.value[id]) removePluginSettings(id);
    await refresh();
    toast(t("plugins.toast.removed", { name }));
  } catch (err) {
    toast(t("plugins.toast.removeFailed", { name, detail: plainError(err, SEE_CONSOLE) }), {
      kind: "error",
      detail: err,
    });
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <div class="sm-section">{{ t("plugins.title") }}</div>
  <div class="sm-hint">{{ t("plugins.installedHint") }}</div>

  <TextField
    v-if="sections.length"
    v-model="query"
    class="plug-search"
    type="search"
    spellcheck="false"
    :placeholder="t('plugins.search')"
    :label="t('plugins.search')"
    data-plugin-settings-search
  />

  <div v-if="rows.length === 0 && fromSource.length === 0" class="sm-hint">
    {{ query.trim() ? t("plugins.noMatch") : t("plugins.none") }}
  </div>
  <div
    v-for="{ rec, manifest, update: u } in rows"
    :key="rec.id"
    class="plug-row"
    :data-plugin="rec.id"
    :data-plugin-row="rec.id"
  >
    <div class="plug-head">
      <div>
        <div :id="`prefs-plugin-${rec.id}-name`" class="plug-name">{{ manifest ? pluginName(manifest) : rec.id }}</div>
        <div class="plug-summary">{{ manifest ? pluginSummary(manifest) : "" }}</div>
      </div>
      <div class="plug-controls">
        <Button
          v-if="sectionsOf(rec.id).length"
          class="plug-settings-btn"
          :class="{ on: settingsOpen(rec.id) }"
          :aria-expanded="settingsOpen(rec.id)"
          icon="settings"
          data-plugin-settings-toggle
          @click="toggleSettings(rec.id)"
        >
          {{ t("plugins.settings") }}
        </Button>
        <Checkbox
          :id="`prefs-plugin-${rec.id}`"
          :model-value="on[rec.id] !== false"
          :labelledby="`prefs-plugin-${rec.id}-name`"
          :tip="t('plugins.run', { name: manifest ? pluginName(manifest) : rec.id })"
          :title="on[rec.id] === false ? t('plugins.state.off') : t('plugins.state.on')"
          @update:model-value="toggle(rec.id, $event, manifest ? pluginName(manifest) : rec.id)"
        />
        <Button :disabled="busy === rec.id" @click="drop(rec.id, manifest ? pluginName(manifest) : rec.id)">
          {{ busy === rec.id ? t("plugins.removing") : t("plugins.remove") }}
        </Button>
      </div>
    </div>

    <div class="plug-state">
      {{ t("plugins.version", { version: rec.version }) }}
      <span v-if="whereFrom(rec)"> {{ whereFrom(rec) }}</span>
      <Button variant="ghost" size="sm" @click="showing = showing === rec.id ? '' : rec.id">
        {{ showing === rec.id ? t("plugins.uses.hide") : t("plugins.uses.show") }}
      </Button>
      <Checkbox
        v-if="sectionsOf(rec.id).length"
        :model-value="!!forget[rec.id]"
        class="plug-forget"
        :label="t('plugins.forget')"
        @update:model-value="forget[rec.id] = $event"
      />
    </div>

    <div v-if="settingsOpen(rec.id)" class="plug-settings" :data-plugin-settings="rec.id">
      <PluginSettingsForm
        v-for="s in sectionsOf(rec.id)"
        :key="s.key"
        :settings="s.settings"
        :component="s.component"
        :title="s.title"
        :query="query"
      />
      <div v-if="hasDeclared(rec.id) && !query.trim()" class="plug-actions">
        <Button data-plugin-settings-reset @click="resetAll(rec.id)">{{ t("plugins.reset") }}</Button>
      </div>
    </div>

    <div v-if="u" class="plug-update" data-plugin-update>
      <span>{{ u.reason }}</span>
      <Button v-if="showing !== `update:${rec.id}`" variant="primary" :disabled="busy === rec.id" @click="update(u)">
        {{ busy === rec.id ? t("plugins.updating") : t("plugins.update") }}
      </Button>
    </div>

    <div v-if="u && showing === `update:${rec.id}`" class="plug-consent">
      <div class="plug-can">
        <div class="plug-listhead">{{ t("plugins.update.can", { version: u.offer.manifest.version }) }}</div>
        <ul>
          <li v-for="line in describeGrants(u.offer.manifest).can" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="plug-cannot">
        <div class="plug-listhead">{{ t("plugins.update.cannot") }}</div>
        <ul>
          <li v-for="line in describeGrants(u.offer.manifest).cannot" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="sm-hint">{{ sandboxNote(u.offer.manifest) }}</div>
      <div class="plug-actions">
        <Button :disabled="busy === rec.id" @click="showing = ''">{{ t("plugins.cancel") }}</Button>
        <Button variant="primary" :disabled="busy === rec.id" @click="accept(u.offer, 'updated')">
          {{ busy === rec.id ? t("plugins.updating") : t("plugins.update") }}
        </Button>
      </div>
    </div>

    <div v-if="!manifest" class="sm-hint">{{ t("plugins.unreadable") }}</div>

    <div v-if="showing === rec.id && manifest" class="plug-consent">
      <div class="plug-can">
        <div class="plug-listhead">{{ t("plugins.itCan") }}</div>
        <ul>
          <li v-for="line in describeGrants(manifest).can" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="plug-cannot">
        <div class="plug-listhead">{{ t("plugins.itCannot") }}</div>
        <ul>
          <li v-for="line in describeGrants(manifest).cannot" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="sm-hint">{{ sandboxNote(manifest) }}</div>
    </div>
  </div>

  <div v-for="{ id, manifest } in fromSource" :key="id" class="plug-row" :data-plugin-row="id">
    <div class="plug-head">
      <div>
        <div class="plug-name">{{ manifest ? pluginName(manifest) : id }}</div>
        <div class="plug-summary">{{ manifest ? pluginSummary(manifest) : "" }}</div>
      </div>
      <div class="plug-controls">
        <Button
          class="plug-settings-btn"
          :class="{ on: settingsOpen(id) }"
          :aria-expanded="settingsOpen(id)"
          icon="settings"
          data-plugin-settings-toggle
          @click="toggleSettings(id)"
        >
          {{ t("plugins.settings") }}
        </Button>
      </div>
    </div>
    <div class="plug-state">{{ t("plugins.fromSource") }}</div>
    <div v-if="settingsOpen(id)" class="plug-settings" :data-plugin-settings="id">
      <PluginSettingsForm
        v-for="s in sectionsOf(id)"
        :key="s.key"
        :settings="s.settings"
        :component="s.component"
        :title="s.title"
        :query="query"
      />
      <div v-if="hasDeclared(id) && !query.trim()" class="plug-actions">
        <Button data-plugin-settings-reset @click="resetAll(id)">{{ t("plugins.reset") }}</Button>
      </div>
    </div>
  </div>

  <div class="sm-section">{{ t("plugins.add.title") }}</div>
  <div class="sm-hint">{{ t("plugins.add.hint") }}</div>

  <div class="plug-row" data-plugin-add>
    <div class="plug-add">
      <TextField
        v-model="url"
        class="plug-address"
        type="url"
        spellcheck="false"
        placeholder="https://…"
        :label="t('plugins.add.address')"
        :disabled="reading"
        @keydown.enter="readUrl()"
      />
      <Button :disabled="reading || !url.trim()" @click="readUrl()">
        {{ reading ? t("plugins.add.reading") : t("plugins.add.read") }}
      </Button>
      <Button :disabled="reading" @click="readFile()">{{ t("plugins.add.file") }}</Button>
    </div>
  </div>

  <div v-if="candidate" class="plug-row" data-plugin-candidate>
    <div class="plug-head">
      <div>
        <div class="plug-name">{{ pluginName(candidate.manifest) }}</div>
        <div class="plug-summary">{{ pluginSummary(candidate.manifest) }}</div>
      </div>
    </div>
    <div class="plug-consent">
      <div class="plug-origin">
        <template v-if="candidate.official">{{
          t("plugins.candidate.official", { version: candidate.manifest.version })
        }}</template>
        <template v-else>{{
          t("plugins.candidate.unchecked", { version: candidate.manifest.version, origin: candidate.origin })
        }}</template>
      </div>
      <div class="plug-can">
        <div class="plug-listhead">{{ t("plugins.willCan", { name: pluginName(candidate.manifest) }) }}</div>
        <ul>
          <li v-for="line in describeGrants(candidate.manifest).can" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="plug-cannot">
        <div class="plug-listhead">{{ t("plugins.update.cannot") }}</div>
        <ul>
          <li v-for="line in describeGrants(candidate.manifest).cannot" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="sm-hint">{{ sandboxNote(candidate.manifest) }}</div>
      <div class="plug-actions">
        <Button :disabled="busy === candidate.manifest.id" @click="candidate = null">{{ t("plugins.cancel") }}</Button>
        <Button variant="primary" :disabled="busy === candidate.manifest.id" @click="acceptCandidate(candidate)">
          {{ busy === candidate.manifest.id ? t("plugins.installing") : t("plugins.install") }}
        </Button>
      </div>
    </div>
  </div>

  <div v-if="notYet.length" class="sm-section">{{ t("plugins.madeBy") }}</div>

  <div v-for="p in notYet" :key="p.manifest.id" class="plug-row" :data-plugin="p.manifest.id">
    <div class="plug-head">
      <div>
        <div class="plug-name">{{ pluginName(p.manifest) }}</div>
        <div class="plug-summary">{{ pluginSummary(p.manifest) }}</div>
      </div>
      <Button v-if="showing !== p.manifest.id" variant="primary" @click="showing = p.manifest.id">{{
        t("plugins.install")
      }}</Button>
    </div>

    <div v-if="showing === p.manifest.id" class="plug-consent">
      <div class="plug-can">
        <div class="plug-listhead">{{ t("plugins.willCan", { name: pluginName(p.manifest) }) }}</div>
        <ul>
          <li v-for="line in describeGrants(p.manifest).can" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="plug-cannot">
        <div class="plug-listhead">{{ t("plugins.update.cannot") }}</div>
        <ul>
          <li v-for="line in describeGrants(p.manifest).cannot" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="sm-hint">{{ sandboxNote(p.manifest) }}</div>
      <div class="plug-actions">
        <Button :disabled="busy === p.manifest.id" @click="showing = ''">{{ t("plugins.cancel") }}</Button>
        <Button variant="primary" :disabled="busy === p.manifest.id" @click="accept(p)">
          {{ busy === p.manifest.id ? t("plugins.installing") : t("plugins.install") }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plug-search {
  width: 100%;
  margin: var(--s-2) 0;
}
.plug-address {
  flex: 1 1 240px;
}
</style>
