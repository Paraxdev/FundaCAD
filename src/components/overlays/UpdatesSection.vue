<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import Button from "../ui/Button.vue";
import Checkbox from "../ui/Checkbox.vue";
import Select from "../ui/Select.vue";
import { PRODUCT_NAME, productName, sourceforgeUrl } from "../../app/channel";
import { choose } from "../../ui/choice";
import { toast } from "../../ui/toast";
import { updatesSupported } from "../../ui/updates";
import {
  besideTitle,
  buildChannel,
  channelAction,
  channelOptions,
  onUpdateChannelChange,
  releasePageUrl,
  setUpdateChannel,
  stableReleaseSeen,
  syncBuildChannel,
  UPDATE_CHANNELS,
  updateChannel,
  type UpdateChannel,
} from "../../ui/updateChannel";
import { openExternal } from "../../ui/welcome";
import {
  asUpdatePeriod,
  autoUpdateCheck,
  onUpdatePrefsChange,
  setAutoUpdateCheck,
  setUpdatePeriod,
  UPDATE_PERIODS,
  updatePeriod,
} from "../../ui/updatePrefs";

const auto = ref(autoUpdateCheck());
const period = ref(updatePeriod());
// Null until the install is known, so no control flashes in for an install that cannot update itself.
const supported = ref<boolean | null>(null);
const options = UPDATE_PERIODS.map((p) => ({ value: p.id, label: p.label }));
const build = ref(buildChannel());
const channel = ref(updateChannel());
const seen = ref(stableReleaseSeen());
const channelOpts = computed(() => channelOptions(build.value, seen.value));
const channelLabel = (ch: UpdateChannel) => UPDATE_CHANNELS.find((c) => c.id === ch)!.label;

let stop = () => {};
let stopChannel = () => {};
onMounted(() => {
  stop = onUpdatePrefsChange(() => {
    auto.value = autoUpdateCheck();
    period.value = updatePeriod();
  });
  stopChannel = onUpdateChannelChange(() => {
    build.value = buildChannel();
    channel.value = updateChannel();
    seen.value = stableReleaseSeen();
  });
  void syncBuildChannel();
  void updatesSupported().then((ok) => (supported.value = ok));
});
onUnmounted(() => {
  stop();
  stopChannel();
});

function onPeriod(v: string) {
  const p = asUpdatePeriod(v);
  if (p) setUpdatePeriod(p);
}

function openLink(url: string) {
  openExternal(url).catch(() => toast(`Open ${url} in a browser.`, { timeout: 30000 }));
}

async function onChannel(picked: UpdateChannel) {
  if (channelAction(build.value, picked) === "switch") {
    setUpdateChannel(picked);
    return;
  }
  const answer = await choose(
    besideTitle(picked),
    [
      { value: "open", label: "Open release page" },
      { value: "cancel", label: "Cancel" },
    ],
    undefined,
    `${productName(picked)} is a separate app. It installs next to ${PRODUCT_NAME}, which keeps updating from ${channelLabel(channel.value)}.`,
  );
  if (answer === "open") openLink(releasePageUrl(picked));
}
</script>

<template>
  <h3 class="prefs-pane-title" tabindex="-1">Updates</h3>
  <div class="prefs-grid">
    <div v-if="supported === false" class="pref-card wide" data-updates-unsupported>
      <p class="pref-hint">
        This install updates through its package manager, the GitHub releases page or the SourceForge mirror.
      </p>
    </div>
    <div v-if="supported === false" class="pref-card" data-updates-channel-info>
      <div class="pref-head">
        <span class="pref-title">Channel</span> <span class="pref-hint">{{ channelLabel(build) }}</span>
      </div>
    </div>
    <template v-else-if="supported">
      <div class="pref-card">
        <Checkbox
          id="prefs-update-auto"
          class="pref-head pref-check"
          :model-value="auto"
          @update:model-value="setAutoUpdateCheck"
          ><span class="pref-title">Check for updates automatically</span></Checkbox
        >
        <p class="pref-hint">Off sends nothing until you use Help > Check for Updates.</p>
      </div>
      <div class="pref-card">
        <div class="pref-head">
          <label class="pref-title" for="prefs-update-period">Check</label>
          <Select
            id="prefs-update-period"
            label="Check"
            :model-value="period"
            :options="options"
            :disabled="!auto"
            @update:model-value="onPeriod"
          />
        </div>
      </div>
      <div class="pref-card">
        <div class="pref-head">
          <label class="pref-title" for="prefs-update-channel">Channel</label>
          <Select
            id="prefs-update-channel"
            label="Channel"
            aria-describedby="prefs-update-channel-hint"
            :model-value="channel"
            :options="channelOpts"
            @update:model-value="onChannel"
          />
        </div>
        <p id="prefs-update-channel-hint" class="pref-hint">
          The next check looks in this channel. Its files are also on the SourceForge mirror.
        </p>
        <div>
          <Button variant="ghost" size="sm" data-updates-mirror @click="openLink(sourceforgeUrl(channel))"
            >SourceForge mirror</Button
          >
        </div>
      </div>
    </template>
  </div>
</template>
