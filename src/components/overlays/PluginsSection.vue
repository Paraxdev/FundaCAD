<script setup lang="ts">
// The Plugins section of Preferences: what the app can do that it does not have
// to, what is on, and what each one reaches.
//
// Two lists, and the difference between them is the honest part. The built-in
// capabilities are the app's own code and are only turned on and off; a
// downloaded plugin is somebody else's code and has to be agreed to before it
// arrives. They share a screen because the question a person is answering is
// the same one, and they share the two-column description because that question
// deserves the same answer either way. What they do not share is the language
// of enforcement: sandboxNote() says which is which, in the entry's own words.
//
// The consent screen is inline rather than a second modal. A dialog opened on
// top of a dialog is a dialog people dismiss without reading, and this is the
// one screen in the app where reading is the entire point.
//
// It renders what the plugin asked for AND what it did not. Both come off the
// same table in plugins/manifest.ts, so the reassuring half cannot quietly go
// stale while the alarming half stays current, and a modest plugin looks
// different from a greedy one at a glance.

import { onMounted, onUnmounted, ref } from "vue";
import { describeGrants, sandboxNote, type PluginManifest } from "../../plugins/manifest";
import {
  builtinPlugins,
  onPluginChange,
  pluginEnabled,
  setPluginEnabled,
} from "../../plugins/registry";
import {
  installPlugin,
  installedPlugins,
  mcpConfigJson,
  officialPlugins,
  pythonRuntime,
  removePlugin,
  type InstalledPlugin,
  type OfficialPlugin,
} from "../../plugins";
import { toast } from "../../ui/toast";

const builtins = builtinPlugins();
const offered = officialPlugins();

const installed = ref<InstalledPlugin[]>([]);
/** the id whose permission list is open, at most one */
const showing = ref("");
/** the id being installed or removed, so its buttons can say so */
const busy = ref("");
/** id to the launch config, once someone has asked to see it */
const setup = ref<Record<string, string>>({});

// The registry is deliberately Vue-free, which is what lets the headless suite
// import it, so its state reaches the template through a mirror.
const on = ref<Record<string, boolean>>({});
const readState = () => {
  const next: Record<string, boolean> = {};
  for (const b of builtins) next[b.manifest.id] = pluginEnabled(b.manifest.id);
  on.value = next;
};
readState();
let offPlugins: (() => void) | null = null;
onMounted(() => { offPlugins = onPluginChange(readState); });
onUnmounted(() => offPlugins?.());

function toggle(manifest: PluginManifest, ev: Event) {
  const wanted = (ev.target as HTMLInputElement).checked;
  setPluginEnabled(manifest.id, wanted);
  // Turning something on shows what it reaches, without having been asked to.
  // Nobody is consenting here, the code is already in the app; but somebody
  // switching a capability on for the first time should not have to go looking
  // for what they switched on.
  if (wanted) showing.value = manifest.id;
}

const record = (id: string) => installed.value.find((r) => r.id === id);
const setupFor = (id: string) => setup.value[id] ?? "";

async function refresh() {
  try {
    installed.value = await installedPlugins();
  } catch (err) {
    // Not a toast. Failing to read the plugin directory while someone browses
    // Preferences is worth knowing about, and worth nothing to interrupt for.
    console.error("[plugins] could not list what is installed:", err);
  }
}
onMounted(refresh);

async function accept(plugin: OfficialPlugin) {
  busy.value = plugin.manifest.id;
  try {
    await installPlugin(plugin);
    showing.value = "";
    await refresh();
    toast(`${plugin.manifest.name} is installed.`);
  } catch (err) {
    // Shown in full. Every refusal on the way down names itself (the wrong
    // host, a bundle asking for more than the screen said, an entry trying to
    // write outside its own directory), and a failure summarised as "install
    // failed" is a failure nobody can tell from a flat network.
    toast(`Could not install ${plugin.manifest.name}. ${String(err)}`, { kind: "error" });
  } finally {
    busy.value = "";
  }
}

async function drop(plugin: OfficialPlugin) {
  busy.value = plugin.manifest.id;
  try {
    await removePlugin(plugin.manifest.id);
    delete setup.value[plugin.manifest.id];
    await refresh();
    toast(`${plugin.manifest.name} is removed.`);
  } catch (err) {
    toast(`Could not remove ${plugin.manifest.name}. ${String(err)}`, { kind: "error" });
  } finally {
    busy.value = "";
  }
}

/** The command line an MCP host needs. Asked for rather than always shown: it
 *  is four lines of JSON that only mean something to someone who is about to
 *  paste them somewhere. */
async function showSetup(rec: InstalledPlugin) {
  try {
    const rt = await pythonRuntime();
    setup.value = { ...setup.value, [rec.id]: mcpConfigJson(rec.dir, rt) };
  } catch (err) {
    toast(`Could not work out how to start it. ${String(err)}`, { kind: "error" });
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    toast("Could not copy. Select the text and copy it.", { kind: "error" });
  }
}
</script>

<template>
  <div class="sm-section">In the app</div>
  <div class="sm-hint">
    Parts of FundaCAD you can turn off. Off means it does not run: its buttons
    and panels are gone, and nothing it owns is loaded or connected to.
  </div>

  <div v-for="b in builtins" :key="b.manifest.id" class="plug-row">
    <div class="plug-head">
      <div>
        <div class="plug-name">{{ b.manifest.name }}</div>
        <div class="plug-summary">{{ b.manifest.summary }}</div>
      </div>
      <span class="param-switch">
        <input
          :id="`prefs-plugin-${b.manifest.id}`"
          type="checkbox"
          :checked="on[b.manifest.id]"
          @change="toggle(b.manifest, $event)"
        />
        <span class="track"><span class="knob"></span></span>
      </span>
    </div>
    <div class="plug-state">
      <button
        class="plug-link"
        @click="showing = showing === b.manifest.id ? '' : b.manifest.id"
      >
        {{ showing === b.manifest.id ? "Hide what it uses" : "What it uses" }}
      </button>
    </div>
    <div v-if="showing === b.manifest.id" class="plug-consent">
      <div class="plug-can">
        <div class="plug-listhead">It uses</div>
        <ul>
          <li v-for="line in describeGrants(b.manifest).can" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="plug-cannot">
        <div class="plug-listhead">It does not</div>
        <ul>
          <li v-for="line in describeGrants(b.manifest).cannot" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="sm-hint">{{ sandboxNote(b.manifest.kind) }}</div>
    </div>
  </div>

  <div class="sm-section">Plugins you download</div>
  <div class="sm-hint">
    Optional downloads, none of them installed to begin with. Official ones come
    from this project's own releases. Every plugin says up front what it wants
    to reach, and gets that and nothing else.
  </div>

  <div v-for="p in offered" :key="p.manifest.id" class="plug-row">
    <div class="plug-head">
      <div>
        <div class="plug-name">{{ p.manifest.name }}</div>
        <div class="plug-summary">{{ p.manifest.summary }}</div>
      </div>
      <button
        v-if="record(p.manifest.id)"
        class="btn"
        :disabled="busy === p.manifest.id"
        @click="drop(p)"
      >
        {{ busy === p.manifest.id ? "Removing…" : "Remove" }}
      </button>
      <button
        v-else-if="showing !== p.manifest.id"
        class="btn btn-primary"
        @click="showing = p.manifest.id"
      >
        Install
      </button>
    </div>

    <div v-if="record(p.manifest.id)" class="plug-state">
      Installed, version {{ record(p.manifest.id)!.version }}.
      <button class="plug-link" @click="showSetup(record(p.manifest.id)!)">
        How to connect it
      </button>
    </div>

    <div v-if="setupFor(p.manifest.id)" class="plug-setup">
      <div class="sm-hint">
        Paste this into your assistant's MCP settings, then restart it.
      </div>
      <pre class="plug-config">{{ setupFor(p.manifest.id) }}</pre>
      <button class="btn" @click="copy(setupFor(p.manifest.id))">Copy</button>
    </div>

    <div v-if="showing === p.manifest.id && !record(p.manifest.id)" class="plug-consent">
      <div class="plug-can">
        <div class="plug-listhead">{{ p.manifest.name }} will be able to</div>
        <ul>
          <li v-for="line in describeGrants(p.manifest).can" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="plug-cannot">
        <div class="plug-listhead">It will not be able to</div>
        <ul>
          <li v-for="line in describeGrants(p.manifest).cannot" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="sm-hint">{{ sandboxNote(p.manifest.kind) }}</div>
      <div class="plug-actions">
        <button class="btn" :disabled="busy === p.manifest.id" @click="showing = ''">
          Cancel
        </button>
        <button
          class="btn btn-primary"
          :disabled="busy === p.manifest.id"
          @click="accept(p)"
        >
          {{ busy === p.manifest.id ? "Installing…" : "Install" }}
        </button>
      </div>
    </div>
  </div>
</template>
