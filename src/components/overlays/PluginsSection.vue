<script setup lang="ts">
// The Plugins section of Preferences: what can be installed, what is installed,
// and the screen that has to be answered in between.
//
// A section rather than a dialog of its own. The consent screen is inline for
// the same reason: a dialog opened on top of a dialog is a dialog people
// dismiss without reading, and this is the one screen in the app where reading
// is the entire point.
//
// It renders two lists, not one. What the plugin asked for, and what it did
// not. Both come off the same table in plugins/manifest.ts, so the reassuring
// half cannot quietly go stale while the alarming half stays current, and a
// modest plugin looks different from a greedy one at a glance.

import { onMounted, ref } from "vue";
import { describeGrants, sandboxNote } from "../../plugins/manifest";
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

const offered = officialPlugins();

const installed = ref<InstalledPlugin[]>([]);
/** the id whose consent screen is open, at most one */
const asking = ref("");
/** the id being installed or removed, so its buttons can say so */
const busy = ref("");
/** id to the launch config, once someone has asked to see it */
const setup = ref<Record<string, string>>({});

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
    asking.value = "";
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
  <div class="sm-section">Plugins</div>
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
        v-else-if="asking !== p.manifest.id"
        class="btn btn-primary"
        @click="asking = p.manifest.id"
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

    <div v-if="asking === p.manifest.id" class="plug-consent">
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
        <button class="btn" :disabled="busy === p.manifest.id" @click="asking = ''">
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
