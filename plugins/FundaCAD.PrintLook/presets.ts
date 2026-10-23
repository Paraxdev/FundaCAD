import type { MaterialDef } from "../../src/document/materials";

export const FILAMENT_GROUP = "Filament";

export const FILAMENT_PRESETS: readonly MaterialDef[] = Object.freeze([
  { id: "filament-pla-matte", name: "PLA, matte", color: "#e7e4dc", metalness: 0, roughness: 0.85, sheen: 0.35 },
  { id: "filament-pla-glossy", name: "PLA, glossy", color: "#2f6fd6", metalness: 0, roughness: 0.38 },
  {
    id: "filament-pla-silk",
    name: "PLA, silk",
    color: "#c9a94a",
    metalness: 0.45,
    roughness: 0.22,
    anisotropy: 0.6,
    specularColor: "#c9a94a",
  },
  {
    id: "filament-petg-translucent",
    name: "PETG, translucent",
    color: "#6fb7e0",
    metalness: 0,
    roughness: 0.28,
    opacity: 0.5,
    attenuationColor: "#3d8fc4",
    attenuationDistance: 6,
    scatterDistance: 1.5,
  },
  {
    id: "filament-pla-carbon",
    name: "PLA, carbon fibre fill",
    color: "#2b2c2e",
    metalness: 0,
    roughness: 0.78,
    sheen: 0.2,
  },
  {
    id: "filament-pla-wood",
    name: "PLA, wood fill",
    color: "#a77a4c",
    metalness: 0,
    roughness: 0.88,
    surfaceGraph: {
      nodes: [
        { id: "specks", type: "voronoi", params: { scale: 0.4 } },
        { id: "grain", type: "ramp", params: { colorA: "#a77a4c", colorB: "#6b4a2c" }, in: { t: "specks" } },
        {
          id: "out",
          type: "output",
          params: { roughAmount: 0.15, colorAmount: 0.6 },
          in: { color: "grain", roughness: "specks" },
        },
      ],
      output: "out",
    },
  },
  {
    id: "filament-pla-glow",
    name: "PLA, glow",
    color: "#d9f2b4",
    metalness: 0,
    roughness: 0.6,
    emissive: 0.35,
    castsLight: false,
  },
  { id: "filament-tpu", name: "TPU", color: "#1f2022", metalness: 0, roughness: 0.7, sheen: 0.4 },
]);
