// Viewport counters collected at report time for a bug report. Totals only, never traverse geometry:
// a report is filed when things are already going badly.

import type { ModelView } from "../viewport/render";

export interface SceneStatsSource {
  model: ModelView | null;
  canvas: HTMLCanvasElement;
  pixelRatio: number;
  frameMs: number | null;
  // A skipped seam pass leaves every seam visible, which looks like a bug unless the report says it was deliberate.
  seam?: { ms: number; skipped: boolean };
  // `renderer.info.render` of the last frame. `calls` matters: a many-body scene can be draw-call bound with few triangles.
  render?: { calls: number; triangles: number };
  // Empty until the first GPU timer results come back a few frames after drawing starts.
  passes?: { ms: Record<string, number>; kind: string };
  // Which backend drew the Path traced picture: it is otherwise indistinguishable by backend in a report.
  trace?: { state: string; backend: string; samples: number; denoised: boolean; fault: string | null; gpu: string };
}

const FAULT_CHARS = 160;

// One line per fact, short enough to survive the 300-char breadcrumb cap.
export function sceneStats(s: SceneStatsSource): string[] {
  const out: string[] = [];
  const gpu = (window as { __gpu?: string }).__gpu;
  if (gpu) out.push(`[gpu] ${gpu}`);

  const w = s.canvas.clientWidth,
    h = s.canvas.clientHeight;
  const mp = ((w * h * s.pixelRatio * s.pixelRatio) / 1e6).toFixed(1);
  out.push(`[view] ${w}x${h} css @ dpr ${s.pixelRatio} = ${mp}M fragments`);

  if (s.model) {
    let tris = 0,
      verts = 0,
      edges = 0;
    for (const b of s.model.bodies) {
      const g = b.mesh.geometry;
      const pos = g.getAttribute("position");
      verts += pos ? pos.count : 0;
      tris += (g.getIndex()?.count ?? pos?.count ?? 0) / 3;
      edges += b.edges.refs.length;
    }
    // verts/tri near 3 means no vertex sharing at all, as a faceted texture produces.
    const ratio = tris ? (verts / tris).toFixed(2) : "0";
    out.push(
      `[mesh] ${s.model.bodies.length} bodies · ${Math.round(tris)} tris · ${verts} verts ` +
        `(${ratio}/tri) · ${edges} edges`,
    );
  } else {
    out.push("[mesh] no model built");
  }

  out.push(
    s.frameMs != null
      ? `[frame] ${s.frameMs.toFixed(1)}ms (${Math.round(1000 / s.frameMs)} fps) at report time`
      : "[frame] viewport idle at report time",
  );
  if (s.render) out.push(`[draw] ${s.render.calls} calls · ${s.render.triangles} tris last frame`);
  if (s.passes) {
    const parts = Object.entries(s.passes.ms).map(([n, ms]) => `${n} ${ms.toFixed(2)}`);
    out.push(
      parts.length
        ? `[passes] ${parts.join(" · ")} ms (${s.passes.kind})`
        : `[passes] no GPU timings yet (${s.passes.kind})`,
    );
  }
  if (s.seam) {
    out.push(
      s.seam.skipped
        ? "[seams] flush-seam hiding SKIPPED (model too large), seams left visible"
        : `[seams] ${s.seam.ms.toFixed(1)}ms`,
    );
  }
  if (s.trace) {
    const t = s.trace;
    const fault = t.fault ? (t.fault.length > FAULT_CHARS ? `${t.fault.slice(0, FAULT_CHARS)}...` : t.fault) : "none";
    out.push(
      `[trace] ${t.state} on ${t.backend || "no tracer"} · ${t.samples} samples${t.denoised ? " · denoised" : ""} · last fault ${fault}`,
    );
    out.push(`[trace] ${t.gpu}`);
  }
  return out;
}
