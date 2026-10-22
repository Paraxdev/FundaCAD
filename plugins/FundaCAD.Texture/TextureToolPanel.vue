<script setup lang="ts">
// Docked top right, since the tool can span a whole body and has no point to anchor to. Escape is not handled here:
// TextureTool owns it from the rollback before this panel opens until after a refused commit.

import { computed, reactive, watch, type CSSProperties } from "vue";
import {
  TEXTURE_KIND_GROUPS,
  basename,
  initialTextureForm,
  sharpnessLabel,
  textureFormErrors,
  textureRows,
  toTextureValues,
  type TextureMode,
} from "./textureForm";
import { Icon } from "fundacad/ui";
import { fieldNumber, openDialog } from "fundacad";
import * as panel from "./panel";

// Reseeded whenever the tool opens a new request: a permanently mounted overlay has no key to remount it, so a reopen
// would show the last run's values.
const form = reactive(initialTextureForm(panel.request.value?.initial ?? {}));
const errors = computed(() => Object.entries(textureFormErrors(form)));
watch(
  () => panel.request.value?.id,
  () => {
    const init = initialTextureForm(panel.request.value?.initial ?? {});
    Object.assign(form, init);
  },
);
const rows = computed(() => textureRows(form));
// Read through the request so they follow a reopen. An empty palette is how a document with no palette looks, and the
// row hides itself.
const palette = computed(() => panel.request.value?.palette ?? []);
const editing = computed(() => panel.request.value?.editing ?? false);
const sharpLabel = computed(() => sharpnessLabel(form.profile));
const grimePct = computed(() => `${Math.round((fieldNumber(form.grime) || 0) * 100)}%`);
const smoothPct = computed(() => `${Math.round((fieldNumber(form.smooth) || 0) * 100)}%`);
const seamBlendPct = computed(() => `${Math.round((fieldNumber(form.seamBlend) || 0) * 100)}%`);
const seamBandPct = computed(() => `${Math.round((fieldNumber(form.seamBand) || 0) * 100)}%`);
const amplitudePct = computed(() => `${Math.round((fieldNumber(form.amplitude) || 0) * 100)}%`);

function emitChange() {
  panel.request.value?.onChange(toTextureValues(form));
}

function chooseMode(m: TextureMode) {
  panel.mode.value = m;
  panel.request.value?.onModeChange(m);
}

function randomize() {
  form.seed = String(Math.floor(Math.random() * 1_000_000));
  emitChange();
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

async function browse() {
  if (!isTauri()) {
    console.warn("a heightmap needs the native app (a real filesystem path)");
    return;
  }
  // The host's dialog: importing @tauri-apps/plugin-dialog would bundle a second copy into the plugin. files.read runs
  // only after the person pressed Browse and chose something.
  const path = await openDialog({
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp"] }],
  });
  if (path === null) return;
  form.imagePath = path;
  emitChange();
}

// Host tokens with the old hex as the `var(--token, #fallback)` floor (src/styles/_tokens.scss), so the panel follows
// the theme. Inline with no :hover, and font and color-scheme are inherited so native controls follow the theme too.
const root: CSSProperties = {
  position: "fixed",
  top: "60px",
  right: "16px",
  zIndex: "50",
  padding: "8px",
  background: "var(--panel, #20242c)",
  border: "1px solid var(--line-strong, #3a4150)",
  borderRadius: "var(--r-md, 6px)",
  boxShadow: "var(--shadow-2, 0 6px 20px rgba(0,0,0,0.4))",
  font: "12px system-ui, sans-serif",
  color: "var(--text, #dce3ee)",
  width: "270px",
  maxWidth: "calc(100vw, 24px)",
  boxSizing: "border-box",
  maxHeight: "calc(100vh, 80px)",
  overflowY: "auto",
};
const row: CSSProperties = { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" };
const field: CSSProperties = {
  background: "var(--panel-2, #161a20)",
  color: "var(--text, #dce3ee)",
  border: "1px solid var(--line-strong, #3a4150)",
  borderRadius: "var(--r-sm, 3px)",
  padding: "3px 5px",
  font: "inherit",
};
const lbl: CSSProperties = { whiteSpace: "nowrap", cursor: "pointer" };
const grow: CSSProperties = { ...field, flex: "1" };
const num: CSSProperties = { ...field, width: "64px" };
const title: CSSProperties = { fontWeight: "600", marginBottom: "6px" };
const muted: CSSProperties = { color: "var(--text-mute, #8b93a3)", marginBottom: "6px" };
const modeBtn: CSSProperties = {
  flex: "1",
  border: "1px solid var(--line-strong, #3a4150)",
  borderRadius: "var(--r-sm, 3px)",
  padding: "4px 6px",
  cursor: "pointer",
  font: "inherit",
};
const modeOn: CSSProperties = {
  background: "var(--accent, #2b6)",
  borderColor: "var(--accent, #2b6)",
  color: "var(--on-accent, #fff)",
};
const modeOff: CSSProperties = {
  background: "transparent",
  borderColor: "var(--line-strong, #3a4150)",
  color: "var(--text, #dce3ee)",
};
const smallBtn: CSSProperties = {
  border: "1px solid var(--line-strong, #3a4150)",
  borderRadius: "var(--r-sm, 3px)",
  padding: "3px 8px",
  cursor: "pointer",
  font: "inherit",
  background: "transparent",
  color: "var(--text-dim, #dce3ee)",
};
const pathLabel: CSSProperties = {
  flex: "1",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--text-mute, #8b93a3)",
};
const summaryStyle: CSSProperties = { cursor: "pointer", marginBottom: "4px" };
const offsetRow: CSSProperties = { display: "flex", gap: "6px", alignItems: "center" };
const problem: CSSProperties = { color: "var(--error, #f0564a)", fontSize: "11px", marginBottom: "4px" };
const note: CSSProperties = { color: "var(--text-mute, #8b93a3)", fontStyle: "italic", margin: "8px 0" };
const btnRow: CSSProperties = { ...row, marginBottom: "0", justifyContent: "flex-end" };
const btn: CSSProperties = {
  border: "none",
  borderRadius: "var(--r-sm, 4px)",
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
};
const okBtn: CSSProperties = { ...btn, background: "var(--accent, #2b6)", color: "var(--on-accent, #fff)" };
const noBtn: CSSProperties = { ...btn, background: "var(--raised, #555)", color: "var(--text, #fff)" };
</script>

<template>
  <!-- Mounted for the plugin's whole life, drawn only while the tool runs. -->
  <Teleport v-if="panel.request.value" to="body">
    <!-- `data-panel` is the one hook an e2e script holds, everything is inline styled with no class names. -->
    <div data-panel="texture" :style="root">
      <div :style="title">Texture</div>
      <!-- Its own ref, not the request, so the per-tick rewrite cannot re-render the form and steal focus. -->
      <div :style="muted">{{ panel.summary.value }}</div>

      <div :style="row">
        <button :style="[modeBtn, panel.mode.value === 'faces' ? modeOn : modeOff]" @click="chooseMode('faces')"
          >Faces</button
        >
        <button :style="[modeBtn, panel.mode.value === 'body' ? modeOn : modeOff]" @click="chooseMode('body')"
          >Whole Body</button
        >
      </div>

      <div :style="row">
        <label :style="lbl">Kind</label>
        <select v-model="form.kind" :style="grow" @change="emitChange">
          <optgroup v-for="g in TEXTURE_KIND_GROUPS" :key="g.label" :label="g.label">
            <option v-for="k in g.kinds" :key="k.value" :value="k.value">{{ k.label }}</option>
          </optgroup>
        </select>
      </div>

      <!-- Hard surface is the default, planar facets and creases are what a printer reproduces. -->
      <div :style="row">
        <label :style="lbl">Profile</label>
        <select v-model="form.profile" :style="grow" @input="emitChange" @change="emitChange">
          <option value="facet">Faceted (hard surface)</option>
          <option value="round">Smooth</option>
        </select>
      </div>

      <div :style="row">
        <label :style="lbl">Depth</label>
        <input
          v-model="form.depth"
          type="text"
          inputmode="decimal"
          :style="num"
          @input="emitChange"
          @change="emitChange"
        />
        <label :style="lbl">Scale</label>
        <input
          v-model="form.scale"
          type="text"
          inputmode="decimal"
          :style="num"
          @input="emitChange"
          @change="emitChange"
        />
      </div>

      <div v-show="rows.angle" :style="row">
        <label :style="lbl">Angle°</label>
        <input
          v-model="form.angle"
          type="text"
          inputmode="decimal"
          :style="num"
          @input="emitChange"
          @change="emitChange"
        />
        <label v-show="rows.sharpness" :style="lbl" :title="sharpLabel.title">{{ sharpLabel.text }}</label>
        <input
          v-show="rows.sharpness"
          v-model="form.sharpness"
          type="text"
          inputmode="decimal"
          :style="num"
          @input="emitChange"
          @change="emitChange"
        />
      </div>

      <!-- Every kind honours direction, the engine applies it to the height field (out = h, in = h-1, both = centred). -->
      <div :style="row">
        <label :style="lbl">Direction</label>
        <select v-model="form.direction" :style="grow" @input="emitChange" @change="emitChange">
          <option value="out">Out (emboss)</option>
          <option value="in">In (deboss)</option>
          <option value="both">Both</option>
        </select>
      </div>

      <!-- Triplanar keeps the cells one size on a freeform face, exact charts ignore it. Hidden for a heightmap. -->
      <div
        v-show="rows.projection"
        :style="row"
        title="How a curved (freeform) face lays out the pattern. Triplanar keeps one size across the curve; Box favours the nearest axis; Planar projects along one direction and foreshortens. Flat, cylindrical and conical faces use their exact chart regardless."
      >
        <label :style="lbl">Projection</label>
        <select v-model="form.projection" :style="grow" @input="emitChange" @change="emitChange">
          <option value="triplanar">Triplanar</option>
          <option value="box">Box</option>
          <option value="auto">Planar</option>
        </select>
      </div>

      <!-- How softly the three world planes meet, only the control the active mode reads is shown. -->
      <div
        v-show="rows.seamBlend"
        :style="row"
        title="How softly the three world planes blend on a triplanar projection. Higher is a broader, gentler blend."
      >
        <label :style="lbl">Seam blend</label>
        <input
          v-model="form.seamBlend"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :style="{ flex: '1', minWidth: '0' }"
          @input="emitChange"
        />
        <span :style="[pathLabel, { flex: '0 0 auto', textAlign: 'right', minWidth: '2.6em' }]">{{
          seamBlendPct
        }}</span>
      </div>
      <div
        v-show="rows.seamBand"
        :style="row"
        title="How wide the transition band is where two box-projection axes meet. Higher is a wider, softer band."
      >
        <label :style="lbl">Seam band</label>
        <input
          v-model="form.seamBand"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :style="{ flex: '1', minWidth: '0' }"
          @input="emitChange"
        />
        <span :style="[pathLabel, { flex: '0 0 auto', textAlign: 'right', minWidth: '2.6em' }]">{{ seamBandPct }}</span>
      </div>

      <!-- Grime bleeds noise onto the neighbouring faces, so the wear seems to creep off the edge. -->
      <div
        :style="row"
        title="Bleeds a fading noise onto the faces next to the textured ones, like dirt or wear that crept off the edge. 0 = a clean boundary."
      >
        <label :style="lbl">Grime</label>
        <input
          v-model="form.grime"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :style="{ flex: '1', minWidth: '0' }"
          @input="emitChange"
        />
        <span :style="[pathLabel, { flex: '0 0 auto', textAlign: 'right', minWidth: '2.6em' }]">{{ grimePct }}</span>
      </div>

      <!-- Named apart from the "Smooth" profile, which is the continuous field rather than this blur. -->
      <div
        :style="row"
        title="Blurs the height field before it displaces: 0 = crisp relief, higher = softer and more rounded."
      >
        <label :style="lbl">Soften</label>
        <input
          v-model="form.smooth"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :style="{ flex: '1', minWidth: '0' }"
          @input="emitChange"
        />
        <span :style="[pathLabel, { flex: '0 0 auto', textAlign: 'right', minWidth: '2.6em' }]">{{ smoothPct }}</span>
      </div>

      <div :style="row" title="Master trim on the depth: 100% is the full depth, lower scales the whole relief down.">
        <label :style="lbl">Amplitude</label>
        <input
          v-model="form.amplitude"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :style="{ flex: '1', minWidth: '0' }"
          @input="emitChange"
        />
        <span :style="[pathLabel, { flex: '0 0 auto', textAlign: 'right', minWidth: '2.6em' }]">{{
          amplitudePct
        }}</span>
      </div>

      <div v-show="rows.seed" :style="row">
        <label :style="lbl">Seed</label>
        <input
          v-model="form.seed"
          type="text"
          inputmode="decimal"
          :style="num"
          @input="emitChange"
          @change="emitChange"
        />
        <button :style="smallBtn" @click="randomize"><Icon name="dice" :size="13" /> Randomize</button>
      </div>

      <div v-show="rows.image" :style="row">
        <button :style="smallBtn" @click="browse">Browse…</button>
        <span :style="pathLabel">{{ form.imagePath ? basename(form.imagePath) : "No file chosen" }}</span>
      </div>
      <div v-show="rows.image" :style="row">
        <label :style="lbl">Invert</label>
        <input v-model="form.invert" type="checkbox" @input="emitChange" @change="emitChange" />
      </div>

      <!-- Shown only when the caller passed a palette, i.e. in a document with bodies. -->
      <div v-show="palette.length" :style="row">
        <label :style="lbl">Print color</label>
        <select v-model="form.colorSlot" :style="grow" @input="emitChange" @change="emitChange">
          <option value="">Body color</option>
          <option v-for="(s, i) in palette" :key="i" :value="String(i)">{{ s.name }} (slot {{ i + 1 }})</option>
        </select>
      </div>

      <details>
        <summary :style="summaryStyle">Advanced</summary>
        <div
          :style="offsetRow"
          title="Edge blend: mm the pattern fades over at a face boundary. 0 = a clean machined cut-off."
        >
          <label :style="lbl">Offset</label>
          <input
            v-model="form.offset"
            type="text"
            inputmode="decimal"
            :style="num"
            @input="emitChange"
            @change="emitChange"
          />
          <label :style="lbl">Edge blend</label>
          <input
            v-model="form.edgeBlend"
            type="text"
            inputmode="decimal"
            :style="num"
            @input="emitChange"
            @change="emitChange"
          />
        </div>
        <!-- Keeps the texture only where the normal's angle from +Z is in the band, 0 to 180 masks nothing. -->
        <div
          :style="[offsetRow, { marginTop: '6px' }]"
          title="Keep the texture only where the surface's angle from up (0 = a flat top, 90 = a vertical wall, 180 = a flat underside) is in this band. 0 to 180 masks nothing."
        >
          <label :style="lbl">Slope°</label>
          <input
            v-model="form.slopeMin"
            type="text"
            inputmode="decimal"
            :style="num"
            @input="emitChange"
            @change="emitChange"
          />
          <label :style="lbl">to</label>
          <input
            v-model="form.slopeMax"
            type="text"
            inputmode="decimal"
            :style="num"
            @input="emitChange"
            @change="emitChange"
          />
        </div>
        <!-- Edge 0 is automatic from the scale and budget 0 is off, a coarser edge or tighter budget keeps the mesh light. -->
        <div
          :style="[offsetRow, { marginTop: '6px' }]"
          title="Mesh detail: target edge length in mm for the sampling mesh (0 = automatic). Max triangles: a hard per-face budget (0 = off). Lower detail or a tighter budget keeps a heavy texture light."
        >
          <label :style="lbl">Mesh mm</label>
          <input
            v-model="form.targetEdge"
            type="text"
            inputmode="decimal"
            :style="num"
            @input="emitChange"
            @change="emitChange"
          />
          <label :style="lbl">Max tris</label>
          <input
            v-model="form.triBudget"
            type="text"
            inputmode="decimal"
            :style="num"
            @input="emitChange"
            @change="emitChange"
          />
        </div>
      </details>

      <div :style="note">Preview is real geometry at display resolution, exports keep full detail.</div>

      <div v-for="[k, msg] in errors" :key="k" :style="problem" data-testid="texture-field-error"
        >{{ k }}: {{ msg }}</div
      >

      <div :style="btnRow">
        <button :style="okBtn" @pointerdown.prevent.stop="panel.commit(toTextureValues(form))">
          <Icon name="check" :size="13" /> {{ editing ? "Apply" : "Add" }}
        </button>
        <button :style="noBtn" @pointerdown.prevent.stop="panel.cancel()"
          ><Icon name="close" :size="13" /> Cancel</button
        >
      </div>
    </div>
  </Teleport>
</template>
