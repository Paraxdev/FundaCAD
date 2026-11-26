//! FUNDA_PUSH_DEMO=<mm> pushes a cap by itself, so a push can be timed without a hand on the mouse.
//! FUNDA_PUSH_FEATURE=<id> picks the feature, otherwise the latest pushable one in the timeline.
//! FUNDA_PUSH_PREVIEW_ONLY=1 sends nothing to the engine and holds the stretched cap for a few seconds, for screenshots.
//! FUNDA_PUSH_UNDO=1 pushes the same face a second time, then undoes once, which must bring back the first start.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use glam::Vec3;
use gpui::{AsyncApp, WeakEntity};

use super::pick::Hit;
use super::Viewport;
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
    let Some(first) = push(&this, cx, travel, wanted.as_deref(), preview_only).await else { return };
    if std::env::var_os("FUNDA_PUSH_UNDO").is_none() {
        return;
    }
    if push(&this, cx, travel, wanted.as_deref(), false).await.is_none() {
        return;
    }
    if this.update(cx, |v, cx| v.undo(cx)).is_err() {
        return;
    }
    let began = Instant::now();
    while began.elapsed() < SETTLE_LIMIT {
        cx.background_executor().timer(FRAME).await;
        let Ok(now) = this.update(cx, |v, _| v.candidate(wanted.as_deref()).map(|(_, g)| (g.start, v.can_undo())))
        else {
            return;
        };
        if let Some((start, more)) = now.filter(|(s, _)| (s - first).abs() < 1e-9) {
            log::info!("demo: one undo brought both pushes back to {start}, more to undo: {more}");
            return;
        }
    }
    log::error!("demo: one undo did not bring back {first}");
}

/// Pushes the candidate cap by `travel` and waits for it to settle. The value it started from.
async fn push(
    this: &WeakEntity<Viewport>,
    cx: &mut AsyncApp,
    travel: f64,
    wanted: Option<&str>,
    preview_only: bool,
) -> Option<f64> {
    let found = loop {
        cx.background_executor().timer(FRAME).await;
        let Ok(state) = this.update(cx, |v, _| {
            (v.rebuild_ms.is_some() && v.push.is_none() && v.bounds.size.width.as_f32() > 0.0)
                .then(|| v.candidate(wanted))
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
    let start = grip.start;
    let end = grip.value(travel as f32);
    log::info!("demo: pushing {} from {start} to {end} over {} ms", grip.label(), DRAG.as_millis());
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
                return Some(start);
            }
            Ok(false) => {}
            Err(_) => return None,
        }
    }
    log::error!("demo: not settled {} s after release", SETTLE_LIMIT.as_secs());
    None
}

impl Viewport {
    /// The pushable cap of the latest feature (or `wanted`), as a hit at its centre.
    fn candidate(&self, wanted: Option<&str>) -> Option<(Hit, Grip)> {
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
                let Some(owner) = body.owner(face) else { continue };
                if wanted.is_some_and(|w| w != owner) {
                    continue;
                }
                let point = sum / n as f32;
                let grip = match plastic::grip(doc, owner, &body.source.id, normal, point) {
                    Ok(grip) => grip,
                    Err(why) => {
                        refused.insert((owner.to_string(), why));
                        continue;
                    }
                };
                let rank = order.iter().position(|id| *id == owner).unwrap_or(0);
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
