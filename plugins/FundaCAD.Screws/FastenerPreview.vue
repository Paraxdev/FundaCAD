<script setup lang="ts">
// A small viewer of one generated fastener: the mesh comes from the geometry engine, so what is
// shown is the solid that Insert would put in the model. Drag to turn it, wheel to zoom.

import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import { useEngine } from "fundacad";
import type { FastenerSpec } from "./spec";
import { GENERATOR } from "./state";

const props = defineProps<{ spec: FastenerSpec | null; width?: number; height?: number }>();
const emit = defineEmits<{ measured: [volume: number | null]; problem: [message: string | null] }>();

const engine = useEngine();
const canvas = ref<HTMLCanvasElement | null>(null);
const status = ref("");

let renderer: THREE.WebGLRenderer | null = null;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10000);
camera.up.set(0, 0, 1);
const pivot = new THREE.Group();
scene.add(pivot);
scene.add(new THREE.HemisphereLight(0xffffff, 0x303038, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, -4, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(0xbfd8ff, 0.8);
rim.position.set(-5, 4, -2);
scene.add(rim);
const material = new THREE.MeshStandardMaterial({ color: 0xb9bec7, metalness: 0.55, roughness: 0.38 });

let mesh: THREE.Mesh | null = null;
let distance = 50;
let request = 0;
let timer = 0;

function render() {
  if (!renderer) return;
  camera.position.set(0, -distance * 0.82, distance * 0.57);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}

function clearMesh() {
  if (!mesh) return;
  pivot.remove(mesh);
  mesh.geometry.dispose();
  mesh = null;
}

async function load(spec: FastenerSpec | null) {
  const mine = ++request;
  if (!spec) {
    clearMesh();
    status.value = "";
    emit("measured", null);
    render();
    return;
  }
  const generate = engine.geometry.generateShape?.bind(engine.geometry);
  if (!generate) {
    status.value = "The preview needs the geometry engine";
    return;
  }
  status.value = spec.thread?.modelled ? "Cutting the thread..." : "Loading...";
  const reply = await generate(GENERATOR, spec, { output: "mesh" });
  if (mine !== request) return;
  if (!reply.ok || !reply.shape.mesh) {
    clearMesh();
    const message = reply.ok ? "no preview came back" : reply.message;
    status.value = message;
    emit("measured", null);
    emit("problem", message);
    render();
    return;
  }
  emit("problem", null);
  const { positions, indices, normals } = reply.shape.mesh;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length === positions.length) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  if (normals.length !== positions.length) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const centre = box.getCenter(new THREE.Vector3());
  geometry.translate(-centre.x, -centre.y, -centre.z);
  clearMesh();
  mesh = new THREE.Mesh(geometry, material);
  pivot.add(mesh);
  const size = box.getSize(new THREE.Vector3()).length();
  distance = size * 2.1;
  camera.near = size / 100;
  camera.far = size * 100;
  camera.updateProjectionMatrix();
  status.value = "";
  emit("measured", reply.shape.volume);
  render();
}

watch(
  () => JSON.stringify(props.spec),
  () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void load(props.spec), 150);
  },
);

let drag: { x: number; y: number } | null = null;

function onDown(ev: PointerEvent) {
  drag = { x: ev.clientX, y: ev.clientY };
  (ev.target as Element).setPointerCapture?.(ev.pointerId);
}

function onMove(ev: PointerEvent) {
  if (!drag) return;
  pivot.rotation.z += (ev.clientX - drag.x) * 0.01;
  pivot.rotation.x = Math.max(-1.4, Math.min(1.4, pivot.rotation.x + (ev.clientY - drag.y) * 0.01));
  drag = { x: ev.clientX, y: ev.clientY };
  render();
}

function onUp() {
  drag = null;
}

function onWheel(ev: WheelEvent) {
  ev.preventDefault();
  distance *= ev.deltaY > 0 ? 1.1 : 1 / 1.1;
  render();
}

onMounted(() => {
  if (!canvas.value) return;
  const w = props.width ?? 300;
  const h = props.height ?? 220;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true, alpha: true });
  } catch {
    status.value = "No WebGL for the preview";
    return;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pivot.rotation.set(0.35, 0, 0.6);
  void load(props.spec);
});

onBeforeUnmount(() => {
  window.clearTimeout(timer);
  request++;
  clearMesh();
  material.dispose();
  renderer?.dispose();
  renderer = null;
});
</script>

<template>
  <div :style="{ position: 'relative', width: `${width ?? 300}px`, height: `${height ?? 220}px` }">
    <canvas
      ref="canvas"
      class="scr-preview"
      :style="{ width: '100%', height: '100%', display: 'block', cursor: 'grab', borderRadius: 'var(--r-md, 4px)', background: 'var(--viewport-bg, #0b0912)' }"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @wheel="onWheel"
    />
    <div
      v-if="status"
      class="scr-preview-status"
      :style="{ position: 'absolute', left: '8px', right: '8px', bottom: '6px', fontSize: '11px', color: 'var(--text-dim, #aaa1b5)' }"
    >
      {{ status }}
    </div>
  </div>
</template>
