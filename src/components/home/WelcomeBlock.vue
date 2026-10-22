<script setup lang="ts">
import { MANUAL_URL, openExternal } from "../../ui/welcome";
</script>

<template>
  <section class="home-welcome" aria-labelledby="home-welcome-title">
    <h2 id="home-welcome-title" class="home-welcome-title">Welcome to FundaCAD</h2>
    <p class="home-welcome-text">
      Open an example to see how it is built, or start with Blank. Open… takes your own STEP, STL and 3MF files too.
    </p>
    <button type="button" class="btn home-welcome-manual" @click="void openExternal(MANUAL_URL)">
      Read the manual
    </button>
  </section>
</template>
