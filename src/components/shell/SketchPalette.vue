<script setup lang="ts">
import { useSketchPaletteStore, PALETTE_TOGGLES } from "../../stores/sketchPalette";
import { useSketchRelationsStore } from "../../stores/sketchRelations";
import type { RelationRow } from "../../sketch/relations";

const palette = useSketchPaletteStore();
const rel = useSketchRelationsStore();

/** An implied relation has no record behind it, so there is nothing to delete
 *  and saying "click to delete" would be a lie. */
function rowTitle(r: RelationRow): string {
  if (r.implied) return "Held by position: these endpoints are the same point";
  if (r.state === "conflict") return "Conflicting: the sketch cannot satisfy this";
  if (r.state === "over") return "Redundant: something else already says this";
  return "Click to select what it acts on";
}
</script>

<template>
  <!-- `.hidden` rather than v-if, matching setVisible()'s classList.toggle: the
       panel keeps its DOM (and so its CSS transition) between sketches. -->
  <aside id="palette" class="palette" :class="{ hidden: !palette.visible }">
    <div class="palette-title">SKETCH PALETTE</div>
    <div class="palette-section">Options</div>
    <button
      class="palette-btn"
      title="Square the view to the sketch plane"
      @click="palette.lookAt()"
    >Look At</button>
    <label v-for="t in PALETTE_TOGGLES" :key="t.key" class="palette-row">
      <span>{{ t.label }}</span>
      <input
        type="checkbox"
        class="palette-switch"
        :checked="palette.state[t.key]"
        @change="palette.set(t.key, ($event.target as HTMLInputElement).checked)"
      />
    </label>

    <!-- RELATIONS. The canvas glyphs answer "what is holding this line"; the
         list answers "what is holding this sketch", which is a different
         question and the one people ask when a sketch will not move. It follows
         Show Constraints, because it is the same information. -->
    <template v-if="rel.visible">
      <div class="palette-section palette-section-gap">Relations</div>
      <div class="rel-summary" :class="{ conflict: rel.conflict }">{{ rel.summary }}</div>
      <p v-if="!rel.rows.length" class="rel-empty">
        Nothing is constrained yet. Draw with the grid on, or use the constraint
        tools, and what holds the sketch appears here.
      </p>
      <ul v-else class="rel-list" @pointerleave="rel.hover(null)">
        <li
          v-for="(r, i) in rel.rows"
          :key="i"
          class="rel-row"
          :class="{ conflict: r.state === 'conflict', over: r.state === 'over', implied: r.implied }"
          :title="rowTitle(r)"
          @pointerenter="rel.hover(i)"
          @click="rel.hooks?.select(r.entities)"
        >
          <span class="rel-sym">{{ r.symbol }}</span>
          <span class="rel-text">
            <!-- Two elements rather than one with a space between them: Vue
                 condenses whitespace in a template, so the space was being
                 dropped and the row read "Length6.32 mm". The gap is the flex
                 box's job, where nothing can remove it. -->
            <span class="rel-head">
              <span class="rel-name">{{ r.name }}</span>
              <span v-if="r.value" class="rel-value">{{ r.value }}</span>
            </span>
            <span class="rel-detail">{{ r.implied ? r.detail + ' · implied' : r.detail }}</span>
          </span>
          <button
            v-if="r.index !== null"
            class="rel-del"
            title="Delete this constraint"
            @click.stop="rel.hooks?.del(r.index)"
          >&#215;</button>
        </li>
      </ul>
    </template>
  </aside>
</template>
