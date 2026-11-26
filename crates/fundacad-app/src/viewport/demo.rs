//! FUNDA_PUSH_DEMO=<mm> pushes a cap by itself, so a push can be timed without a hand on the mouse.
//! FUNDA_PUSH_FEATURE=<id> picks the feature, otherwise the latest pushable one in the timeline.
//! FUNDA_PUSH_PREVIEW_ONLY=1 sends nothing to the engine and holds the stretched cap for a few seconds, for screenshots.
//! FUNDA_PUSH_UNDO=1 pushes the same face a second time, then undoes once, which must bring back the first start.
//! FUNDA_PUSH_PRESS=1 press pulls a flat face whose feature does not push, with FUNDA_PUSH_UNDO the second drag edits
//! that press-pull and the one undo takes it out.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use glam::Vec3;
use gpui::{AsyncApp, WeakEntity};

use super::pick::Hit;
use super::{drag, Viewport};
use crate::plastic::{self, Grip};

const FRAME: Duration = Duration::from_millis(16);
const DRAG: Duration = Duration::from_secs(2);
const SETTLE_LIMIT: Duration = Duration::from_secs(60);
const HOLD: Duration = Duration::from_secs(4);

pub fn travel() -> Option<f64> {
    std::env::var("FUNDA_PUSH_DEMO").ok()?.parse().ok()
}

pub async fn run(this: WeakEntity<Viewport>, cx: &mut AsyncApp, travel: f64) {
    let wanted = std::env::var("FUNDA_PUSH_FEATURE").ok();
    let preview_only = std::env::var_os("FUNDA_PUSH_PREVIEW_ONLY").is_some();
    let press = std::env::var_os("FUNDA_PUSH_PRESS").is_some();
    let Some(first) = push(&this, cx, travel, wanted.as_deref(), preview_only, press).await else { return };
    if std::env::var_os("FUNDA_PUSH_UNDO").is_none() {
        return;
    }
    let again = if press { Some(first.feature.as_str()) } else { wanted.as_deref() };
    if push(&this, cx, travel, again, false, false).await.is_none() {
        return;
    }
    if this.update(cx, |v, cx| v.undo(cx)).is_err() {
        return;
    }
    let began = Instant::now();
    while began.elapsed() < SETTLE_LIMIT {
        cx.background_executor().timer(FRAME).await;
        let Ok(now) = this.update(cx, |v, _| {
            let back = match press {
                true => v.doc().is_some_and(|d| !d["features"].as_array().is_some_and(|fs| {
                    fs.iter().any(|f| f["id"].as_str() == Some(&first.feature))
                })),
                false => v.candidate(wanted.as_deref(), false).is_some_and(|(_, g)| (g.start - first.start).abs() < 1e-9),
            };
            back.then(|| v.can_undo())
        }) else {
            return;
        };
        if let Some(more) = now {
            log::info!("demo: one undo took both drags of {} back, more to undo: {more}", first.label());
            return;
        }
    }
    log::error!("demo: one undo did not take both drags of {} back", first.label());
}

/// Pushes the candidate cap by `travel` and waits for it to settle. The grip it pushed.
async fn push(
    this: &WeakEntity<Viewport>,
    cx: &mut AsyncApp,
    travel: f64,
    wanted: Option<&str>,
    preview_only: bool,
    press: bool,
) -> Option<Grip> {
    let found = loop {
        cx.background_executor().timer(FRAME).await;
        let Ok(state) = this.update(cx, |v, _| {
            (v.rebuild_ms.is_some() && v.push.is_none() && v.bounds.size.width.as_f32() > 0.0)
                .then(|| v.candidate(wanted, press))
        }) else {
            return None;
        };
        if let Some(found) = state {
            break found;
        }
    };
    let Some((hit, grip)) = found else {
        log::error!("demo: no pushable cap");
        return None;
    };
    let end = grip.value(travel as f32);
    log::info!("demo: pushing {} from {} to {end} over {} ms", grip.label(), grip.start, DRAG.as_millis());
    if !this
        .update(cx, |v, cx| {
            let ok = v.begin(hit, grip.clone(), 0.0);
            cx.notify();
            ok
        })
        .unwrap_or(false)
    {
        log::error!("demo: the cap plane was not found");
        return None;
    }
    let began = Instant::now();
    loop {
        cx.background_executor().timer(FRAME).await;
        let t = (began.elapsed().as_secs_f64() / DRAG.as_secs_f64()).min(1.0);
        let value = grip.value((travel * t) as f32);
        let sent = this.update(cx, |v, cx| match (&mut v.push, preview_only) {
            (Some(p), true) => {
                p.value = value;
                cx.notify();
            }
            _ => v.set_value(value, cx),
        });
        if sent.is_err() {
            return None;
        }
        if t >= 1.0 {
            break;
        }
    }
    if preview_only {
        log::info!("demo: holding the preview");
        cx.background_executor().timer(HOLD).await;
    }
    let released = Instant::now();
    log::info!("demo: released at {end:.1}");
    let _ = this.update(cx, |v, cx| v.release(cx));
    while released.elapsed() < SETTLE_LIMIT {
        cx.background_executor().timer(FRAME).await;
        match this.update(cx, |v, _| v.push.is_none()) {
            Ok(true) => {
                log::info!("demo: settled {} ms after release", released.elapsed().as_millis());
                return Some(grip);
            }
            Ok(false) => {}
            Err(_) => return None,
        }
    }
    log::error!("demo: not settled {} s after release", SETTLE_LIMIT.as_secs());
    None
}

impl Viewport {
    /// The pushable cap of the latest feature (or `wanted`), as a hit at its centre. With `press`, a flat face that
    /// only press pulls.
    fn candidate(&self, wanted: Option<&str>, press: bool) -> Option<(Hit, Grip)> {
        let doc = &self.session.as_ref()?.doc;
        let order: Vec<&str> = doc
            .get("features")
            .and_then(|f| f.as_array())
            .map(|fs| fs.iter().filter_map(|f| f.get("id").and_then(|i| i.as_str())).collect())
            .unwrap_or_default();
        let mut best: Option<(usize, Hit, Grip)> = None;
        let mut refused: std::collections::BTreeSet<(String, String)> = Default::default();
        for (bi, body) in self.scene.bodies.iter().enumerate() {
            let mut faces: BTreeMap<u32, (Vec3, Vec3, u32)> = BTreeMap::new();
            for v in &body.vertices {
                let e = faces.entry(v.face).or_insert((Vec3::ZERO, v.normal(), 0));
                e.0 += v.position();
                e.2 += 1;
            }
            for (face, (sum, normal, n)) in faces {
                let owner = body.owner(face);
                if wanted.is_some_and(|w| Some(w) != owner) || (!press && owner.is_none()) {
                    continue;
                }
                let point = sum / n as f32;
                let grip = match press {
                    true => plastic::pick(doc, owner, &body.source.id, normal, point, drag::flat(body, face, normal))
                        .and_then(|g| if g.adds() { Ok(g) } else { Err("it pushes, no press pull".into()) }),
                    false => plastic::grip(doc, owner.unwrap_or_default(), &body.source.id, normal, point),
                };
                let grip = match grip {
                    Ok(grip) => grip,
                    Err(why) => {
                        refused.insert((owner.unwrap_or("?").to_string(), why));
                        continue;
                    }
                };
                let rank = order.iter().position(|id| Some(*id) == owner).unwrap_or(0);
                if best.as_ref().is_none_or(|(r, ..)| rank > *r) {
                    best = Some((rank, Hit { body: bi, face, point, normal }, grip));
                }
            }
        }
        if best.is_none() {
            for (owner, why) in &refused {
                log::info!("demo: {owner}: {why}");
            }
            if let Some(m) = &self.message {
                log::info!("demo: the engine said {m}");
            }
        }
        best.map(|(_, hit, grip)| (hit, grip))
    }
}
