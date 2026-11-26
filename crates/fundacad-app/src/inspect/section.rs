//! Section View and Isolate, FundaCAD 1's sectionMath.ts and isolate: a plane that keeps one side of the model, and
//! the bodies a view keeps.

use std::sync::Arc;

use glam::Vec3;
use serde_json::{json, Map, Value};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Section {
    pub normal: Vec3,
    pub offset: f32,
    /// Where the plane was armed, along `normal`. The readout and the file count `offset` from it.
    pub anchor: f32,
    /// Keeps the half along `normal`, FundaCAD 1's side +1 and its default.
    pub flip: bool,
}

impl Section {
    /// A cut across `axis` (0 X, 1 Y, 2 Z) through `centre`.
    pub fn along(axis: usize, centre: Vec3) -> Self {
        Self::armed(Vec3::AXES[axis.min(2)], centre)
    }

    pub fn on_face(point: Vec3, normal: Vec3) -> Option<Self> {
        Some(Self::armed(normal.try_normalize()?, point))
    }

    fn armed(normal: Vec3, at: Vec3) -> Self {
        let anchor = at.dot(normal);
        Self { normal, offset: anchor, anchor, flip: true }
    }

    /// How far the plane slid from where it was armed.
    pub fn slide(&self) -> f32 {
        self.offset - self.anchor
    }

    /// The plane as the shader takes it: the points p with n.p <= w are kept.
    pub fn plane(&self) -> [f32; 4] {
        let s = if self.flip { -1.0 } else { 1.0 };
        let n = self.normal * s;
        [n.x, n.y, n.z, self.offset * s]
    }

    pub fn keeps(&self, p: Vec3) -> bool {
        let [x, y, z, w] = self.plane();
        Vec3::new(x, y, z).dot(p) <= w + 1e-4
    }

    pub fn axis(&self) -> &'static str {
        match Vec3::AXES.iter().position(|a| a.abs_diff_eq(self.normal, 1e-6)) {
            Some(0) => "X",
            Some(1) => "Y",
            Some(2) => "Z",
            _ => "Face",
        }
    }
}

/// The key FundaCAD 1 saved its cut under: a plane through `origin` slid `offset` along the unit `normal`, keeping the
/// `side` (+1 or -1) of the normal.
pub const KEY: &str = "sectionView";

/// The cut a document was saved with. A bad one reads as none.
pub fn read(doc: &Map<String, Value>) -> Option<Section> {
    let raw = doc.get(KEY)?.as_object()?;
    let vec = |k: &str| -> Option<Vec3> {
        let a = raw.get(k)?.as_array()?;
        let c: Vec<f32> = a.iter().map(|c| c.as_f64().filter(|c| c.is_finite()).map(|c| c as f32)).collect::<Option<_>>()?;
        (c.len() == 3).then(|| Vec3::new(c[0], c[1], c[2]))
    };
    let normal = vec("normal")?.try_normalize()?;
    let slide = raw.get("offset").and_then(Value::as_f64).filter(|o| o.is_finite()).unwrap_or(0.0) as f32;
    let anchor = vec("origin")?.dot(normal);
    let flip = raw.get("side").and_then(Value::as_i64) != Some(-1);
    Some(Section { normal, offset: anchor + slide, anchor, flip })
}

/// Saves `section` on `doc`, keeping the fields of a saved cut this build does not read, or drops it when None.
pub fn write(doc: &mut Map<String, Value>, section: Option<&Section>) {
    let Some(s) = section else {
        doc.remove(KEY);
        return;
    };
    let mut raw = doc.get(KEY).and_then(Value::as_object).cloned().unwrap_or_default();
    let at = s.normal * s.anchor;
    raw.insert("origin".into(), json!([at.x, at.y, at.z]));
    raw.insert("normal".into(), json!([s.normal.x, s.normal.y, s.normal.z]));
    raw.insert("offset".into(), json!(s.slide()));
    raw.insert("side".into(), json!(if s.flip { 1 } else { -1 }));
    raw.entry("ghost").or_insert_with(|| json!("soft"));
    doc.insert(KEY.into(), Value::Object(raw));
}

/// `doc` with `cut` written in, borrowed while it already holds that cut, so Files sees a changed cut as unsaved.
pub fn for_save<'a>(doc: &'a Map<String, Value>, cut: Option<&Section>) -> std::borrow::Cow<'a, Map<String, Value>> {
    if read(doc).as_ref() == cut {
        return std::borrow::Cow::Borrowed(doc);
    }
    let mut doc = doc.clone();
    write(&mut doc, cut);
    std::borrow::Cow::Owned(doc)
}

/// A round step for nudging a plane through a model of `radius`: 1, 2 or 5 times a power of ten, near a tenth of it.
pub fn step(radius: f32) -> f32 {
    let r = (radius / 10.0).max(1e-3);
    let p = 10f32.powf(r.log10().floor());
    [1.0, 2.0, 5.0, 10.0].into_iter().map(|m| m * p).find(|s| *s >= r * 0.75).unwrap_or(10.0 * p)
}

/// The bodies Isolate keeps. Every body when it keeps none of them, so a stale list never empties the view.
pub fn isolated<B: AsRef<str>>(bodies: Vec<Arc<crate::viewport::scene::Body>>, keep: Option<&[B]>) -> Vec<Arc<crate::viewport::scene::Body>> {
    let Some(keep) = keep else { return bodies };
    let kept: Vec<_> = bodies.iter().filter(|b| keep.iter().any(|k| k.as_ref() == b.id)).cloned().collect();
    if kept.is_empty() {
        bodies
    } else {
        kept
    }
}
