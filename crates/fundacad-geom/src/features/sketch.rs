//! Sketches turned into located profiles and region cells, replacing
//! the Python engine's `sketch_build.py` (`_build_sketch`, `_entity_edges`,
//! `_expand_pattern`, `_faces_from_edges`, `_subdivide_faces`, `_region_*`) and
//! the `split_profile_cells` rule of the Python engine's `face_footprint.py`.
//!
//! A sketch follows the face it was made on through face_anchor.rs, and its
//! text entities are drawn by the text module.

use std::collections::HashMap;
use std::f64::consts::PI;

use fundacad_core::schema::{Num, ProjectedCurve, SketchEntity, SketchFeature, SketchPattern};
use opencascade::primitives::Shape;

use super::face_anchor::{face_anchor_plane, Placement};
use crate::builder::plane::{plane_of, PlaneRef};
use crate::builder::{py_g, Ctx, FResult, Fail, SketchEntry};
use crate::kernel::{self, BoolKind, Frame, Kind};

/// A sketch entity with its numbers resolved.
#[derive(Debug, Clone)]
enum Ent {
    Rect {
        w: f64,
        h: f64,
        x: f64,
        y: f64,
        angle: f64,
    },
    Circle {
        r: f64,
        x: f64,
        y: f64,
    },
    Ellipse {
        rx: f64,
        ry: f64,
        x: f64,
        y: f64,
        angle: f64,
    },
    Line {
        a: [f64; 2],
        b: [f64; 2],
    },
    Arc {
        a: [f64; 2],
        b: [f64; 2],
        m: [f64; 2],
    },
    Spline(Vec<[f64; 2]>),
    Bspline {
        poles: Vec<[f64; 2]>,
        degree: Option<f64>,
        closed: bool,
        knots: Option<Vec<f64>>,
    },
    Point {
        x: f64,
        y: f64,
    },
    Polygon {
        x: f64,
        y: f64,
        r: f64,
        sides: f64,
        angle: f64,
    },
    Slot {
        a: [f64; 2],
        b: [f64; 2],
        w: f64,
    },
    Projected(ProjectedCurve),
    Text(Box<fundacad_core::schema::Text>),
    Other,
}

struct Item {
    id: Option<String>,
    construction: bool,
    ent: Ent,
}

fn resolve(ctx: &Ctx, e: &SketchEntity) -> FResult<Item> {
    let v = |n: &Num| ctx.val(n);
    let o = |n: &Option<Num>| ctx.val_or(n.as_ref(), 0.0);
    let (construction, ent) = match e {
        SketchEntity::Rectangle(r) => (
            r.construction,
            Ent::Rect {
                w: v(&r.width)?,
                h: v(&r.height)?,
                x: o(&r.x)?,
                y: o(&r.y)?,
                angle: o(&r.angle)?,
            },
        ),
        SketchEntity::Circle(c) => (
            c.construction,
            Ent::Circle {
                r: v(&c.radius)?,
                x: o(&c.x)?,
                y: o(&c.y)?,
            },
        ),
        SketchEntity::Ellipse(c) => (
            c.construction,
            Ent::Ellipse {
                rx: v(&c.rx)?,
                ry: v(&c.ry)?,
                x: o(&c.x)?,
                y: o(&c.y)?,
                angle: o(&c.angle)?,
            },
        ),
        SketchEntity::Line(l) => (
            l.construction,
            Ent::Line {
                a: [v(&l.x1)?, v(&l.y1)?],
                b: [v(&l.x2)?, v(&l.y2)?],
            },
        ),
        SketchEntity::Arc(a) => (
            a.construction,
            Ent::Arc {
                a: [v(&a.x1)?, v(&a.y1)?],
                b: [v(&a.x2)?, v(&a.y2)?],
                m: [v(&a.mx)?, v(&a.my)?],
            },
        ),
        SketchEntity::Spline(s) => {
            let mut pts = Vec::with_capacity(s.points.len());
            for p in &s.points {
                pts.push([v(&p.x)?, v(&p.y)?]);
            }
            (s.construction, Ent::Spline(pts))
        }
        SketchEntity::Bspline(b) => {
            let mut poles = Vec::with_capacity(b.poles.len());
            for p in &b.poles {
                poles.push([v(&p.x)?, v(&p.y)?]);
            }
            (
                b.construction,
                Ent::Bspline {
                    poles,
                    degree: b.degree.as_ref().map(|d| d.get()),
                    closed: b.closed.unwrap_or(false),
                    knots: b.knots.as_ref().map(|k| k.iter().map(|x| x.get()).collect()),
                },
            )
        }
        SketchEntity::Point(p) => (
            p.construction,
            Ent::Point {
                x: v(&p.x)?,
                y: v(&p.y)?,
            },
        ),
        SketchEntity::Polygon(p) => (
            p.construction,
            Ent::Polygon {
                x: v(&p.x)?,
                y: v(&p.y)?,
                r: v(&p.radius)?,
                sides: v(&p.sides)?,
                angle: v(&p.angle)?,
            },
        ),
        SketchEntity::Slot(s) => (
            s.construction,
            Ent::Slot {
                a: [v(&s.x1)?, v(&s.y1)?],
                b: [v(&s.x2)?, v(&s.y2)?],
                w: v(&s.width)?,
            },
        ),
        SketchEntity::Projected(p) => (p.construction, Ent::Projected(p.curve.clone())),
        SketchEntity::Text(t) => (t.construction, Ent::Text(Box::new(t.clone()))),
        SketchEntity::Unknown(_) => (None, Ent::Other),
        SketchEntity::Invalid(inv) => {
            let raw_construction = inv
                .raw
                .get("construction")
                .and_then(serde_json::Value::as_bool);
            if raw_construction == Some(true) {
                (Some(true), Ent::Other)
            } else if let Some(rest) = inv.error.strip_prefix("missing field `") {
                return Err(Fail::Missing(
                    rest.split('`').next().unwrap_or("").to_owned(),
                ));
            } else {
                return Err(Fail::Internal("TypeError".into()));
            }
        }
    };
    Ok(Item {
        id: e.id().map(str::to_owned),
        construction: construction.unwrap_or(false),
        ent,
    })
}

/// Python's `round()` to an integer: ties to even.
fn py_round(v: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    let r = v.round_ties_even() as i64;
    r
}

/// `_rect_corners`: bl, br, tr, tl about the rectangle's own centre.
fn rect_corners(w: f64, h: f64, x: f64, y: f64, angle: f64) -> [[f64; 2]; 4] {
    let (hw, hh) = (w / 2.0, h / 2.0);
    let local = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    let a = angle.to_radians();
    if a == 0.0 {
        return local.map(|[lx, ly]| [x + lx, y + ly]);
    }
    let (c, s) = (a.cos(), a.sin());
    local.map(|[lx, ly]| [x + lx * c - ly * s, y + lx * s + ly * c])
}

/// `_translate_entity`.
fn translate(ctx: &Ctx, e: &Item, dx: f64, dy: f64, id: String) -> FResult<Item> {
    let ent = match &e.ent {
        // Python's fallthrough: a patterned copy of anything else is a point,
        // and the lettering itself is not repeated.
        Ent::Text(t) => {
            let n = |v: &Option<Num>| match v {
                Some(n) => ctx.val(n),
                None => Err(Fail::Missing("x".into())),
            };
            Ent::Point {
                x: n(&t.x)? + dx,
                y: n(&t.y)? + dy,
            }
        }
        Ent::Line { a, b } => Ent::Line {
            a: [a[0] + dx, a[1] + dy],
            b: [b[0] + dx, b[1] + dy],
        },
        Ent::Rect { w, h, x, y, .. } => Ent::Rect {
            w: *w,
            h: *h,
            x: x + dx,
            y: y + dy,
            angle: 0.0,
        },
        Ent::Circle { r, x, y } => Ent::Circle {
            r: *r,
            x: x + dx,
            y: y + dy,
        },
        Ent::Ellipse {
            rx,
            ry,
            x,
            y,
            angle,
        } => Ent::Ellipse {
            rx: *rx,
            ry: *ry,
            x: x + dx,
            y: y + dy,
            angle: *angle,
        },
        Ent::Arc { a, b, m } => Ent::Arc {
            a: [a[0] + dx, a[1] + dy],
            b: [b[0] + dx, b[1] + dy],
            m: [m[0] + dx, m[1] + dy],
        },
        Ent::Spline(p) => Ent::Spline(p.iter().map(|q| [q[0] + dx, q[1] + dy]).collect()),
        Ent::Bspline { poles, degree, closed, knots } => Ent::Bspline {
            poles: poles.iter().map(|q| [q[0] + dx, q[1] + dy]).collect(),
            degree: *degree,
            closed: *closed,
            knots: knots.clone(),
        },
        Ent::Point { x, y } | Ent::Polygon { x, y, .. } => Ent::Point {
            x: x + dx,
            y: y + dy,
        },
        _ => return Err(Fail::Missing("x".into())),
    };
    Ok(Item {
        id: Some(id),
        construction: e.construction,
        ent,
    })
}

/// `_rotate_entity`.
fn rotate(e: &Item, cx: f64, cy: f64, ang: f64, id: &str) -> FResult<Vec<Item>> {
    let (co, si) = (ang.cos(), ang.sin());
    let rot = |x: f64, y: f64| {
        let (ddx, ddy) = (x - cx, y - cy);
        [cx + ddx * co - ddy * si, cy + ddx * si + ddy * co]
    };
    let one = |ent: Ent| {
        Ok(vec![Item {
            id: Some(id.to_owned()),
            construction: e.construction,
            ent,
        }])
    };
    match &e.ent {
        Ent::Circle { r, x, y } => {
            let p = rot(*x, *y);
            one(Ent::Circle {
                r: *r,
                x: p[0],
                y: p[1],
            })
        }
        Ent::Ellipse {
            rx,
            ry,
            x,
            y,
            angle,
        } => {
            let p = rot(*x, *y);
            one(Ent::Ellipse {
                rx: *rx,
                ry: *ry,
                x: p[0],
                y: p[1],
                angle: angle + ang.to_degrees(),
            })
        }
        Ent::Point { x, y } => {
            let p = rot(*x, *y);
            one(Ent::Point { x: p[0], y: p[1] })
        }
        Ent::Line { a, b } => one(Ent::Line {
            a: rot(a[0], a[1]),
            b: rot(b[0], b[1]),
        }),
        Ent::Arc { a, b, m } => one(Ent::Arc {
            a: rot(a[0], a[1]),
            b: rot(b[0], b[1]),
            m: rot(m[0], m[1]),
        }),
        Ent::Spline(p) => one(Ent::Spline(p.iter().map(|q| rot(q[0], q[1])).collect())),
        Ent::Bspline { poles, degree, closed, knots } => one(Ent::Bspline {
            poles: poles.iter().map(|q| rot(q[0], q[1])).collect(),
            degree: *degree,
            closed: *closed,
            knots: knots.clone(),
        }),
        Ent::Rect { w, h, x, y, angle } => {
            let c = rect_corners(*w, *h, *x, *y, *angle).map(|p| rot(p[0], p[1]));
            Ok((0..4)
                .map(|i| Item {
                    id: Some(format!("{id}.{i}")),
                    construction: e.construction,
                    ent: Ent::Line {
                        a: c[i],
                        b: c[(i + 1) % 4],
                    },
                })
                .collect())
        }
        _ => Err(Fail::Missing("width".into())),
    }
}

fn hexagon_lines(cx: f64, cy: f64, r: f64, id: &str) -> Vec<Item> {
    let v: Vec<[f64; 2]> = (0..6)
        .map(|k| {
            let a = PI / 6.0 + f64::from(k) * PI / 3.0;
            [cx + r * a.cos(), cy + r * a.sin()]
        })
        .collect();
    (0..6)
        .map(|k| Item {
            id: Some(format!("{id}.{k}")),
            construction: false,
            ent: Ent::Line {
                a: v[k],
                b: v[(k + 1) % 6],
            },
        })
        .collect()
}

/// `_expand_pattern`: derived entities with ids `<pattern id>#<n>`.
fn expand_pattern(
    ctx: &Ctx,
    pat: &SketchPattern,
    by_id: &HashMap<String, usize>,
    items: &[Item],
) -> FResult<Vec<Item>> {
    let mut out = Vec::new();
    let mut counter = 0usize;
    let pid = pat
        .raw()
        .and_then(|r| r.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let mut did = |base: &str| {
        counter += 1;
        format!("{base}#{}", counter - 1)
    };
    let v = |n: &Num| ctx.val(n);
    let sources = |ids: &[String]| -> Vec<&Item> {
        ids.iter()
            .filter_map(|s| by_id.get(s).map(|&i| &items[i]))
            .filter(|it| !matches!(it.ent, Ent::Projected(_)))
            .collect()
    };
    match pat {
        SketchPattern::PatternRect(p) => {
            let (cx, cy) = (
                py_round(v(&p.count_x)?).max(1),
                py_round(v(&p.count_y)?).max(1),
            );
            let (sx, sy) = (v(&p.spacing_x)?, v(&p.spacing_y)?);
            let ang = ctx.val_or(p.angle.as_ref(), 0.0)?.to_radians();
            let (co, si) = (ang.cos(), ang.sin());
            let srcs = sources(&p.sources);
            for i in 0..cx {
                for j in 0..cy {
                    if i == 0 && j == 0 {
                        continue;
                    }
                    #[allow(clippy::cast_precision_loss)]
                    let (mut dx, mut dy) = (i as f64 * sx, j as f64 * sy);
                    if ang != 0.0 {
                        (dx, dy) = (dx * co - dy * si, dx * si + dy * co);
                    }
                    for s in &srcs {
                        let id = did(&p.id);
                        out.push(translate(ctx, s, dx, dy, id)?);
                    }
                }
            }
        }
        SketchPattern::PatternCircular(p) => {
            let count = py_round(v(&p.count)?).max(1);
            let total = v(&p.angle)?;
            let full = total != 0.0 && (total.abs() - 360.0).abs() < 1e-6;
            #[allow(clippy::cast_precision_loss)]
            let step = if full {
                total / count as f64
            } else {
                total / (count - 1).max(1) as f64
            }
            .to_radians();
            let (cx, cy) = (v(&p.cx)?, v(&p.cy)?);
            let srcs = sources(&p.sources);
            for k in 1..count {
                for s in &srcs {
                    let id = did(&p.id);
                    #[allow(clippy::cast_precision_loss)]
                    out.extend(rotate(s, cx, cy, k as f64 * step, &id)?);
                }
            }
        }
        SketchPattern::BoltCircle(p) => {
            let count = py_round(v(&p.count)?).max(1);
            let (r, rad) = (v(&p.bcd)? / 2.0, v(&p.diameter)? / 2.0);
            let (cx, cy) = (v(&p.cx)?, v(&p.cy)?);
            for k in 0..count {
                #[allow(clippy::cast_precision_loss)]
                let a = (k as f64 / count as f64) * 2.0 * PI;
                let id = did(&p.id);
                out.push(Item {
                    id: Some(id),
                    construction: false,
                    ent: Ent::Circle {
                        r: rad,
                        x: cx + r * a.cos(),
                        y: cy + r * a.sin(),
                    },
                });
            }
        }
        SketchPattern::GridHoles(p) => {
            let (nx, ny) = (
                py_round(v(&p.count_x)?).max(1),
                py_round(v(&p.count_y)?).max(1),
            );
            let (sx, sy, rad) = (v(&p.spacing_x)?, v(&p.spacing_y)?, v(&p.diameter)? / 2.0);
            let (cx, cy) = (v(&p.cx)?, v(&p.cy)?);
            for i in 0..nx {
                for j in 0..ny {
                    let id = did(&p.id);
                    #[allow(clippy::cast_precision_loss)]
                    let (x, y) = (
                        cx + (i as f64 - (nx - 1) as f64 / 2.0) * sx,
                        cy + (j as f64 - (ny - 1) as f64 / 2.0) * sy,
                    );
                    out.push(Item {
                        id: Some(id),
                        construction: false,
                        ent: Ent::Circle { r: rad, x, y },
                    });
                }
            }
        }
        SketchPattern::HexHoles(p) | SketchPattern::Honeycomb(p) => {
            let honeycomb = matches!(pat, SketchPattern::Honeycomb(_));
            let rings = py_round(v(&p.rings)?).max(0);
            let (s, rad) = (v(&p.spacing)?, v(&p.diameter)? / 2.0);
            let (cx, cy) = (v(&p.cx)?, v(&p.cy)?);
            let h = s * 3f64.sqrt() / 2.0;
            for q in -rings..=rings {
                for rr in (-rings).max(-q - rings)..=rings.min(-q + rings) {
                    let id = did(&p.id);
                    #[allow(clippy::cast_precision_loss)]
                    let (x, y) = (cx + s * (q as f64 + rr as f64 / 2.0), cy + h * rr as f64);
                    if honeycomb {
                        out.extend(hexagon_lines(x, y, rad, &id));
                    } else {
                        out.push(Item {
                            id: Some(id),
                            construction: false,
                            ent: Ent::Circle { r: rad, x, y },
                        });
                    }
                }
            }
        }
        SketchPattern::Unknown(_) | SketchPattern::Invalid(_) => {
            let _ = pid;
        }
    }
    Ok(out)
}

/// `_entity_edges`: the entity's boundary, local to the sketch's XY.
fn entity_edges(e: &Ent) -> FResult<Vec<Shape>> {
    Ok(match e {
        Ent::Line { a, b } => vec![kernel::edge_line(*a, *b)?],
        Ent::Arc { a, b, m } => vec![kernel::edge_arc3(*a, *m, *b)?],
        Ent::Circle { r, x, y } => vec![kernel::edge_circle([*x, *y], *r)?],
        Ent::Ellipse {
            rx,
            ry,
            x,
            y,
            angle,
        } => vec![kernel::edge_ellipse([*x, *y], *rx, *ry, *angle)?],
        Ent::Spline(pts) => {
            if pts.len() >= 2 {
                vec![kernel::edge_spline(pts)?]
            } else {
                Vec::new()
            }
        }
        Ent::Bspline { poles, degree, closed, knots } => {
            if poles.len() >= if *closed { 3 } else { 2 } {
                vec![kernel::edge_bspline(poles, *degree, *closed, knots.as_deref())?]
            } else {
                Vec::new()
            }
        }
        Ent::Rect { w, h, x, y, angle } => {
            let c = rect_corners(*w, *h, *x, *y, *angle);
            (0..4)
                .map(|k| kernel::edge_line(c[k], c[(k + 1) % 4]))
                .collect::<Result<_, _>>()?
        }
        Ent::Polygon {
            x,
            y,
            r,
            sides,
            angle,
        } => {
            let n = py_round(*sides).max(3);
            let ang = angle.to_radians();
            #[allow(clippy::cast_precision_loss)]
            let pts: Vec<[f64; 2]> = (0..n)
                .map(|i| {
                    let t = ang + i as f64 / n as f64 * 2.0 * PI;
                    [x + t.cos() * r, y + t.sin() * r]
                })
                .collect();
            let n = pts.len();
            (0..n)
                .map(|i| kernel::edge_line(pts[i], pts[(i + 1) % n]))
                .collect::<Result<_, _>>()?
        }
        Ent::Slot { a, b, w } => {
            let (ax, ay, bx, by) = (a[0], a[1], b[0], b[1]);
            let w = w / 2.0;
            let (mut dx, mut dy) = (bx - ax, by - ay);
            let mut l = dx.hypot(dy);
            if l == 0.0 {
                l = 1.0;
            }
            dx /= l;
            dy /= l;
            let (nx, ny) = (-dy * w, dx * w);
            let (a1, a2) = ([ax + nx, ay + ny], [ax - nx, ay - ny]);
            let (b1, b2) = ([bx + nx, by + ny], [bx - nx, by - ny]);
            let a_tip = [ax - dx * w, ay - dy * w];
            let b_tip = [bx + dx * w, by + dy * w];
            vec![
                kernel::edge_line(a1, b1)?,
                kernel::edge_arc3(b1, b_tip, b2)?,
                kernel::edge_line(b2, a2)?,
                kernel::edge_arc3(a2, a_tip, a1)?,
            ]
        }
        Ent::Projected(cv) => match cv {
            ProjectedCurve::Line(l) => {
                let (x1, y1, x2, y2) = (l.x1.get(), l.y1.get(), l.x2.get(), l.y2.get());
                if (x2 - x1).hypot(y2 - y1) <= 1e-9 {
                    Vec::new()
                } else {
                    vec![kernel::edge_line([x1, y1], [x2, y2])?]
                }
            }
            ProjectedCurve::Circle(c) => {
                vec![kernel::edge_circle([c.x.get(), c.y.get()], c.r.get())?]
            }
            ProjectedCurve::Arc(a) => vec![kernel::edge_arc3(
                [a.x1.get(), a.y1.get()],
                [a.mx.get(), a.my.get()],
                [a.x2.get(), a.y2.get()],
            )?],
            ProjectedCurve::Poly(p) => {
                let pts: Vec<[f64; 2]> = p.pts.iter().map(|q| [q[0].get(), q[1].get()]).collect();
                let mut dedup: Vec<[f64; 2]> = Vec::new();
                for (i, q) in pts.iter().enumerate() {
                    if i == 0 || (q[0] - pts[i - 1][0]).hypot(q[1] - pts[i - 1][1]) > 1e-9 {
                        dedup.push(*q);
                    }
                }
                if dedup.len() < 2 {
                    Vec::new()
                } else {
                    dedup
                        .windows(2)
                        .map(|w| kernel::edge_line(w[0], w[1]))
                        .collect::<Result<_, _>>()?
                }
            }
            _ => Vec::new(),
        },
        Ent::Point { .. } | Ent::Text(_) | Ent::Other => Vec::new(),
    })
}

/// `_entity_edge`: the one edge of a line, arc, circle or spline a text follows.
fn path_edge(e: &Ent) -> Option<Shape> {
    match e {
        Ent::Line { .. } | Ent::Arc { .. } | Ent::Circle { .. } | Ent::Spline(_) | Ent::Bspline { .. } => {
            entity_edges(e).ok()?.into_iter().next()
        }
        _ => None,
    }
}

/// `_entity_edge` over an entity the frontend already resolved to numbers.
pub fn path_edge_json(e: &serde_json::Value) -> Option<Shape> {
    let n = |k: &str| e.get(k).map(|v| crate::text::num_or_zero(Some(v)));
    let o = |k: &str| crate::text::num_or_zero(e.get(k));
    let ent = match e.get("type").and_then(serde_json::Value::as_str)? {
        "line" => Ent::Line {
            a: [n("x1")?, n("y1")?],
            b: [n("x2")?, n("y2")?],
        },
        "arc" => Ent::Arc {
            a: [n("x1")?, n("y1")?],
            b: [n("x2")?, n("y2")?],
            m: [n("mx")?, n("my")?],
        },
        "circle" => Ent::Circle {
            r: n("radius")?,
            x: o("x"),
            y: o("y"),
        },
        "spline" => Ent::Spline(
            e.get("points")
                .and_then(serde_json::Value::as_array)
                .map(|pts| {
                    pts.iter()
                        .map(|p| Some([p.get("x").map(|v| crate::text::num_or_zero(Some(v)))?, p.get("y").map(|v| crate::text::num_or_zero(Some(v)))?]))
                        .collect::<Option<Vec<_>>>()
                })
                .unwrap_or(Some(Vec::new()))?,
        ),
        "bspline" => Ent::Bspline {
            poles: e
                .get("poles")
                .and_then(serde_json::Value::as_array)
                .map(|pts| {
                    pts.iter()
                        .map(|p| Some([crate::text::num_or_zero(p.get("x")), crate::text::num_or_zero(p.get("y"))]))
                        .collect::<Option<Vec<_>>>()
                })
                .unwrap_or(Some(Vec::new()))?,
            degree: e.get("degree").and_then(serde_json::Value::as_f64),
            closed: e.get("closed").and_then(serde_json::Value::as_bool).unwrap_or(false),
            knots: e
                .get("knots")
                .and_then(serde_json::Value::as_array)
                .map(|k| k.iter().filter_map(serde_json::Value::as_f64).collect()),
        },
        _ => return None,
    };
    path_edge(&ent)
}

/// `_text_faces`: best effort, a text that cannot be drawn gives no faces.
fn text_faces(ctx: &Ctx, t: &fundacad_core::schema::Text, path: Option<&Shape>) -> Vec<Shape> {
    let spec = || -> FResult<crate::text::TextSpec> {
        let o = |n: &Option<Num>| ctx.val_or(n.as_ref(), 0.0);
        Ok(crate::text::TextSpec {
            text: t.text.clone(),
            size: ctx.val(&t.height)?,
            font: t.font.clone().filter(|f| !f.is_empty()),
            aspect: crate::text::fonts::Aspect::from_style(
                t.style.as_ref().map_or("regular", |s| s.as_str()),
            ),
            align: match t.align.as_ref().map(|a| a.as_str()) {
                Some("center") => crate::text::HAlign::Center,
                Some("right") => crate::text::HAlign::Right,
                _ => crate::text::HAlign::Left,
            },
            rotation: o(&t.angle)?,
            x: o(&t.x)?,
            y: o(&t.y)?,
            position_on_path: o(&t.position_on_path)?,
            box_width: t.box_width.as_ref().map(|b| ctx.val(b)).transpose()?,
        })
    };
    if t.text.trim().is_empty() {
        return Vec::new();
    }
    let Ok(spec) = spec() else {
        return Vec::new();
    };
    let placed = crate::text::glyphs(&spec, path.map(|edge| crate::text::TextPath { edge }).as_ref());
    crate::text::build_faces(&placed)
}

/// A face bounded by one closed edge, build123d `Face(Wire.make_circle(r))`.
fn face_of_loop(edge: &Shape) -> FResult<Shape> {
    let wire = kernel::wire_from_edge(edge)?;
    Ok(kernel::face_from_wire(&wire)?)
}

/// `_faces_from_edges`: closed loops as faces turned to face +Z.
fn faces_from_edges(edges: &[Shape]) -> Vec<Shape> {
    let Ok(wires) = kernel::wires_from_edges(edges, 1e-9) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for w in wires {
        if !kernel::wire_closed(&w) {
            continue;
        }
        let Ok(face) = kernel::face_from_wire(&w) else {
            continue;
        };
        let up = match kernel::face_normal_mid(&face) {
            Some(n) if n[2] < 0.0 => kernel::reversed(&face),
            _ => face,
        };
        out.push(up);
    }
    out
}

fn fuse_all(faces: &[Shape]) -> FResult<Shape> {
    match faces {
        [] => Err(Fail::Internal("ValueError".into())),
        [one] => Ok(one.clone()),
        [first, rest @ ..] => {
            let tools: Vec<&Shape> = rest.iter().collect();
            Ok(kernel::boolean_op(first, &tools, BoolKind::Fuse)?)
        }
    }
}

/// `_build_sketch`.
pub fn build(ctx: &Ctx, f: &SketchFeature, followed: Option<Placement>) -> FResult<SketchEntry> {
    let plane_ref = match (&f.plane_id, followed) {
        (_, Some(p)) => PlaneRef::Record(p.record()),
        (Some(id), None) if !id.is_empty() => PlaneRef::Name(id),
        _ => PlaneRef::from(&f.plane),
    };
    let plane = plane_of(plane_ref, &ctx.datums)?;

    let mut items: Vec<Item> = Vec::with_capacity(f.entities.len());
    for e in &f.entities {
        items.push(resolve(ctx, e)?);
    }
    if let Some(patterns) = &f.patterns {
        let by_id: HashMap<String, usize> = items
            .iter()
            .enumerate()
            .filter_map(|(i, it)| it.id.clone().filter(|s| !s.is_empty()).map(|id| (id, i)))
            .collect();
        let mut derived = Vec::new();
        for pat in patterns {
            derived.extend(expand_pattern(ctx, pat, &by_id, &items)?);
        }
        items.extend(derived);
    }

    let mut faces: Vec<Shape> = Vec::new();
    let mut edges: Vec<Shape> = Vec::new();
    let mut all_edges: Vec<Shape> = Vec::new();
    let mut text_local: Vec<Shape> = Vec::new();
    for it in &items {
        if it.construction {
            continue;
        }
        match &it.ent {
            Ent::Circle { r, .. } if !(*r > 0.0) => {
                return Err(Fail::msg(format!(
                    "a circle in this sketch has a radius of {}, give it a radius greater than 0, or delete it",
                    py_g(*r)
                )));
            }
            Ent::Ellipse { rx, ry, .. } if !(*rx > 0.0 && *ry > 0.0) => {
                return Err(Fail::msg(
                    "an ellipse in this sketch has a zero rx or ry, give it two radii greater than 0, or delete it",
                ));
            }
            Ent::Rect { w, h, .. } if !(*w > 0.0 && *h > 0.0) => {
                return Err(Fail::msg(
                    "a rectangle in this sketch has a zero width or height, give it a size, or delete it",
                ));
            }
            _ => {}
        }
        match &it.ent {
            Ent::Rect { w, h, x, y, angle } => {
                faces.push(kernel::face_rect(*x, *y, *w, *h, *angle)?);
                all_edges.extend(entity_edges(&it.ent)?);
            }
            Ent::Circle { .. } | Ent::Ellipse { .. } => {
                let loop_edges = entity_edges(&it.ent)?;
                if let Some(e) = loop_edges.first() {
                    faces.push(face_of_loop(e)?);
                }
                all_edges.extend(loop_edges);
            }
            Ent::Line { .. }
            | Ent::Arc { .. }
            | Ent::Spline(_)
            | Ent::Bspline { .. }
            | Ent::Polygon { .. }
            | Ent::Slot { .. } => {
                for e in entity_edges(&it.ent)? {
                    edges.push(e.clone());
                    all_edges.push(e);
                }
            }
            Ent::Projected(ProjectedCurve::Circle(_)) => {
                let loop_edges = entity_edges(&it.ent)?;
                if let Some(e) = loop_edges.first() {
                    faces.push(face_of_loop(e)?);
                }
                all_edges.extend(loop_edges);
            }
            Ent::Projected(_) => {
                for e in entity_edges(&it.ent)? {
                    edges.push(e.clone());
                    all_edges.push(e);
                }
            }
            Ent::Text(t) => {
                let path = t
                    .path_ref
                    .as_ref()
                    .and_then(|r| items.iter().rev().find(|i| i.id.as_ref() == Some(r)))
                    .and_then(|i| path_edge(&i.ent));
                text_local.extend(text_faces(ctx, t, path.as_ref()));
            }
            Ent::Point { .. } | Ent::Other => {}
        }
    }

    if !edges.is_empty() {
        faces.extend(faces_from_edges(&edges));
    }
    faces.extend(text_local.iter().cloned());

    let mut located: Vec<Shape> = Vec::new();
    if !all_edges.is_empty() {
        for cell in kernel::subdivide(&all_edges) {
            let placed = plane.locate(&cell)?;
            located.extend(kernel::subshapes(&placed, Kind::Face));
        }
    }
    for tf in &text_local {
        located.extend(kernel::subshapes(&plane.locate(tf)?, Kind::Face));
    }

    let sketch = if !faces.is_empty() {
        let sk = fuse_all(&faces)?;
        let sk = plane.locate(&sk)?;
        if located.is_empty() {
            for fc in &faces {
                let placed = plane.locate(fc)?;
                located.extend(kernel::subshapes(&placed, Kind::Face));
            }
        }
        Some(sk)
    } else if !located.is_empty() {
        Some(fuse_all(&located)?)
    } else {
        None
    };
    let tool_edges = all_edges
        .iter()
        .map(|e| plane.locate(e))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SketchEntry {
        sketch,
        faces: located,
        points: hole_points(&items, &plane),
        wire: path_wire(&edges, &plane),
        plane,
        edges: tool_edges,
        face: f.face.clone(),
    })
}

/// Where a Hole drills: the sketch's points, else its circles' centres.
fn hole_points(items: &[Item], plane: &Frame) -> Vec<[f64; 3]> {
    let points: Vec<[f64; 2]> = items
        .iter()
        .filter_map(|it| match it.ent {
            Ent::Point { x, y } => Some([x, y]),
            _ => None,
        })
        .collect();
    let marks = if points.is_empty() {
        items
            .iter()
            .filter_map(|it| match it.ent {
                Ent::Circle { x, y, .. } if !it.construction => Some([x, y]),
                _ => None,
            })
            .collect()
    } else {
        points
    };
    let (o, xd, yd) = (plane.origin, plane.x, plane.y);
    marks
        .iter()
        .map(|[x, y]| std::array::from_fn(|k| o[k] + x * xd[k] + y * yd[k]))
        .collect()
}

/// Stitches fragments parted by less than a printed layer so the whole path
/// is followed, keeping the longest when the paths are genuinely separate.
const PATH_STITCH_TOL: f64 = 1e-3;

/// `_path_wire`: the free edges as one located wire, for a sweep path.
fn path_wire(edges: &[Shape], plane: &Frame) -> Option<Shape> {
    if edges.is_empty() {
        return None;
    }
    let wires = kernel::wires_from_edges(edges, PATH_STITCH_TOL).ok()?;
    let mut best: Option<(f64, &Shape)> = None;
    for w in &wires {
        let len = kernel::length(w);
        if best.map_or(true, |(b, _)| len > b) {
            best = Some((len, w));
        }
    }
    plane.locate(best?.1).ok()
}

pub fn handle(ctx: &mut Ctx, f: &SketchFeature) -> FResult {
    let followed = face_anchor_plane(ctx, &f.id, f.face.as_ref(), f.at.as_ref(), &f.plane, "Sketch");
    if let Some(p) = followed {
        ctx.sketch_planes.insert(f.id.clone(), p.wire());
    }
    let entry = build(ctx, f, followed)?;
    ctx.sketches.insert(f.id.clone(), entry);
    Ok(())
}

/// `_require_sketch`.
pub fn require<'a>(ctx: &'a Ctx, sid: &str, op: &str) -> FResult<&'a SketchEntry> {
    ctx.sketches.get(sid).ok_or_else(|| {
        crate::builder::missing_reference(format!(
            "the sketch this {op} depends on ({sid}) did not build, fix that sketch first"
        ))
    })
}

struct Cell {
    face: Shape,
    bbox: Option<[f64; 6]>,
    area: f64,
}

/// `_region_cells`: the sketch's cells cut where the model under them ends.
fn region_cells(ctx: &Ctx, entry: &SketchEntry) -> Vec<Cell> {
    let mut faces = entry.faces.clone();
    let shapes = ctx.shapes();
    if !shapes.is_empty() && !faces.is_empty() {
        let model = if shapes.len() == 1 {
            shapes[0].clone()
        } else {
            kernel::compound(shapes.iter().copied())
        };
        let scale = match kernel::bbox(&model) {
            Some(b) => {
                let d =
                    ((b[3] - b[0]).powi(2) + (b[4] - b[1]).powi(2) + (b[5] - b[2]).powi(2)).sqrt();
                if d == 0.0 {
                    1.0
                } else {
                    d
                }
            }
            None => 1.0,
        };
        faces =
            kernel::split_profile_cells(&faces, entry.plane.origin, entry.plane.z, &shapes, scale);
    }
    faces
        .into_iter()
        .map(|face| Cell {
            bbox: kernel::bbox(&face),
            area: kernel::area(&face),
            face,
        })
        .collect()
}

/// `_region_face_at`: the smallest cell containing the point, else the nearest.
fn region_face_at(cells: &[Cell], p: [f64; 3]) -> Option<Shape> {
    if cells.is_empty() {
        return None;
    }
    let mut best: Option<&Cell> = None;
    for c in cells {
        let Some(bb) = c.bbox else { continue };
        let inside = (0..3).all(|k| bb[k] - 1e-6 <= p[k] && p[k] <= bb[k + 3] + 1e-6);
        if !inside || !kernel::face_contains(&c.face, p, 1e-6) {
            continue;
        }
        if best.map_or(true, |b| c.area < b.area) {
            best = Some(c);
        }
    }
    if let Some(b) = best {
        return Some(b.face.clone());
    }
    let dist = |c: &Cell| {
        kernel::face_area_centre(&c.face).map_or(f64::INFINITY, |a| {
            ((a[1] - p[0]).powi(2) + (a[2] - p[1]).powi(2) + (a[3] - p[2]).powi(2)).sqrt()
        })
    };
    cells
        .iter()
        .min_by(|a, b| dist(a).total_cmp(&dist(b)))
        .map(|c| c.face.clone())
}

/// `_region_face_at` over `_region_cells`, for one picked point.
pub fn region_face(ctx: &Ctx, entry: &SketchEntry, p: [f64; 3]) -> Option<Shape> {
    region_face_at(&region_cells(ctx, entry), p)
}

/// `_region_target`: the selected areas united, or `None` for no selection.
pub fn region_target(ctx: &Ctx, pts: &[[f64; 3]], entry: &SketchEntry) -> FResult<Option<Shape>> {
    if pts.is_empty() {
        return Ok(None);
    }
    let cells = region_cells(ctx, entry);
    let sel: Vec<Shape> = pts
        .iter()
        .filter_map(|p| region_face_at(&cells, *p))
        .collect();
    let Some((first, rest)) = sel.split_first() else {
        return Err(Fail::msg("no profile found under the selected area"));
    };
    let mut target = first.clone();
    for s in rest {
        target = kernel::boolean_op(&target, &[s], BoolKind::Fuse)?;
    }
    Ok(Some(target))
}

/// `_entity_edges` of one entity, local to its sketch's XY, for projection.
pub fn entity_curve_edges(ctx: &Ctx, e: &SketchEntity) -> FResult<Vec<Shape>> {
    entity_edges(&resolve(ctx, e)?.ent)
}

/// A frame whose z is `normal`, for handlers that only need the direction.
pub fn frame_for_normal(origin: [f64; 3], normal: [f64; 3]) -> Frame {
    let hint = if normal[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    Frame::new(origin, hint, normal)
}
