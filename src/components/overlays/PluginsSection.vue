<script setup lang="ts">
// The Plugins section of Preferences: what the app can do that it does not have
// to, what is on, and what each one reaches.
//
// Two lists, and the difference between them is the honest part. The built-in
// capabilities are the app's own code and are only turned on and off; an
// installed plugin is somebody else's code and has to be agreed to before it
// arrives. They share a screen because the question a person is answering is
// the same one, and they share the two-column description because that question
// deserves the same answer either way. What they do not share is the language
// of enforcement: sandboxNote() says which is which, in the entry's own words.
//
// THE SECOND LIST IS WHAT IS INSTALLED, not what shipped. A plugin can come
// from this project's releases, from a URL somebody was given, or from a zip on
// their disk, and once it is installed all three are the same kind of row. The
// suggestions we ship are shown underneath as things not installed yet, which
// is all they are.
//
// WHERE IT CAME FROM IS ON THE SCREEN, for anything not from our own releases.
// Origin is not a permission and does not change what a plugin may do; it is
// the other half of the question, and the half a person can actually judge. A
// screen that lists reach without saying who is reaching asks somebody to
// decide with one of the two facts missing.
//
// The consent screen is inline rather than a second modal. A dialog opened on
// top of a dialog is a dialog people dismiss without reading, and this is the
// one screen in the app where reading is the entire point.
//
// It renders what the plugin asked for AND what it did not. Both come off the
// same table in plugins/manifest.ts, so the reassuring half cannot quietly go
// stale while the alarming half stays current, and a modest plugin looks
// different from a greedy one at a glance.

import { computed, onMounted, onUnmounted, ref } from "vue";
import { describeGrants, sandboxNote } from "../../plugins/manifest";
import {
  inspectFile,
  inspectUrl,
  installCandidate,
  installPlugin,
  installedManifest,
  installedPlugins,
  mcpConfigJson,
  officialPlugins,
  pickBundle,
  pythonRuntime,
  removePlugin,
  type Candidate,
  type InstalledPlugin,
  type OfficialPlugin,
} from "../../plugins";
import { onPluginChange, pluginEnabled, setPluginEnabled } from "../../plugins/registry";
import { toast } from "../../ui/toast";

const suggested = officialPlugins();

const installed = ref<InstalledPlugin[]>([]);
/** the id whose permission list is open, at most one */
const showing = ref("");
/** the id being installed or removed, so its buttons can say so */
const busy = ref("");
/** id to the launch config, once someone has asked to see it */
const setup = ref<Record<string, string>>({});

/** what the user typed, before anything has been fetched */
const url = ref("");
/** a bundle that has been read and not installed. At most one at a time: two
 *  consent screens open at once is two decisions competing for the same
 *  attention, and the one that gets it is the one that was clicked. */
const candidate = ref<Candidate | null>(null);
const reading = ref(false);

// The switch, mirrored. The registry is deliberately Vue-free, which is what
// lets the headless suite import it, so its state reaches the template through
// this.
//
// It sits on an INSTALLED row now rather than on a separate list of things
// compiled into the app, because that list no longer exists. Off does not mean
// gone: the bundle stays on disk and whatever it wrote stays in the document,
// which is the difference between this and Remove and the reason both are here.
const on = ref<Record<string, boolean>>({});
const readState = () => {
  const next: Record<string, boolean> = {};
  for (const rec of installed.value) next[rec.id] = pluginEnabled(rec.id);
  on.value = next;
};
let offPlugins: (() => void) | null = null;
onMounted(() => { offPlugins = onPluginChange(readState); });
onUnmounted(() => offPlugins?.());

function toggle(id: string, ev: Event) {
  setPluginEnabled(id, (ev.target as HTMLInputElement).checked);
  readState();
}

const record = (id: string) => installed.value.find((r) => r.id === id);
const setupFor = (id: string) => setup.value[id] ?? "";

/** Rows for what is installed, each with a manifest to describe it by. */
const rows = computed(() =>
  installed.value.map((rec) => ({ rec, manifest: installedManifest(rec) })),
);

/** Suggestions not yet installed. Once one is installed it is an ordinary row
 *  above, because there is nothing left about it that is a suggestion. */
const notYet = computed(() => suggested.filter((p) => !record(p.manifest.id)));

/** Where a row came from, for anything we did not publish. Ours says nothing,
 *  because a label on every row is a label nobody reads. */
function whereFrom(rec: InstalledPlugin): string {
  if (rec.official) return "";
  if (!rec.source.startsWith("https://")) return "Installed from a file on this computer.";
  try {
    return `Installed from ${new URL(rec.source).host}.`;
  } catch {
    return "Installed from somewhere this app can no longer read.";
  }
}

async function refresh() {
  try {
    installed.value = await installedPlugins();
    readState();
  } catch (err) {
    // Not a toast. Failing to read the plugin directory while someone browses
    // Preferences is worth knowing about, and worth nothing to interrupt for.
    console.error("[plugins] could not list what is installed:", err);
  }
}
onMounted(refresh);

// --- installing one we suggested -------------------------------------------

async function accept(plugin: OfficialPlugin) {
  busy.value = plugin.manifest.id;
  try {
    await installPlugin(plugin);
    showing.value = "";
    await refresh();
    toast(`${plugin.manifest.name} is installed.`);
  } catch (err) {
    // Shown in full. Every refusal on the way down names itself (a URL that is
    // not allowed, a bundle asking for more than the screen said, an entry
    // trying to write outside its own directory), and a failure summarised as
    // "install failed" is a failure nobody can tell from a flat network.
    toast(`Could not install ${plugin.manifest.name}. ${String(err)}`, { kind: "error" });
  } finally {
    busy.value = "";
  }
}

// --- installing one nobody has seen ----------------------------------------

/** Read a bundle so it can be described. Nothing is installed by this, and the
 *  button says so. */
async function read(from: () => Promise<Candidate | null>) {
  reading.value = true;
  candidate.value = null;
  try {
    candidate.value = await from();
  } catch (err) {
    toast(`Could not read that plugin. ${String(err)}`, { kind: "error" });
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
    toast(`${c.manifest.name} is installed.`);
  } catch (err) {
    toast(`Could not install ${c.manifest.name}. ${String(err)}`, { kind: "error" });
  } finally {
    busy.value = "";
  }
}

// --- removing ---------------------------------------------------------------

async function drop(id: string, name: string) {
  busy.value = id;
  try {
    await removePlugin(id);
    delete setup.value[id];
    await refresh();
    toast(`${name} is removed.`);
  } catch (err) {
    toast(`Could not remove ${name}. ${String(err)}`, { kind: "error" });
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
  <div class="sm-section">Installed plugins</div>
  <div class="sm-hint">
    Each gets what it asked for and nothing else. Off stops one without removing
    it.
  </div>

  <div v-if="rows.length === 0" class="sm-hint">Nothing installed yet.</div>

  <div v-for="{ rec, manifest } in rows" :key="rec.id" class="plug-row" :data-plugin="rec.id">
    <div class="plug-head">
      <div>
        <div class="plug-name">{{ manifest ? manifest.name : rec.id }}</div>
        <div class="plug-summary">{{ manifest ? manifest.summary : "" }}</div>
      </div>
      <div class="plug-controls">
        <span class="param-switch" :title="on[rec.id] === false ? 'Switched off' : 'Running'">
          <input
            :id="`prefs-plugin-${rec.id}`"
            type="checkbox"
            :checked="on[rec.id] !== false"
            @change="toggle(rec.id, $event)"
          />
          <span class="track"><span class="knob"></span></span>
        </span>
        <button class="btn" :disabled="busy === rec.id" @click="drop(rec.id, manifest ? manifest.name : rec.id)">
          {{ busy === rec.id ? "Removing…" : "Remove" }}
        </button>
      </div>
    </div>

    <div class="plug-state">
      Version {{ rec.version }}.
      <span v-if="whereFrom(rec)"> {{ whereFrom(rec) }}</span>
      <button
        class="plug-link"
        @click="showing = showing === rec.id ? '' : rec.id"
      >
        {{ showing === rec.id ? "Hide what it uses" : "What it uses" }}
      </button>
      <button v-if="rec.id === 'mcp'" class="plug-link" @click="showSetup(rec)">
        How to connect it
      </button>
    </div>

    <div v-if="!manifest" class="sm-hint">
      This app cannot read what this plugin agreed to. Remove it and install it
      again.
    </div>

    <div v-if="setupFor(rec.id)" class="plug-setup">
      <div class="sm-hint">
        Paste this into your assistant's MCP settings, then restart it.
      </div>
      <pre class="plug-config">{{ setupFor(rec.id) }}</pre>
      <button class="btn" @click="copy(setupFor(rec.id))">Copy</button>
    </div>

    <div v-if="showing === rec.id && manifest" class="plug-consent">
      <div class="plug-can">
        <div class="plug-listhead">It can</div>
        <ul>
          <li v-for="line in describeGrants(manifest).can" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="plug-cannot">
        <div class="plug-listhead">It cannot</div>
        <ul>
          <li v-for="line in describeGrants(manifest).cannot" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="sm-hint">{{ sandboxNote(manifest.kind) }}</div>
    </div>
  </div>

  <div class="sm-section">Add a plugin</div>
  <div class="sm-hint">Read and described first, installed only after you say so.</div>

  <div class="plug-row" data-plugin-add>
    <div class="plug-add">
      <input
        v-model="url"
        class="plug-url"
        type="url"
        spellcheck="false"
        placeholder="https://…"
        :disabled="reading"
        @keydown.enter="readUrl()"
      />
      <button class="btn" :disabled="reading || !url.trim()" @click="readUrl()">
        {{ reading ? "Reading…" : "Read it" }}
      </button>
      <button class="btn" :disabled="reading" @click="readFile()">Choose a file</button>
    </div>
  </div>

  <div v-if="candidate" class="plug-row" data-plugin-candidate>
    <div class="plug-head">
      <div>
        <div class="plug-name">{{ candidate.manifest.name }}</div>
        <div class="plug-summary">{{ candidate.manifest.summary }}</div>
      </div>
    </div>
    <div class="plug-consent">
      <div class="plug-origin">
        <template v-if="candidate.official">
          Version {{ candidate.manifest.version }}, published by FundaCAD.
        </template>
        <template v-else>
          Version {{ candidate.manifest.version }}, from {{ candidate.origin }}, unchecked.
        </template>
      </div>
      <div class="plug-can">
        <div class="plug-listhead">{{ candidate.manifest.name }} will be able to</div>
        <ul>
          <li v-for="line in describeGrants(candidate.manifest).can" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="plug-cannot">
        <div class="plug-listhead">It will not be able to</div>
        <ul>
          <li v-for="line in describeGrants(candidate.manifest).cannot" :key="line">{{ line }}</li>
        </ul>
      </div>
      <div class="sm-hint">{{ sandboxNote(candidate.manifest.kind) }}</div>
      <div class="plug-actions">
        <button
          class="btn"
          :disabled="busy === candidate.manifest.id"
          @click="candidate = null"
        >
          Cancel
        </button>
        <button
          class="btn btn-primary"
          :disabled="busy === candidate.manifest.id"
          @click="acceptCandidate(candidate)"
        >
          {{ busy === candidate.manifest.id ? "Installing…" : "Install" }}
        </button>
      </div>
    </div>
  </div>

  <div v-if="notYet.length" class="sm-section">Made by FundaCAD</div>

  <div v-for="p in notYet" :key="p.manifest.id" class="plug-row" :data-plugin="p.manifest.id">
    <div class="plug-head">
      <div>
        <div class="plug-name">{{ p.manifest.name }}</div>
        <div class="plug-summary">{{ p.manifest.summary }}</div>
      </div>
      <button
        v-if="showing !== p.manifest.id"
        class="btn btn-primary"
        @click="showing = p.manifest.id"
      >
        Install
      </button>
    </div>

    <div v-if="showing === p.manifest.id" class="plug-consent">
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
