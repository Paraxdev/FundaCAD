<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from "vue";
import { ENGINE } from "../../app/engineKey";
import type { LiveState } from "../../live/liveSession";
import { asMcpHost, MCP_HOSTS, mcpServerPath, mcpSetupFor, type McpHost } from "../../live/mcpConnect";
import { asLiveEditingMode, liveEditingMode, onLiveEditingChange, setLiveEditingMode } from "../../ui/liveEditing";
import { toast } from "../../ui/toast";
import Select from "../ui/Select.vue";

// Injected rather than useEngine(): the section still has to render its
// settings where no engine was provided, and then simply has no status to show.
const engine = inject(ENGINE, null);

const live = ref(liveEditingMode());
const state = ref<LiveState>(engine?.live.snapshot ?? { sharing: false, guests: [], lastEdit: null });
const host = ref<McpHost>("claude-code");
const server = ref("");
const unavailable = ref("");

const stops: (() => void)[] = [];
onMounted(async () => {
  stops.push(onLiveEditingChange(() => { live.value = liveEditingMode(); }));
  if (engine) stops.push(engine.live.subscribe((s) => { state.value = s; }));
  try {
    server.value = await mcpServerPath();
  } catch (err) {
    unavailable.value = err instanceof Error ? err.message : String(err);
  }
});
onUnmounted(() => { for (const stop of stops) stop(); });

const LIVE_OPTIONS = [
  { value: "off", label: "Do not share" },
  { value: "read", label: "Share, read only" },
  { value: "edit", label: "Share, and allow edits" },
];
const hostOptions = computed(() => MCP_HOSTS.map((h) => ({ value: h.id, label: h.label })));

function onLive(id: string) {
  const v = asLiveEditingMode(id);
  if (v) setLiveEditingMode(v);
}

function onHost(id: string) {
  const v = asMcpHost(id);
  if (v) host.value = v;
}

const setup = computed(() => (server.value ? mcpSetupFor(host.value, server.value) : null));

const status = computed(() => {
  if (live.value === "off") return "Not shared. An assistant works on a copy of its own.";
  const guests = state.value.guests;
  if (!state.value.sharing || guests.length === 0) return "Shared, no assistant is connected.";
  const who = guests.length === 1 ? guests[0] : `${guests.length} assistants`;
  return live.value === "edit" ? `${who} is connected and can edit.` : `${who} is connected, read only.`;
});

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
  <div class="sm-section">AI assistants (MCP)</div>
  <label class="prefs-row">
    <span class="prefs-label">Live document</span>
    <Select id="prefs-live" :model-value="live" :options="LIVE_OPTIONS" @update:model-value="onLive" />
  </label>
  <div class="sm-hint">
    An assistant works on the open document rather than on a copy. Each edit is
    one undo, and the title bar says who is connected.
  </div>
  <div class="prefs-row">
    <span class="prefs-label">Status</span>
    <span id="prefs-mcp-status" class="mcp-status" :class="{ on: state.sharing && state.guests.length > 0 }">
      {{ status }}
    </span>
  </div>

  <div class="sm-section">How to connect it</div>
  <div v-if="unavailable" id="prefs-mcp-unavailable" class="sm-hint">{{ unavailable }}</div>
  <template v-else-if="setup">
    <label class="prefs-row">
      <span class="prefs-label">Assistant</span>
      <Select id="prefs-mcp-host" :model-value="host" :options="hostOptions" @update:model-value="onHost" />
    </label>
    <div class="mcp-setup">
      <div class="sm-hint">{{ setup.hint }}</div>
      <pre id="prefs-mcp-config" class="mcp-config">{{ setup.text }}</pre>
      <button id="prefs-mcp-copy" type="button" class="btn" @click="copy(setup.text)">Copy</button>
    </div>
  </template>
  <div v-else class="sm-hint">Looking for the MCP server…</div>
</template>
