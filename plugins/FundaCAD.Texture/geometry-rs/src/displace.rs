//! texture.py `_displacement_geometry` and `displace_face`: one face's
//! triangulation refined in the pattern's frame, then pushed along its normals
//! by the height field, with analytic displaced normals for shading.

use crate::chart::{self, Surf};
use crate::height::{self, triplanar_field};
use crate::lattice::{self, Axes, LatticeArgs, Refined, Tri, P2};
use crate::np;
use crate::spec::Spec;
use crate::v3::{self, V};
use crate::{Mesh, Shape};

const DEFAULT_DENSITY_CAP: usize = 2_000_000;

struct Geometry {
    pts: Vec<V>,
    tris: Vec<Tri>,
    mean_edge: f64,
    u_mm: Vec<f64>,
    v_mm: Vec<f64>,
    lattice: bool,
    freeform: bool,
    taper: Vec<f64>,
    normals: Vec<V>,
    t_u: Vec<V>,
    t_v: Vec<V>,
}

fn displacement_geometry(
    face: &Shape,
    spec: &Spec,
    scale: f64,
    target_edge_mm: f64,
    cap: usize,
    flip: bool,
    plain_grid: bool,
) -> Result<Geometry, String> {
    let t = face.triangulation().ok_or("the face has no triangulation")?;
    let base_pts: Vec<V> = t.positions.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    let base_uv: Vec<P2> = t.uvs.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
    let base_tris: Vec<Tri> = t
        .indices
        .chunks_exact(3)
        .map(|c| {
            let (a, b, cc) = (c[0] as usize, c[1] as usize, c[2] as usize);
            if flip {
                [a, cc, b]
            } else {
                [a, b, cc]
            }
        })
        .collect();
    if base_tris.is_empty() {
        return Err("the face has no triangles".into());
    }
    let surf = Surf::new(face).ok_or("the face has no surface")?;
    let kind = spec.kind.as_str();
    let u_period = height::u_period(spec, scale);
    let mut refined: Option<Refined> = None;
    let mut lattice_used = false;
    if surf.kind().is_some() {
        let (bu_mm, bv_mm) = chart::uv_to_mm(&surf, &base_uv, u_period);
        let axes = lattice::pattern_axes(kind, spec);
        let tex_offset = spec.offset;
        let wrap_u = surf.full_turn().then(|| chart::turn_mm(&surf, u_period));
        let mut phases: Option<(Option<Vec<f64>>, Option<Vec<f64>>)> = None;
        let mut cell_points: Option<Vec<P2>> = None;
        match axes {
            Axes::Lines(a, b) => phases = Some((a, b)),
            Axes::Cells => {
                let pad = scale.max(target_edge_mm);
                let (ulo, uhi) = np::min_max(bu_mm.iter().copied());
                let (vlo, vhi) = np::min_max(bv_mm.iter().copied());
                cell_points = lattice::cell_lattice_points(
                    kind,
                    spec,
                    scale,
                    ulo + tex_offset - pad,
                    uhi + tex_offset + pad,
                    vlo - pad,
                    vhi + pad,
                    wrap_u,
                )
                .map(|pts| pts.into_iter().map(|p| [p[0] - tex_offset, p[1]]).collect());
            }
            Axes::None => {}
        }
        let field = |pts: &[P2]| -> Result<Vec<f64>, String> {
            let u: Vec<f64> = pts.iter().map(|p| p[0] + tex_offset).collect();
            let v: Vec<f64> = pts.iter().map(|p| p[1]).collect();
            height::height_field(kind, spec, &u, &v, None, None)
        };
        let lattice_first = !plain_grid && (phases.is_some() || cell_points.is_some());
        let mut attempts = Vec::new();
        if lattice_first {
            attempts.push((phases.take(), cell_points.take(), true));
        }
        attempts.push((None, None, false));
        for (want_phases, want_cells, is_lattice) in attempts {
            let args = LatticeArgs {
                base_pts: &base_pts,
                base_uv: &base_uv,
                base_tris: &base_tris,
                u_mm: &bu_mm,
                v_mm: &bv_mm,
                angle_deg: spec.angle,
                target_edge_mm,
                max_tris: cap,
                pattern_period: scale,
                phases: want_phases,
                offset: tex_offset,
                field: if is_lattice { Some(&field) } else { None },
                surf: &surf,
                u_period,
                cell_points: want_cells,
                wrap_u,
            };
            if let Ok(r) = lattice::aligned_grid_triangulation(&args) {
                refined = Some(r);
                lattice_used = is_lattice;
                break;
            }
        }
    }
    let freeform = surf.kind().is_none();
    let r = match refined {
        Some(r) => r,
        None => {
            lattice_used = false;
            let edge = if freeform { target_edge_mm * 0.5 } else { target_edge_mm };
            lattice::refine_face_triangulation(&surf, &base_pts, &base_uv, &base_tris, edge, cap)
        }
    };
    let lens: Vec<f64> = r.tris.iter().map(|t| v3::norm(v3::sub(r.pts[t[0]], r.pts[t[1]]))).collect();
    let mean_edge = np::median(&lens);
    let (mut u_mm, mut v_mm) = chart::uv_to_mm(&surf, &r.uv, u_period);
    let inset_mm = spec.boundary_inset.max(0.0);
    let seam: Option<Vec<bool>> = surf.full_turn().then(|| {
        let turn = chart::turn_mm(&surf, u_period);
        u_mm.iter().map(|&u| u.abs() < 1e-6 || (u - turn).abs() < 1e-6).collect()
    });
    let (taper, _edges) = lattice::boundary_taper(&r.pts, &r.tris, inset_mm, seam.as_deref());
    let (normals, mut t_u, mut t_v) = chart::face_frame(&surf, &r.uv, flip);
    if freeform {
        let pc = chart::planar_chart(&r.pts, &normals);
        u_mm = pc.0;
        v_mm = pc.1;
        t_u = pc.2;
        t_v = pc.3;
    }
    Ok(Geometry {
        pts: r.pts,
        tris: r.tris,
        mean_edge,
        u_mm,
        v_mm,
        lattice: lattice_used,
        freeform,
        taper,
        normals,
        t_u,
        t_v,
    })
}

/// `_orient_windings`: every triangle wound to agree with its vertices'
/// normals.
fn orient_windings(p: &[V], tris: &[Tri], normals: &[V]) -> Vec<Tri> {
    tris.iter()
        .map(|t| {
            let gn = v3::cross(v3::sub(p[t[1]], p[t[0]]), v3::sub(p[t[2]], p[t[0]]));
            let r = v3::add(v3::add(normals[t[0]], normals[t[1]]), normals[t[2]]);
            if gn[0] * r[0] + gn[1] * r[1] + gn[2] * r[2] < 0.0 {
                [t[0], t[2], t[1]]
            } else {
                *t
            }
        })
        .collect()
}

fn transform(spec: &Spec, mut h: f64) -> f64 {
    if spec.invert {
        h = 1.0 - h;
    }
    match spec.direction.as_str() {
        "in" => h - 1.0,
        "both" => (h - 0.5) * 2.0,
        _ => h,
    }
}

/// The narrower of a face's two extents in the pattern's frame.
fn narrow_width(geom: &Geometry) -> f64 {
    let (ulo, uhi) = np::min_max(geom.u_mm.iter().copied());
    let (vlo, vhi) = np::min_max(geom.v_mm.iter().copied());
    (uhi - ulo).min(vhi - vlo)
}

/// A signed height below this share of the depth leaves a face looking flat.
const VISIBLE: f64 = 0.01;

/// The height field over one face geometry: the boundary taper times the
/// slope mask, the spec the heights are sampled with and the signed heights.
struct Heights {
    taper: Vec<f64>,
    slope: Option<Vec<f64>>,
    spec_h: Spec,
    use_tp: bool,
    signed: Vec<f64>,
}

impl Heights {
    fn of(geom: &Geometry, spec: &Spec, target_edge_mm: f64) -> Result<Heights, String> {
        let kind = spec.kind.as_str();
        let slope = chart::slope_mask(&geom.normals, spec);
        let mut taper = geom.taper.clone();
        if let Some(mask) = &slope {
            for (t, s) in taper.iter_mut().zip(mask) {
                *t *= s;
            }
        }
        let mut spec_h = spec.clone();
        if kind != "image" && !geom.lattice && geom.mean_edge > target_edge_mm * 1.25 {
            spec_h.scale = 4.0 * geom.mean_edge;
        }
        let use_tp = geom.freeform && kind != "image" && (spec.projection == "triplanar" || spec.projection == "box");
        let mut h = Heights {
            taper,
            slope,
            spec_h,
            use_tp,
            signed: Vec::new(),
        };
        h.signed = h.at(geom, spec, 0.0, 0.0)?;
        Ok(h)
    }

    /// The signed heights with the pattern shifted by `du`, `dv` mm.
    fn at(&self, geom: &Geometry, spec: &Spec, du: f64, dv: f64) -> Result<Vec<f64>, String> {
        let kind = spec.kind.as_str();
        let raw = if self.use_tp {
            let w = chart::tp_weights(&geom.normals, chart::tp_exponent(spec));
            let pq: Vec<V> = (0..geom.pts.len())
                .map(|i| v3::add(v3::add(geom.pts[i], v3::scale(geom.t_u[i], du)), v3::scale(geom.t_v[i], dv)))
                .collect();
            triplanar_field(kind, &self.spec_h, &pq, &w, spec.offset)?
        } else {
            let u_mm: Vec<f64> = geom.u_mm.iter().map(|u| u + spec.offset).collect();
            let ur = np::min_max(u_mm.iter().copied());
            let vr = np::min_max(geom.v_mm.iter().copied());
            let uu: Vec<f64> = u_mm.iter().map(|u| u + du).collect();
            let vv: Vec<f64> = geom.v_mm.iter().map(|v| v + dv).collect();
            height::height_field_smoothed(kind, &self.spec_h, &uu, &vv, Some(ur), Some(vr))?
        };
        Ok(raw.into_iter().map(|h| transform(spec, h)).collect())
    }

    fn moves(&self) -> bool {
        self.signed.iter().zip(&self.taper).any(|(s, t)| (s * t).abs() > VISIBLE)
    }

    fn masked_out(&self) -> bool {
        self.slope.as_ref().is_some_and(|mask| mask.iter().all(|&m| m == 0.0))
    }
}

/// `displace_face`: a flat mesh of one textured face with per vertex
/// displaced normals. `bleed` is a grime neighbour's tag; `split_creases`
/// (viewport only) hands a faceted profile back unshared, with each triangle's
/// own normal, so its creases shade hard.
pub fn displace_face(face: &Shape, spec_in: &Spec, bleed: bool, density_cap: u32, split_creases: bool) -> Result<Mesh, String> {
    let flip = face.is_reversed();
    let mut spec = spec_in.clone();
    if spec.grime > 0.0 && bleed {
        let g = spec.grime;
        spec.kind = "noise".into();
        spec.direction = "out".into();
        spec.depth *= g;
        spec.scale = (spec.scale * 1.6).max(0.05);
        spec.profile = "round".into();
    }
    let kind = spec.kind.clone();
    let scale = spec.scale.max(0.05);
    let mut target_edge_mm = (scale / 4.0).max(0.05);
    if spec.target_edge > 0.0 {
        target_edge_mm = spec.target_edge.max(0.02);
    }
    let mut cap = if density_cap > 0 { density_cap as usize } else { DEFAULT_DENSITY_CAP };
    if spec.tri_budget > 0 {
        cap = cap.min(spec.tri_budget as usize);
    }
    if kind == "image" && spec.image.is_none() {
        spec.image = Some(std::rc::Rc::new(crate::image::load(spec.image_path.as_deref().unwrap_or(""))?));
    }
    let depth = spec.depth * spec.amplitude;
    let mut geom = displacement_geometry(face, &spec, scale, target_edge_mm, cap, flip, false)?;
    let mut heights = Heights::of(&geom, &spec, target_edge_mm)?;
    if depth != 0.0 && !heights.moves() && !heights.masked_out() {
        // A narrow face whose lattice rows all land on the pattern's zero
        // lines, or one with no interior vertex off the pinned boundary.
        let width = narrow_width(&geom);
        for across in [4.0, 8.0] {
            let edge = (target_edge_mm * 0.5).min(width / across).max(0.02);
            geom = displacement_geometry(face, &spec, scale, edge, cap, flip, true)?;
            heights = Heights::of(&geom, &spec, target_edge_mm)?;
            if heights.moves() {
                break;
            }
        }
        if !bleed && !heights.moves() {
            return Err(format!(
                "the {kind} pattern at scale {scale} mm leaves a face {width:.2} mm wide flat, lower the scale or leave this face out"
            ));
        }
    }
    let n = geom.pts.len();
    let disp: Vec<V> = (0..n)
        .map(|i| v3::add(geom.pts[i], v3::scale(geom.normals[i], depth * heights.signed[i] * heights.taper[i])))
        .collect();
    let eps = (heights.spec_h.scale / 16.0).max(1e-3);
    let (up, um) = (heights.at(&geom, &spec, eps, 0.0)?, heights.at(&geom, &spec, -eps, 0.0)?);
    let (vp, vm) = (heights.at(&geom, &spec, 0.0, eps)?, heights.at(&geom, &spec, 0.0, -eps)?);
    let disp_normals: Vec<V> = (0..n)
        .map(|i| {
            let dhdu = (up[i] - um[i]) / (2.0 * eps);
            let dhdv = (vp[i] - vm[i]) / (2.0 * eps);
            let s = depth * heights.taper[i];
            let grad = v3::scale(v3::add(v3::scale(geom.t_u[i], dhdu), v3::scale(geom.t_v[i], dhdv)), s);
            let dn = v3::sub(geom.normals[i], grad);
            let mut ln = v3::norm(dn);
            if ln < 1e-12 {
                ln = 1.0;
            }
            [dn[0] / ln, dn[1] / ln, dn[2] / ln]
        })
        .collect();
    let idx = orient_windings(&disp, &geom.tris, &disp_normals);
    if split_creases && spec.facet() {
        let mut positions = Vec::with_capacity(idx.len() * 9);
        let mut normals = Vec::with_capacity(idx.len() * 9);
        for t in &idx {
            let (a, b, c) = (disp[t[0]], disp[t[1]], disp[t[2]]);
            let fnrm = v3::cross(v3::sub(b, a), v3::sub(c, a));
            let mut ln = v3::norm(fnrm);
            if ln < 1e-12 {
                ln = 1.0;
            }
            let unit = [fnrm[0] / ln, fnrm[1] / ln, fnrm[2] / ln];
            for p in [a, b, c] {
                positions.extend_from_slice(&p);
                normals.extend(unit.iter().map(|&x| x as f32));
            }
        }
        let count = (positions.len() / 3) as u32;
        return Ok(Mesh {
            positions,
            indices: (0..count).collect(),
            normals,
        });
    }
    Ok(Mesh {
        positions: disp.iter().flatten().copied().collect(),
        indices: idx.iter().flat_map(|t| t.iter().map(|&i| i as u32)).collect(),
        normals: disp_normals.iter().flatten().map(|&x| x as f32).collect(),
    })
}
