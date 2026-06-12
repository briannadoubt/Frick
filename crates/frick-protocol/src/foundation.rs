//! The (intentionally empty) production foundation schema
//! (`packages/protocol/src/foundation.ts`).

use crate::schema::FrickSchema;

/// `foundationSchema` in TS. The hash is the hand-authored identity string —
/// see the `schema` module docs.
#[must_use]
pub fn foundation_schema() -> FrickSchema {
    FrickSchema {
        name: "frick-foundation".into(),
        schema_id: "frick-foundation".into(),
        schema_version: "0.1.0".into(),
        schema_revision: 1,
        minimum_client_revision: 1,
        minimum_server_revision: 1,
        protocol: "frick.realtime".into(),
        protocol_version: 1,
        compatibility: "greenfield-cutover".into(),
        hash: "frick-foundation-empty-0.1.0".into(),
        objects: vec![],
        streams: vec![],
        events: vec![],
        presences: vec![],
        signals: vec![],
        blobs: vec![],
        jobs: vec![],
        projections: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::foundation_schema;
    use crate::schema::validate_schema;

    #[test]
    fn foundation_schema_validates() {
        validate_schema(&foundation_schema()).unwrap();
    }
}
