//! Dynamic msgpack values and helpers shared across the protocol surface.
//!
//! TypeScript's `PlainObject` (`Record<string, unknown>`) maps to
//! [`rmpv::Value`] here: an insertion-ordered msgpack map. Order matters —
//! msgpack maps are encoded in insertion order on both sides, and the golden
//! fixtures pin exact bytes.
//!
//! Accepted origination-side deviation: JS objects hoist canonical-integer
//! keys first in ascending numeric order (`{"10":1,"2":2}` encodes as
//! `"2","10"`), and JS treats `-0` as the safe integer `0`. Rust maps keep
//! literal insertion order and `Value::F64(-0.0)` would encode as a float.
//! Frames *decoded* from TS bytes re-encode faithfully either way (the bytes
//! are already hoisted); only Rust-*originated* frames with integer-like
//! string keys or negative-zero floats can diverge. Don't construct those.

pub use rmpv::Value;

use serde::Serialize;

/// Serialize any value to a dynamic msgpack [`Value`] (structs become maps
/// keyed by field name, in declaration order).
///
/// Routed through the named rmp-serde serializer rather than
/// `rmpv::ext::to_value`, which would encode structs as positional arrays.
pub fn to_value<T: Serialize>(value: &T) -> Result<Value, crate::errors::ProtocolError> {
    let mut bytes = Vec::new();
    let mut serializer = rmp_serde::Serializer::new(&mut bytes).with_struct_map();
    value
        .serialize(&mut serializer)
        .map_err(|err| crate::errors::ProtocolError::new(format!("value conversion: {err}")))?;
    rmpv::decode::read_value(&mut bytes.as_slice())
        .map_err(|err| crate::errors::ProtocolError::new(format!("value conversion: {err}")))
}

/// Recursively sort every map in `value` by key, mirroring the TS
/// `stableClone` normalization in `packages/protocol/src/schema.ts` (which
/// sorts with JS `Array.prototype.sort`, i.e. UTF-16 code-unit order — for
/// the ASCII keys schemas use, plain byte order is identical). `undefined`
/// dropping has no Rust counterpart: absent optionals are already absent.
#[must_use]
pub fn stable_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(stable_value).collect()),
        Value::Map(entries) => {
            let mut sorted: Vec<(Value, Value)> = entries
                .iter()
                .map(|(key, entry)| (key.clone(), stable_value(entry)))
                .collect();
            sorted.sort_by(|(a, _), (b, _)| {
                let a = a.as_str().unwrap_or_default();
                let b = b.as_str().unwrap_or_default();
                a.encode_utf16().cmp(b.encode_utf16())
            });
            Value::Map(sorted)
        }
        other => other.clone(),
    }
}

/// Declare a fieldless enum that crosses the wire as one of a fixed set of
/// strings (the msgpack `str` format), exactly as the TS string-literal
/// union types do. Generates `as_str`, `Display`, `FromStr`, and serde
/// implementations that serialize the bare string.
macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $($(#[$vmeta:meta])* $variant:ident => $text:literal),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        $vis enum $name {
            $($(#[$vmeta])* $variant),+
        }

        impl $name {
            /// Every value, in declaration order.
            $vis const ALL: &'static [Self] = &[$(Self::$variant),+];

            /// The exact wire string for this value.
            #[must_use]
            $vis const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }
        }

        impl core::fmt::Display for $name {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl core::str::FromStr for $name {
            type Err = crate::errors::ProtocolError;

            fn from_str(text: &str) -> core::result::Result<Self, Self::Err> {
                match text {
                    $($text => Ok(Self::$variant),)+
                    other => Err(crate::errors::ProtocolError::new(format!(
                        concat!("Unknown ", stringify!($name), ": {}"),
                        other
                    ))),
                }
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> core::result::Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> core::result::Result<Self, D::Error> {
                struct StrVisitor;

                impl serde::de::Visitor<'_> for StrVisitor {
                    type Value = $name;

                    fn expecting(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                        write!(f, "one of the {} wire strings", stringify!($name))
                    }

                    fn visit_str<E: serde::de::Error>(self, text: &str) -> core::result::Result<$name, E> {
                        text.parse()
                            .map_err(|_| E::unknown_variant(text, &[$($text),+]))
                    }
                }

                deserializer.deserialize_str(StrVisitor)
            }
        }
    };
}

pub(crate) use string_enum;

#[cfg(test)]
mod tests {
    use super::{Value, stable_value};

    #[test]
    fn stable_value_sorts_by_utf16_code_units_like_js() {
        // JS Array.prototype.sort compares UTF-16 code units: U+10000
        // (surrogate pair D800 DC00) sorts BEFORE U+FF01 (a single FF01
        // unit), while plain UTF-8 byte order would put U+FF01 (EF BC 81)
        // before U+10000 (F0 90 80 80).
        let value = Value::Map(vec![
            ("\u{FF01}x".into(), Value::from(1)),
            ("\u{10000}x".into(), Value::from(2)),
        ]);
        let Value::Map(entries) = stable_value(&value) else {
            panic!("expected map")
        };
        assert_eq!(entries[0].0.as_str(), Some("\u{10000}x"));
        assert_eq!(entries[1].0.as_str(), Some("\u{FF01}x"));
    }

    #[test]
    fn stable_value_sorts_nested_maps() {
        let value = Value::Map(vec![
            ("b".into(), Value::from(1)),
            (
                "a".into(),
                Value::Map(vec![
                    ("z".into(), Value::from(2)),
                    ("y".into(), Value::from(3)),
                ]),
            ),
        ]);
        let stable = stable_value(&value);
        let Value::Map(entries) = &stable else {
            panic!("expected map")
        };
        assert_eq!(entries[0].0.as_str(), Some("a"));
        let Value::Map(inner) = &entries[0].1 else {
            panic!("expected inner map")
        };
        assert_eq!(inner[0].0.as_str(), Some("y"));
    }
}
