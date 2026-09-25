//! Edge and face selectors and their fingerprints, `Selector` in `src/types.ts`
//! (resolved by the Python engine's `geom_select.py`).

use serde::ser::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use super::value::{open_enum, Extra, Invalid, Real, Vec3};

open_enum! {
    pub enum Axis3 { X = "X", Y = "Y", Z = "Z" }
}

open_enum! {
    pub enum CurveKind { Line = "line", Circle = "circle", Ellipse = "ellipse", Bspline = "bspline", Unclassified = "other" }
}

open_enum! {
    pub enum SurfaceKind {
        Plane = "plane", Cylinder = "cylinder", Cone = "cone", Sphere = "sphere",
        Torus = "torus", Bspline = "bspline", Unclassified = "other",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeFingerprint {
    pub mid: Vec3,
    pub dir: Vec3,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<Real>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve: Option<CurveKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<Real>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<Vec3>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceFingerprint {
    pub centroid: Vec3,
    pub normal: Vec3,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<Real>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<SurfaceKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<Real>,
    #[serde(flatten)]
    pub extra: Extra,
}

/// The face an `ofFace` edge selector takes the edges of: a fingerprint, or any
/// face selector resolved against the same body.
#[derive(Debug, Clone, PartialEq)]
pub enum FaceRef {
    Fingerprint(FaceFingerprint),
    Selector(Box<Selector>),
}

impl<'de> Deserialize<'de> for FaceRef {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let v = Value::deserialize(d)?;
        if v.get("by").is_none() {
            return serde_json::from_value(v)
                .map(FaceRef::Fingerprint)
                .map_err(D::Error::custom);
        }
        let s: Selector = serde_json::from_value(v).map_err(D::Error::custom)?;
        match (&s, s.kind()) {
            (Selector::Invalid(inv), _) => Err(D::Error::custom(&inv.error)),
            (_, Some("face")) => Ok(FaceRef::Selector(Box::new(s))),
            (_, kind) => Err(D::Error::custom(format!(
                "`face` takes a face selector, not a {} selector",
                kind.unwrap_or("kindless")
            ))),
        }
    }
}

impl Serialize for FaceRef {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            FaceRef::Fingerprint(fp) => fp.serialize(s),
            FaceRef::Selector(sel) => sel.serialize(s),
        }
    }
}

/// The shape of a selector past its `kind` and `by`.
#[derive(Debug, Clone, PartialEq)]
pub enum SelectorBy {
    EdgeAxis {
        axis: Axis3,
    },
    EdgeNearest {
        point: Vec3,
    },
    EdgeAll,
    FaceNormal {
        dir: Vec3,
    },
    FaceNearest {
        point: Vec3,
    },
    /// A flat face kept by its outward normal, which follows it wherever a
    /// change upstream moves it. `center` is its outline's centre when this
    /// was written, how far a feature placed on it has moved with it.
    FaceTracked {
        point: Vec3,
        normal: Vec3,
        center: Option<Vec3>,
    },
    EdgeMatch {
        fp: EdgeFingerprint,
        nth: Option<Real>,
    },
    FaceMatch {
        fp: FaceFingerprint,
        nth: Option<Real>,
    },
    EdgeTangentChain {
        seed: EdgeFingerprint,
    },
    EdgeOfFace {
        face: FaceRef,
    },
}

/// A known selector form, plus the body it resolves against and any keys this
/// build does not know.
#[derive(Debug, Clone, PartialEq)]
pub struct KnownSelector {
    pub by: SelectorBy,
    /// Absent means the active body, kept only for old documents.
    pub body: Option<String>,
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum Selector {
    Known(KnownSelector),
    /// A `kind`/`by` pair this build does not know (a plugin's `{by: "all"}`
    /// face set, a newer form), kept whole.
    Unknown(Value),
    /// A known form missing what it needs, kept as written.
    Invalid(Invalid),
}

impl Selector {
    pub fn kind(&self) -> Option<&str> {
        match self {
            Selector::Known(k) => Some(match k.by {
                SelectorBy::EdgeAxis { .. }
                | SelectorBy::EdgeNearest { .. }
                | SelectorBy::EdgeAll
                | SelectorBy::EdgeMatch { .. }
                | SelectorBy::EdgeTangentChain { .. }
                | SelectorBy::EdgeOfFace { .. } => "edge",
                _ => "face",
            }),
            Selector::Unknown(v) | Selector::Invalid(Invalid { raw: v, .. }) => {
                v.get("kind").and_then(Value::as_str)
            }
        }
    }

    pub fn by(&self) -> Option<&str> {
        match self {
            Selector::Known(k) => Some(match k.by {
                SelectorBy::EdgeAxis { .. } => "axis",
                SelectorBy::EdgeNearest { .. } | SelectorBy::FaceNearest { .. } => "nearest",
                SelectorBy::EdgeAll => "all",
                SelectorBy::FaceNormal { .. } => "normal",
                SelectorBy::FaceTracked { .. } => "tracked",
                SelectorBy::EdgeMatch { .. } | SelectorBy::FaceMatch { .. } => "match",
                SelectorBy::EdgeTangentChain { .. } => "tangentChain",
                SelectorBy::EdgeOfFace { .. } => "ofFace",
            }),
            Selector::Unknown(v) | Selector::Invalid(Invalid { raw: v, .. }) => {
                v.get("by").and_then(Value::as_str)
            }
        }
    }

    pub fn body(&self) -> Option<&str> {
        match self {
            Selector::Known(k) => k.body.as_deref(),
            Selector::Unknown(v) | Selector::Invalid(Invalid { raw: v, .. }) => {
                v.get("body").and_then(Value::as_str)
            }
        }
    }
}

fn take<T: serde::de::DeserializeOwned>(
    m: &mut Extra,
    key: &str,
) -> Result<Option<T>, serde_json::Error> {
    m.shift_remove(key).map(serde_json::from_value).transpose()
}

fn need<T: serde::de::DeserializeOwned>(m: &mut Extra, key: &str) -> Result<T, serde_json::Error> {
    take(m, key)?.ok_or_else(|| {
        <serde_json::Error as serde::de::Error>::custom(format!("missing field `{key}`"))
    })
}

fn parse_known(
    kind: &str,
    by: &str,
    m: &mut Extra,
) -> Result<Option<SelectorBy>, serde_json::Error> {
    Ok(Some(match (kind, by) {
        ("edge", "axis") => SelectorBy::EdgeAxis {
            axis: need(m, "axis")?,
        },
        ("edge", "nearest") => SelectorBy::EdgeNearest {
            point: need(m, "point")?,
        },
        ("edge", "all") => SelectorBy::EdgeAll,
        ("face", "normal") => SelectorBy::FaceNormal {
            dir: need(m, "dir")?,
        },
        ("face", "nearest") => SelectorBy::FaceNearest {
            point: need(m, "point")?,
        },
        ("edge", "match") => SelectorBy::EdgeMatch {
            fp: need(m, "fp")?,
            nth: take(m, "nth")?,
        },
        ("face", "tracked") => SelectorBy::FaceTracked {
            point: need(m, "point")?,
            normal: need(m, "normal")?,
            center: take(m, "center")?,
        },
        ("face", "match") => SelectorBy::FaceMatch {
            fp: need(m, "fp")?,
            nth: take(m, "nth")?,
        },
        ("edge", "tangentChain") => SelectorBy::EdgeTangentChain {
            seed: need(m, "seed")?,
        },
        ("edge", "ofFace") => SelectorBy::EdgeOfFace {
            face: need(m, "face")?,
        },
        _ => return Ok(None),
    }))
}

impl<'de> Deserialize<'de> for Selector {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        let (Some(kind), Some(by)) = (
            v.get("kind").and_then(Value::as_str).map(str::to_owned),
            v.get("by").and_then(Value::as_str).map(str::to_owned),
        ) else {
            return Ok(Selector::Unknown(v));
        };
        let Value::Object(mut m) = v.clone() else {
            return Ok(Selector::Unknown(v));
        };
        m.shift_remove("kind");
        m.shift_remove("by");
        let parsed = parse_known(&kind, &by, &mut m).and_then(|by_form| {
            let body = take::<String>(&mut m, "body")?;
            Ok(by_form.map(|by_form| (by_form, body)))
        });
        Ok(match parsed {
            Ok(Some((by, body))) => Selector::Known(KnownSelector { by, body, extra: m }),
            Ok(None) => Selector::Unknown(v),
            Err(e) => Selector::Invalid(Invalid {
                error: format!("selector {kind} by {by}: {e}"),
                raw: v,
            }),
        })
    }
}

impl Serialize for Selector {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let k = match self {
            Selector::Unknown(v) | Selector::Invalid(Invalid { raw: v, .. }) => {
                return v.serialize(s)
            }
            Selector::Known(k) => k,
        };
        let mut m = Extra::new();
        let mut put = |key: &str, v: Result<Value, serde_json::Error>| -> Result<(), S::Error> {
            m.insert(key.to_owned(), v.map_err(S::Error::custom)?);
            Ok(())
        };
        put("kind", Ok(Value::from(self.kind().unwrap_or_default())))?;
        put("by", Ok(Value::from(self.by().unwrap_or_default())))?;
        match &k.by {
            SelectorBy::EdgeAxis { axis } => put("axis", serde_json::to_value(axis))?,
            SelectorBy::EdgeNearest { point } | SelectorBy::FaceNearest { point } => {
                put("point", serde_json::to_value(point))?;
            }
            SelectorBy::EdgeAll => {}
            SelectorBy::FaceNormal { dir } => put("dir", serde_json::to_value(dir))?,
            SelectorBy::FaceTracked { point, normal, center } => {
                put("point", serde_json::to_value(point))?;
                put("normal", serde_json::to_value(normal))?;
                if let Some(c) = center {
                    put("center", serde_json::to_value(c))?;
                }
            }
            SelectorBy::EdgeMatch { fp, nth } => {
                put("fp", serde_json::to_value(fp))?;
                if let Some(n) = nth {
                    put("nth", serde_json::to_value(n))?;
                }
            }
            SelectorBy::FaceMatch { fp, nth } => {
                put("fp", serde_json::to_value(fp))?;
                if let Some(n) = nth {
                    put("nth", serde_json::to_value(n))?;
                }
            }
            SelectorBy::EdgeTangentChain { seed } => put("seed", serde_json::to_value(seed))?,
            SelectorBy::EdgeOfFace { face } => put("face", serde_json::to_value(face))?,
        }
        if let Some(b) = &k.body {
            put("body", Ok(Value::from(b.as_str())))?;
        }
        for (key, v) in &k.extra {
            m.insert(key.clone(), v.clone());
        }
        m.serialize(s)
    }
}
