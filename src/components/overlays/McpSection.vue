<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from "vue";
import { ENGINE } from "../../app/engineKey";
import { t } from "../../i18n";
import type { LiveState } from "../../live/liveSession";
import { asMcpHost, MCP_HOSTS, mcpServerPath, mcpSetupFor, type McpHost } from "../../live/mcpConnect";
import { loadMcpSwitch, mcpEnabled, mcpSwitchShown, onMcpChange, setMcpEnabled } from "../../live/mcpSwitch";
import { asLiveEditingMode, liveEditingMode, onLiveEditingChange, setLiveEditingMode } from "../../ui/liveEditing";
import { toast } from "../../ui/toast";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import Select from "../ui/Select.vue";

// Injected rather than useEngine(): the section still has to render its
// settings where no engine was provided, and then simply has no status to show.
const engine = inject(ENGINE, null);

const live = ref(liveEditingMode());
const mcpOn = ref(mcpEnabled() !== false);
const saving = ref(false);
const state = ref<LiveState>(engine?.live.snapshot ?? { sharing: false, guests: [], lastEdit: null });
const host = ref<McpHost>("claude-code");
const server = ref("");
const unavailable = ref("");

const stops: (() => void)[] = [];
onMounted(async () => {
  stops.push(
    onLiveEditingChange(() => {
      live.value = liveEditingMode();
    }),
    onMcpChange(() => {
      mcpOn.value = mcpEnabled() !== false;
    }),
  );
  void loadMcpSwitch();
  if (engine)
    stops.push(
      engine.live.subscribe((s) => {
        state.value = s;
      }),
    );
  try {
    server.value = await mcpServerPath();
  } catch (err) {
    unavailable.value = err instanceof Error ? err.message : String(err);
  }
});
onUnmounted(() => {
  for (const stop of stops) stop();
});

const LIVE_OPTIONS = computed(() => [
  { value: "off", label: t("prefs.mcp.live.off") },
  { value: "read", label: t("prefs.mcp.live.read") },
  { value: "edit", label: t("prefs.mcp.live.edit") },
]);
const hostOptions = computed(() => MCP_HOSTS.map((h) => ({ value: h.id, label: h.label })));

function onLive(id: string) {
  const v = asLiveEditingMode(id);
  if (v) setLiveEditingMode(v);
}

async function onMcp(on: boolean) {
  saving.value = true;
  try {
    await setMcpEnabled(on);
  } catch (err) {
    toast(t("prefs.mcp.saveFailed", { reason: err instanceof Error ? err.message : String(err) }), { kind: "error" });
  } finally {
    saving.value = false;
  }
}

function onHost(id: string) {
  const v = asMcpHost(id);
  if (v) host.value = v;
}

const setup = computed(() => (server.value ? mcpSetupFor(host.value, server.value) : null));

const status = computed(() => {
  if (!mcpOn.value) return t("prefs.mcp.statusOff");
  if (live.value === "off") return t("prefs.mcp.statusNotShared");
  const guests = state.value.guests;
  if (!state.value.sharing || guests.length === 0) return t("prefs.mcp.statusNoGuest");
  const mode = live.value === "edit" ? "edit" : "read";
  return guests.length === 1
    ? t("prefs.mcp.statusOne", { name: guests[0]!, mode })
    : t("prefs.mcp.statusMany", { n: guests.length, mode });
});

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("prefs.mcp.copied"));
  } catch {
    toast(t("prefs.mcp.copyFailed"), { kind: "error" });
  }
}
</script>

<template>
  <div class="sm-section">{{ t("prefs.mcp.title") }}</div>
  <div v-if="mcpSwitchShown()" class="pref-card">
    <Checkbox
      id="prefs-mcp-on"
      aria-describedby="prefs-mcp-on-hint"
      class="pref-head pref-check"
      :model-value="mcpOn"
      :disabled="saving"
      @update:model-value="onMcp"
      ><span class="pref-title">{{ t("prefs.mcp.on") }}</span></Checkbox
    >
    <p id="prefs-mcp-on-hint" class="pref-hint">{{ t("prefs.mcp.onHint") }}</p>
  </div>
  <label class="prefs-row">
    <span class="prefs-label">{{ t("prefs.mcp.live") }}</span>
    <Select
      id="prefs-live"
      :label="t('prefs.mcp.live')"
      :model-value="live"
      :options="LIVE_OPTIONS"
      :disabled="!mcpOn"
      :disabled-reason="mcpOn ? undefined : t('prefs.mcp.offReason')"
      @update:model-value="onLive"
    />
  </label>
  <div class="sm-hint">{{ t("prefs.mcp.liveHint") }}</div>
  <div class="prefs-row">
    <span class="prefs-label">{{ t("prefs.mcp.status") }}</span>
    <span id="prefs-mcp-status" class="mcp-status" :class="{ on: state.sharing && state.guests.length > 0 }">
      {{ status }}
    </span>
  </div>

  <div class="sm-section">{{ t("prefs.mcp.how") }}</div>
  <div v-if="unavailable" id="prefs-mcp-unavailable" class="sm-hint">{{ unavailable }}</div>
  <template v-else-if="setup">
    <label class="prefs-row">
      <span class="prefs-label">{{ t("prefs.mcp.assistant") }}</span>
      <Select
        id="prefs-mcp-host"
        :label="t('prefs.mcp.assistant')"
        :model-value="host"
        :options="hostOptions"
        @update:model-value="onHost"
      />
    </label>
    <div class="mcp-setup">
      <div class="sm-hint">{{ setup.hint }}</div>
      <pre id="prefs-mcp-config" class="mcp-config">{{ setup.text }}</pre>
      <Button id="prefs-mcp-copy" @click="copy(setup.text)">{{ t("prefs.mcp.copy") }}</Button>
    </div>
    <div id="prefs-mcp-scope" class="sm-hint">{{ t("prefs.mcp.scope") }}</div>
  </template>
  <div v-else class="sm-hint">{{ t("prefs.mcp.looking") }}</div>
</template>
