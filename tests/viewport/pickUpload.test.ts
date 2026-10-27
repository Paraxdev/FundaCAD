// Leaving an edge pick with an edge hovered left every edge in the pickable ember on screen: the whole buffer rewrite
// back to idle was followed, before the frame, by the hovered edge's repaint, whose sub-range made three upload only
// that edge. The renderer's upload is modelled here, so the tests read what the GPU holds.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Highlighter } from "../../src/viewport/highlight";
import { costRig } from "./pickCostRig";

type Uploadable = THREE.BufferAttribute | THREE.InterleavedBuffer;

/** What three's WebGLAttributes.updateBuffer does: the whole array with no ranges, else only the ranges. */
function gpuOf(attr: Uploadable) {
  const held = Float32Array.from(attr.array as Float32Array);
  const upload = () => {
    const src = attr.array as Float32Array;
    if (attr.updateRanges.length === 0) held.set(src);
    else for (const r of attr.updateRanges) held.set(src.subarray(r.start, r.start + r.count), r.start);
    attr.clearUpdateRanges();
    attr.onUploadCallback();
  };
  upload();
  return { held, upload };
}

const EMBER = new THREE.Color(0xd98a4a);
const IDLE = new THREE.Color(0x1b1f24);

function edgeRig() {
  const rig = costRig(4, 2);
  const data = (rig.draw.object.geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data;
  return { ...rig, data, gpu: gpuOf(data) };
}

describe("a whole buffer repaint is not cut down to a later sub-range", () => {
  it("leaving an edge pick with an edge hovered puts every edge back to idle on the GPU", () => {
    const { view, draw, data, gpu } = edgeRig();
    const hl = new Highlighter(view);
    hl.setEdgeBase(EMBER);
    gpu.upload();
    hl.hoverEdge(draw.refs[1]!);
    gpu.upload();
    // emphasizeEdges(false), then the pick's cleanup clears the hover, in one task
    hl.setEdgeBase(IDLE);
    hl.clearHover();
    gpu.upload();
    expect(Array.from(gpu.held)).toEqual(Array.from(data.array));
  });

  it("an emphasis switched on beside a selected edge reaches every edge", () => {
    const { view, draw, data, gpu } = edgeRig();
    const hl = new Highlighter(view);
    hl.setEdgeBase(EMBER);
    hl.toggleSelectEdge(draw.refs[0]!);
    gpu.upload();
    expect(Array.from(gpu.held)).toEqual(Array.from(data.array));
  });

  it("a lone repaint after the upload still sends only its own span", () => {
    const { draw, data, gpu } = edgeRig();
    draw.setColorAll(EMBER);
    gpu.upload();
    draw.setColor(2, IDLE);
    expect(data.updateRanges).toEqual([{ start: 12, count: 6 }]);
  });

  it("a face selected in the task that rewrote the base colours keeps the rest of the rewrite", () => {
    const { view, mesh } = costRig(4, 2);
    const colors = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const gpu = gpuOf(colors);
    const hl = new Highlighter(view);
    hl.setBase(() => new THREE.Color(0x336699));
    hl.toggleSelectFace(2);
    gpu.upload();
    expect(Array.from(gpu.held)).toEqual(Array.from(colors.array));
  });
});
