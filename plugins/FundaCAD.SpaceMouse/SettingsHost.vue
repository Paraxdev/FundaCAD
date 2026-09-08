<script setup lang="ts">
// The one component this capability contributes to the app's overlay stack.
//
// It is a host and not the settings window itself, because a contributed
// overlay is mounted for as long as the capability is running while the window
// it wraps is open only sometimes — and that window builds a WebGL scene for
// the test cube in onMounted. Mounting IS opening for the dialog, which is the
// rule every modal in this app follows (see the note in App.vue); this is the
// v-if that makes it true here.
//
// Async, so the settings window, its three.js scene and the whole axis-binding
// grid stay out of the chunk that starts the capability. Somebody who owns a 3D
// mouse still only pays for this the first time they open the settings.

import { defineAsyncComponent } from "vue";
import { settingsOpen } from "./state";

const SpaceMouseModal = defineAsyncComponent(() => import("./SpaceMouseModal.vue"));
</script>

<template>
  <SpaceMouseModal v-if="settingsOpen" />
</template>
