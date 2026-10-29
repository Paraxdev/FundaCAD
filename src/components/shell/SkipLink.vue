<script setup lang="ts">
import { goToRegion } from "../../ui/regions";
</script>

<template>
  <!-- A link, so screen readers list it with the links; the click moves focus and leaves the URL alone. -->
  <a class="skip-link" href="#main" @click.prevent="goToRegion('viewport')">Skip to model</a>
</template>
