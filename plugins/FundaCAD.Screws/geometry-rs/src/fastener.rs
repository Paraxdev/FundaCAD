//! scr_build.py: one fastener solid from a checked spec.
//!
//! A simplified thread is a plain cylinder at the NOMINAL (major) diameter, for
//! screws and for the bores of nuts and inserts alike, so a screw in its nut
//! shows no interference and a clearance hole checked against it is checked
//! against the real outside of the thread. A modelled thread cuts the helix
//! into that cylinder; a modelled internal thread bores at the minor diameter
//! and cuts outward.

use std::f64::consts::PI;

use crate::shapes::{self as s, R};
use crate::thread as t;
use crate::{kernel, py_repr, Shape, P};

fn single_solid(shape: &Shape, name: &str) -> R<Shape> {
    let solids = shape.solids();
    if solids.len() != 1 {
        return Err(format!(
            "Fastener: {name} came out as {} pieces instead of one solid",
            solids.len()
        ));
    }
    Ok(solids.into_iter().next().expect("one solid"))
}

fn set_screw_top(r: f64, pitch: f64) -> Vec<(f64, f64)> {
    let c = (pitch * 0.6134 * 0.8).min(r * 0.3);
    vec![(0.0, 0.0), (r - c, 0.0), (r, -c)]
}

fn screw(spec: &P) -> R<Shape> {
    let (head, drive, thread, point) = (spec.p("head"), spec.p("drive"), spec.p("thread"), spec.p("point"));
    let (d, pitch, l) = (thread.f("diameter"), thread.f("pitch"), spec.f("length"));
    let shoulder = spec.opt("shoulder");
    let r = d / 2.0;
    let htype = head.s("type");
    let modelled = thread.b("modelled");

    let body_r = shoulder.as_ref().map_or(r, |sh| sh.f("diameter") / 2.0);
    let z_end = if shoulder.is_some() { -(l + thread.f("length")) } else { -l };
    let z_neck = if shoulder.is_some() {
        -l
    } else if htype == "countersunk" {
        -head.f("height")
    } else {
        0.0
    };
    let tip = s::point_outline(&point, r, z_end, pitch, -z_end);

    let thread_top;
    let tail: Vec<(f64, f64)>;
    if modelled {
        let top = if shoulder.is_some() { -l } else { (z_end + thread.f("length")).min(z_neck) };
        thread_top = Some(top);
        tail = if top < z_neck - 1e-9 {
            vec![(body_r, top), (0.0, top)]
        } else if shoulder.is_some() {
            vec![(body_r, z_neck), (0.0, z_neck)]
        } else {
            vec![(0.0, z_neck)]
        };
    } else {
        thread_top = None;
        tail = if shoulder.is_some() {
            let mut v = vec![(body_r, -l), (r, -l)];
            v.extend(tip.iter().copied());
            v
        } else {
            tip.clone()
        };
    }
    let open_neck = tail.len() == 1;

    let (outline, mut z_top) = s::head_outline(&head, body_r);
    let curved = s::curved_head(&head, body_r)?;
    let with_tail = |first: Vec<(f64, f64)>| {
        let mut v = first;
        v.extend(tail.iter().copied());
        v
    };
    let mut body: Option<Shape> = if let Some(mut edges) = curved {
        let mut pts = vec![(body_r, 0.0)];
        pts.extend(tail.iter().copied());
        for w in pts.windows(2) {
            edges.push(kernel::line_edge((w[0].0, 0.0, w[0].1), (w[1].0, 0.0, w[1].1))?);
        }
        let last = tail.last().map_or(0.0, |p| p.1);
        edges.push(kernel::line_edge((0.0, 0.0, last), (0.0, 0.0, head.f("height")))?);
        z_top = head.f("height");
        Some(s::revolve_edges(&edges)?)
    } else if htype == "none" {
        if !modelled {
            let mut v = set_screw_top(r, pitch);
            v.extend(tail.iter().copied());
            Some(s::revolve_rz(&v)?)
        } else if open_neck {
            None
        } else {
            Some(s::revolve_rz(&with_tail(vec![(0.0, 0.0), (r, 0.0)]))?)
        }
    } else if let Some(o) = outline {
        Some(s::revolve_rz(&with_tail(o))?)
    } else {
        z_top = head.f("height");
        match htype {
            "hexFlange" => {
                let c = head.f("flangeThickness");
                let rf = head.f("flangeDiameter") / 2.0;
                let shank = s::revolve_rz(&with_tail(vec![(0.0, c), (rf, c), (rf, 0.0), (body_r, 0.0)]))?;
                Some(s::fuse(&[shank, s::chamfered_hex(head.f("acrossFlats"), c, head.f("height"), true, false)?])?)
            }
            "hex" => {
                let hexhead = s::chamfered_hex(head.f("acrossFlats"), 0.0, head.f("height"), true, false)?;
                if open_neck {
                    Some(hexhead)
                } else {
                    Some(s::fuse(&[s::revolve_rz(&with_tail(vec![(0.0, 0.0), (body_r, 0.0)]))?, hexhead])?)
                }
            }
            "knurled" => {
                let (rc, kc) = (head.f("collarDiameter") / 2.0, head.f("collarHeight"));
                let (rr, k) = (head.f("diameter") / 2.0, head.f("height"));
                let teeth = 18i64.max((PI * 2.0 * rr / 0.8f64.max(rr * 0.2)).round_ties_even() as i64);
                let knurl = s::prism(&s::star(rr, rr * 0.93, teeth), kc, k - kc)?;
                let collar = s::revolve_rz(&with_tail(vec![(0.0, kc), (rc, kc), (rc, 0.0), (body_r, 0.0)]))?;
                Some(s::fuse(&[collar, knurl])?)
            }
            other => return Err(format!("Fastener: unknown head type {}", py_repr(other))),
        }
    };

    let room = head
        .truthy_f("acrossFlats")
        .or_else(|| head.truthy_f("diameter"))
        .unwrap_or(d);
    let tool = s::drive_tool(&drive, z_top, room)?;
    if let (Some(tl), Some(b)) = (&tool, &body) {
        if htype != "none" {
            body = Some(s::cut(b, std::slice::from_ref(tl))?);
        }
    }

    if modelled {
        let top = thread_top.expect("a modelled thread has a top");
        let seg = t::cut_external(&s::cylinder(r, z_end, top)?, d, pitch, z_end, top, thread.s("hand") == "left")?;
        let mut b = match body {
            None => seg,
            Some(b) => s::fuse(&[b, seg])?,
        };
        let mut point_cut = vec![(r + pitch, tip[0].1)];
        point_cut.extend(tip.iter().copied());
        point_cut.extend([(0.0, z_end - pitch), (r + pitch, z_end - pitch)]);
        b = s::cut(&b, &[s::revolve_rz(&point_cut)?])?;
        if htype == "none" {
            let top_pts = set_screw_top(r, pitch);
            let (rc, zc) = (top_pts[1].0, top_pts[2].1);
            b = s::cut(&b, &[s::revolve_rz(&[(rc, 0.0), (r, zc), (r + pitch, zc), (r + pitch, pitch), (rc, pitch)])?])?;
            if let Some(tl) = &tool {
                b = s::cut(&b, std::slice::from_ref(tl))?;
            }
        }
        body = Some(b);
    } else if htype == "none" {
        if let (Some(tl), Some(b)) = (&tool, &body) {
            body = Some(s::cut(b, std::slice::from_ref(tl))?);
        }
    }
    let body = body.ok_or("Fastener: nothing was built")?;
    single_solid(&body, &spec.text("name"))
}

fn bore(body: Shape, spec: &P, z0: f64, z1: f64) -> R<Shape> {
    let thread = spec.p("thread");
    let (d, pitch) = (thread.f("diameter"), thread.f("pitch"));
    if thread.b("modelled") {
        let body = s::cut(&body, &[s::cylinder(t::minor_radius(d, pitch), z0 - 1.0, z1 + 1.0)?])?;
        return t::cut_internal(&body, d, pitch, z0, z1, thread.s("hand") == "left");
    }
    s::cut(&body, &[s::cylinder(d / 2.0, z0 - 1.0, z1 + 1.0)?])
}

fn nut(spec: &P) -> R<Shape> {
    let nut = spec.p("nut");
    let (kind, af, h) = (nut.s("type"), nut.f("acrossFlats"), nut.f("height"));
    let body = match kind {
        "hex" => s::chamfered_hex(af, 0.0, h, true, true)?,
        "square" => s::prism(&s::square(af), 0.0, h)?,
        "nyloc" => {
            let hh = nut.f("hexHeight");
            let rc = af / 2.0 * 0.92;
            let cc = ((h - hh) * 0.4).min(rc * 0.2);
            let collar = s::revolve_rz(&[(0.0, hh), (rc, hh), (rc, h - cc), (rc - cc, h), (0.0, h)])?;
            s::fuse(&[s::chamfered_hex(af, 0.0, hh, false, true)?, collar])?
        }
        "flange" => {
            let (c, rf) = (nut.f("flangeThickness"), nut.f("flangeDiameter") / 2.0);
            s::fuse(&[s::cylinder(rf, 0.0, c)?, s::chamfered_hex(af, c, h, true, false)?])?
        }
        other => return Err(format!("Fastener: unknown nut type {}", py_repr(other))),
    };
    single_solid(&bore(body, spec, 0.0, h)?, &spec.text("name"))
}

fn washer(spec: &P) -> R<Shape> {
    let w = spec.p("washer");
    let (ri, ro, th) = (w.f("inner") / 2.0, w.f("outer") / 2.0, w.f("thickness"));
    let mut body = s::revolve_rz(&[(ri, 0.0), (ro, 0.0), (ro, th), (ri, th)])?;
    if w.s("type") == "spring" {
        let gap = (th * 0.8).max((ro - ri) * 0.3);
        body = s::cut(&body, &[s::make_box(ri * 0.5, ro + 1.0, -gap / 2.0, gap / 2.0, -1.0, th + 1.0)?])?;
    }
    single_solid(&body, &spec.text("name"))
}

fn insert(spec: &P) -> R<Shape> {
    let ins = spec.p("insert");
    let (rr, length) = (ins.f("outer") / 2.0, ins.f("length"));
    let depth = 0.08f64.max(rr * 0.08);
    let inner = rr - depth;
    let lead = (length * 0.2).min(rr * 0.6);
    let band = (length - lead) * 0.42;
    let teeth = 12i64.max((2.0 * PI * rr / 0.5f64.max(rr * 0.35)).round_ties_even() as i64);
    let core = s::cylinder(inner, -length, 0.0)?;
    let lower = s::prism(&s::star(rr, inner, teeth), -length + lead, band)?;
    let upper = s::prism(&s::star(rr, inner, teeth), -band, band)?;
    let body = s::fuse(&[core, lower, upper])?;
    single_solid(&bore(body, spec, -length, 0.0)?, &spec.text("name"))
}

/// `build`: the checked spec's fastener.
pub fn build(params: &serde_json::Value) -> R<Shape> {
    let checked = crate::spec::checked(params)?;
    let spec = P(checked);
    match spec.s("kind") {
        "screw" | "shoulderScrew" => screw(&spec),
        "nut" => nut(&spec),
        "washer" => washer(&spec),
        "insert" => insert(&spec),
        other => Err(format!("Fastener: unknown kind {}", py_repr(other))),
    }
}
