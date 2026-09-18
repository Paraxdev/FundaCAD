//! Scalars and the open building blocks every schema type is made of.
//! Mirrors `Num`, `Vec3` and the string unions of `src/types.ts`.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Number, Value};

/// Unknown keys of an open object, kept verbatim for the next save.
pub type Extra = Map<String, Value>;

/// A JSON number kept exactly as it was read. `5` and `5.0` are different
/// documents to a byte comparison, and Python writes the second where the app
/// writes the first, so the integer or float spelling survives a round trip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Real(pub Number);

impl Real {
    pub fn get(&self) -> f64 {
        self.0.as_f64().unwrap_or(f64::NAN)
    }

    pub fn as_i64(&self) -> Option<i64> {
        self.0.as_i64()
    }

    /// `None` for NaN and the infinities, which JSON cannot hold.
    pub fn from_f64(v: f64) -> Option<Self> {
        if v.fract() == 0.0 && v.abs() < 9.0e15 {
            #[allow(clippy::cast_possible_truncation)]
            return Some(Real(Number::from(v as i64)));
        }
        Number::from_f64(v).map(Real)
    }
}

impl From<i64> for Real {
    fn from(v: i64) -> Self {
        Real(Number::from(v))
    }
}

pub type Vec3 = [Real; 3];

/// A numeric field that may name a parameter instead: `number | string` in TS.
/// The string is a parameter name on the legacy path; the app evaluates
/// expressions before a build, so the engine resolves names only
/// (the Python engine's `handler_util.py` `_make_val`).
#[derive(Debug, Clone, PartialEq)]
pub enum Num {
    Number(Real),
    Expr(String),
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("unresolved parameter or expression \"{0}\", expected a number (expressions are evaluated by the app before building)")]
pub struct UnresolvedNum(pub String);

impl Num {
    /// The value, a parameter name looked up in `params`. Any other string is
    /// an error, never a guess, exactly as the Python builder refuses it.
    pub fn resolve<'a>(
        &self,
        params: impl Fn(&str) -> Option<f64> + 'a,
    ) -> Result<f64, UnresolvedNum> {
        match self {
            Num::Number(r) => Ok(r.get()),
            Num::Expr(name) => params(name).ok_or_else(|| UnresolvedNum(name.clone())),
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Num::Number(r) => Some(r.get()),
            Num::Expr(_) => None,
        }
    }
}

impl From<f64> for Num {
    fn from(v: f64) -> Self {
        Real::from_f64(v).map_or_else(|| Num::Expr(v.to_string()), Num::Number)
    }
}

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Num::Number(r) => r.serialize(s),
            Num::Expr(e) => e.serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match Value::deserialize(d)? {
            Value::Number(n) => Ok(Num::Number(Real(n))),
            Value::String(s) => Ok(Num::Expr(s)),
            other => Err(D::Error::custom(format!(
                "expected a number or a parameter name, got {other}"
            ))),
        }
    }
}

/// `T | T[]`, as selector fields are typed.
#[derive(Debug, Clone, PartialEq)]
pub enum OneOrMany<T> {
    One(T),
    Many(Vec<T>),
}

impl<T> OneOrMany<T> {
    pub fn as_slice(&self) -> &[T] {
        match self {
            OneOrMany::One(t) => std::slice::from_ref(t),
            OneOrMany::Many(v) => v,
        }
    }
}

impl<T: Serialize> Serialize for OneOrMany<T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            OneOrMany::One(t) => t.serialize(s),
            OneOrMany::Many(v) => v.serialize(s),
        }
    }
}

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for OneOrMany<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match Value::deserialize(d)? {
            Value::Array(items) => items
                .into_iter()
                .map(serde_json::from_value)
                .collect::<Result<Vec<T>, _>>()
                .map(OneOrMany::Many)
                .map_err(D::Error::custom),
            v => serde_json::from_value(v)
                .map(OneOrMany::One)
                .map_err(D::Error::custom),
        }
    }
}

/// `field?: T | null`: absent and `null` are different documents.
pub mod nullable {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    #[allow(clippy::option_option)]
    pub fn serialize<S: Serializer, T: Serialize>(
        v: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match v {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(),
        }
    }

    #[allow(clippy::option_option)]
    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

/// A closed string union of `types.ts` that still opens a document written by
/// a newer build or a hand-edited corpus: an unlisted spelling is kept as
/// `Other` and written back unchanged.
macro_rules! open_enum {
    ($(#[$meta:meta])* $vis:vis enum $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        $vis enum $name {
            $($variant,)+
            Other(String),
        }

        impl $name {
            pub fn as_str(&self) -> &str {
                match self {
                    $($name::$variant => $text,)+
                    $name::Other(s) => s,
                }
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                match s {
                    $($text => $name::$variant,)+
                    other => $name::Other(other.to_owned()),
                }
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                Ok($name::from(s.as_str()))
            }
        }
    };
}
pub(crate) use open_enum;

/// A member of a known form that does not fit it: a required field missing, a
/// value of the wrong type. The Python engine loads such a document and fails
/// that one feature with a message, so the document must load here too; the
/// raw object is written back as it was and `error` says what did not fit.
#[derive(Debug, Clone, PartialEq)]
pub struct Invalid {
    pub error: String,
    pub raw: Value,
}

/// An object union discriminated by one string key (`type` or `kind`). Known
/// tags deserialize into their struct, whose `extra` keeps unknown keys; an
/// unknown tag (a plugin's feature, an entity from a newer build) is kept whole
/// as `Unknown`, and a known tag that does not fit its struct as `Invalid`.
macro_rules! tagged_enum {
    (
        $(#[$meta:meta])* $vis:vis enum $name:ident, tag = $tag:literal, first = [$($first:literal),*] {
            $($variant:ident($ty:ty) = $text:literal),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq)]
        #[allow(clippy::large_enum_variant)]
        $vis enum $name {
            $($variant($ty),)+
            Unknown(serde_json::Value),
            Invalid($crate::schema::value::Invalid),
        }

        impl $name {
            pub const KNOWN: &'static [&'static str] = &[$($text),+];

            /// The tag as written in the document, for known and unknown alike.
            pub fn type_name(&self) -> Option<&str> {
                match self {
                    $($name::$variant(_) => Some($text),)+
                    $name::Unknown(v) => v.get($tag).and_then(serde_json::Value::as_str),
                    $name::Invalid(i) => i.raw.get($tag).and_then(serde_json::Value::as_str),
                }
            }

            pub fn is_unknown(&self) -> bool {
                matches!(self, $name::Unknown(_))
            }

            pub fn is_invalid(&self) -> bool {
                matches!(self, $name::Invalid(_))
            }

            /// The object as written, for `Unknown` and `Invalid`.
            pub fn raw(&self) -> Option<&serde_json::Value> {
                match self {
                    $name::Unknown(v) => Some(v),
                    $name::Invalid(i) => Some(&i.raw),
                    _ => None,
                }
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                use serde::ser::Error as _;
                let (text, body) = match self {
                    $($name::$variant(inner) => ($text, serde_json::to_value(inner).map_err(S::Error::custom)?),)+
                    $name::Unknown(v) => return v.serialize(s),
                    $name::Invalid(i) => return i.raw.serialize(s),
                };
                $crate::schema::value::with_tag(body, $tag, text, &[$($first),*]).serialize(s)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let raw = serde_json::Value::deserialize(d)?;
                let tag = raw.get($tag).and_then(serde_json::Value::as_str).map(str::to_owned);
                match tag.as_deref() {
                    $(Some($text) => {
                        let mut body = raw.clone();
                        if let Some(m) = body.as_object_mut() {
                            m.shift_remove($tag);
                        }
                        Ok(match serde_json::from_value::<$ty>(body) {
                            Ok(t) => $name::$variant(t),
                            Err(e) => $name::Invalid($crate::schema::value::Invalid { error: e.to_string(), raw }),
                        })
                    })+
                    _ => Ok($name::Unknown(raw)),
                }
            }
        }
    };
}
pub(crate) use tagged_enum;

/// The struct's keys with the tag put back, after the `first` keys so a saved
/// feature still reads `{"id", "type", ...}`.
pub(crate) fn with_tag(body: Value, tag: &str, text: &str, first: &[&str]) -> Value {
    let Value::Object(mut body) = body else {
        return body;
    };
    let mut out = Map::with_capacity(body.len() + 1);
    for key in first {
        if let Some(v) = body.shift_remove(*key) {
            out.insert((*key).to_owned(), v);
        }
    }
    out.insert(tag.to_owned(), Value::String(text.to_owned()));
    out.extend(body);
    Value::Object(out)
}
