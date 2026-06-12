//! Invitation store (`apps/server/src/storage/invitation-store.ts`; map 03 §5
//! and §9.9). The first half of the two-phase cross-user sharing model
//! (`packages/protocol/src/sharing.ts`): a transient, single-use token an owner
//! issues out-of-band. On successful redeem the row is stamped `redeemed_at` +
//! `redeemed_by_user_id`; the caller then mints the durable [`Grant`] in the
//! same logical operation (the routes wrap redeem+grant in a transaction —
//! `redeem` itself is NOT transactional, per the TS comment).
//!
//! Determinism: the caller supplies the `id`, opaque `token`, and all
//! timestamps (`created_at`, `expires_at`, and `now` on redeem). The store
//! never reads the system clock or a CSPRNG — every nondeterministic input
//! crosses the boundary as a parameter, exactly mirroring the TS signature
//! (`CreateInvitationArgs` already carries the id/token/timestamps).

use crate::driver::{SqlDriver, SqlRow};
use crate::error::StoreError;

/// `FrickInvitation` (`sharing.ts:25-46`). `permission` is stored as the raw
/// column string (the TS casts without validating), so the port keeps it a
/// `String` to round-trip any value byte-for-byte. `redeemed_at` /
/// `redeemed_by_user_id` are `None` when the columns are SQL NULL (the TS mapper
/// omits the keys).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    pub id: String,
    pub tenant_id: String,
    pub owner_user_id: String,
    pub record_type: String,
    pub record_id: String,
    pub permission: String,
    pub token: String,
    pub created_at: String,
    pub expires_at: String,
    pub redeemed_at: Option<String>,
    pub redeemed_by_user_id: Option<String>,
}

/// `CreateInvitationArgs` (invitation-store.ts:18-28). All identity/timestamp
/// fields are caller-supplied — the store performs no generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateInvitationArgs {
    pub id: String,
    pub tenant_id: String,
    pub owner_user_id: String,
    pub record_type: String,
    pub record_id: String,
    pub permission: String,
    pub token: String,
    pub created_at: String,
    pub expires_at: String,
}

/// `RedeemOutcome` (invitation-store.ts:30-36): the discriminated result of
/// [`InvitationStore::redeem`]. `notFound` carries no invitation; every other
/// variant returns the row the redeem inspected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedeemOutcome {
    Ok(Invitation),
    NotFound,
    Expired(Invitation),
    AlreadyRedeemed(Invitation),
    TenantMismatch(Invitation),
}

/// Arguments to [`InvitationStore::redeem`] (the TS inline object literal).
/// `now` is a caller-supplied ISO-8601 timestamp string (the route passes
/// `new Date().toISOString()`), mirroring the TS `args.now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedeemArgs<'a> {
    pub token: &'a str,
    pub tenant_id: &'a str,
    pub redeemer_user_id: &'a str,
    pub now: &'a str,
}

/// `InvitationStore` (`storage/invitation-store.ts`).
pub struct InvitationStore {
    sql: std::sync::Arc<SqlDriver>,
}

impl InvitationStore {
    #[must_use]
    pub fn new(sql: std::sync::Arc<SqlDriver>) -> Self {
        Self { sql }
    }

    /// `create` (invitation-store.ts:41-70): insert the invitation row and
    /// echo it back as a fresh (un-redeemed) [`Invitation`]. Column order is
    /// load-bearing.
    pub async fn create(&self, args: &CreateInvitationArgs) -> Result<Invitation, StoreError> {
        self.sql
            .run(
                "INSERT INTO invitations (\n            id, tenant_id, owner_user_id, record_type, record_id,\n            permission, token, created_at, expires_at\n          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    args.id.as_str().into(),
                    args.tenant_id.as_str().into(),
                    args.owner_user_id.as_str().into(),
                    args.record_type.as_str().into(),
                    args.record_id.as_str().into(),
                    args.permission.as_str().into(),
                    args.token.as_str().into(),
                    args.created_at.as_str().into(),
                    args.expires_at.as_str().into(),
                ],
            )
            .await?;
        Ok(Invitation {
            id: args.id.clone(),
            tenant_id: args.tenant_id.clone(),
            owner_user_id: args.owner_user_id.clone(),
            record_type: args.record_type.clone(),
            record_id: args.record_id.clone(),
            permission: args.permission.clone(),
            token: args.token.clone(),
            created_at: args.created_at.clone(),
            expires_at: args.expires_at.clone(),
            redeemed_at: None,
            redeemed_by_user_id: None,
        })
    }

    /// `getByToken` (invitation-store.ts:72-78): one invitation by its opaque
    /// token (a UNIQUE column), or `None`.
    pub async fn get_by_token(&self, token: &str) -> Result<Option<Invitation>, StoreError> {
        let row = self
            .sql
            .get("SELECT * FROM invitations WHERE token = ?", &[token.into()])
            .await?;
        Ok(row.as_ref().map(to_invitation))
    }

    /// `getById` (invitation-store.ts:80-86): one invitation by `(tenant_id,
    /// id)`, or `None`.
    pub async fn get_by_id(
        &self,
        tenant_id: &str,
        id: &str,
    ) -> Result<Option<Invitation>, StoreError> {
        let row = self
            .sql
            .get(
                "SELECT * FROM invitations WHERE tenant_id = ? AND id = ?",
                &[tenant_id.into(), id.into()],
            )
            .await?;
        Ok(row.as_ref().map(to_invitation))
    }

    /// `redeem` (invitation-store.ts:92-125): validate then mark redeemed. The
    /// guard order is byte-for-byte the TS: **notFound → tenantMismatch →
    /// alreadyRedeemed → expired**, then the redemption UPDATE guarded
    /// `AND redeemed_at IS NULL`. NOT transactional (the routes wrap
    /// redeem+grant in their own transaction). Returns the post-redemption
    /// invitation on [`RedeemOutcome::Ok`].
    ///
    /// The expiry check mirrors TS `Date.parse(expiresAt) <= Date.parse(now)`:
    /// both sides are canonical ISO-8601 (`iso_from_epoch_ms`), for which
    /// lexicographic order equals chronological order, so a string compare is
    /// equivalent to the timestamp compare.
    pub async fn redeem(&self, args: &RedeemArgs<'_>) -> Result<RedeemOutcome, StoreError> {
        let Some(found) = self.get_by_token(args.token).await? else {
            return Ok(RedeemOutcome::NotFound);
        };
        if found.tenant_id != args.tenant_id {
            return Ok(RedeemOutcome::TenantMismatch(found));
        }
        if found.redeemed_at.is_some() {
            return Ok(RedeemOutcome::AlreadyRedeemed(found));
        }
        if found.expires_at.as_str() <= args.now {
            return Ok(RedeemOutcome::Expired(found));
        }
        self.sql
            .run(
                "UPDATE invitations\n            SET redeemed_at = ?, redeemed_by_user_id = ?\n          WHERE id = ? AND redeemed_at IS NULL",
                &[
                    args.now.into(),
                    args.redeemer_user_id.into(),
                    found.id.as_str().into(),
                ],
            )
            .await?;
        Ok(RedeemOutcome::Ok(Invitation {
            redeemed_at: Some(args.now.to_owned()),
            redeemed_by_user_id: Some(args.redeemer_user_id.to_owned()),
            ..found
        }))
    }
}

/// `toInvitation` (invitation-store.ts:128-144): `SELECT *` row →
/// [`Invitation`]. NULL `redeemed_*` columns become `None`.
fn to_invitation(row: &SqlRow) -> Invitation {
    Invitation {
        id: row.text("id").unwrap_or_default().to_owned(),
        tenant_id: row.text("tenant_id").unwrap_or_default().to_owned(),
        owner_user_id: row.text("owner_user_id").unwrap_or_default().to_owned(),
        record_type: row.text("record_type").unwrap_or_default().to_owned(),
        record_id: row.text("record_id").unwrap_or_default().to_owned(),
        permission: row.text("permission").unwrap_or_default().to_owned(),
        token: row.text("token").unwrap_or_default().to_owned(),
        created_at: row.text("created_at").unwrap_or_default().to_owned(),
        expires_at: row.text("expires_at").unwrap_or_default().to_owned(),
        redeemed_at: row.text("redeemed_at").map(str::to_owned),
        redeemed_by_user_id: row.text("redeemed_by_user_id").map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::blob_bytes::iso_from_epoch_ms;
    use std::sync::Arc;

    // Effective post-0017 SQLite schema for `invitations` (map 03 §5).
    const SCHEMA: &str = "
        CREATE TABLE invitations (
          id TEXT PRIMARY KEY NOT NULL,
          tenant_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          record_type TEXT NOT NULL,
          record_id TEXT NOT NULL,
          permission TEXT NOT NULL,
          token TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          redeemed_at TEXT,
          redeemed_by_user_id TEXT
        );
        CREATE UNIQUE INDEX idx_invitations_token ON invitations (token);";

    const TENANT: &str = "tenant-1";
    const NOW: i64 = 1_700_000_000_123;

    async fn store() -> InvitationStore {
        let sql = Arc::new(SqlDriver::open_sqlite(":memory:").unwrap());
        sql.exec(SCHEMA).await.unwrap();
        InvitationStore::new(sql)
    }

    fn args(id: &str, token: &str, expires_ms: i64) -> CreateInvitationArgs {
        CreateInvitationArgs {
            id: id.to_owned(),
            tenant_id: TENANT.to_owned(),
            owner_user_id: "owner-1".to_owned(),
            record_type: "note".to_owned(),
            record_id: "note-1".to_owned(),
            permission: "read".to_owned(),
            token: token.to_owned(),
            created_at: iso_from_epoch_ms(NOW),
            expires_at: iso_from_epoch_ms(expires_ms),
        }
    }

    #[tokio::test]
    async fn create_round_trips_and_get_by_token_and_id() {
        let store = store().await;
        let created = store
            .create(&args("inv-1", "tok-1", NOW + 10_000))
            .await
            .unwrap();
        assert_eq!(created.id, "inv-1");
        assert_eq!(created.redeemed_at, None);
        assert_eq!(created.redeemed_by_user_id, None);

        assert_eq!(
            store.get_by_token("tok-1").await.unwrap(),
            Some(created.clone())
        );
        assert_eq!(
            store.get_by_id(TENANT, "inv-1").await.unwrap(),
            Some(created)
        );
        // Unknown token / wrong tenant ⇒ None.
        assert_eq!(store.get_by_token("nope").await.unwrap(), None);
        assert_eq!(store.get_by_id("other", "inv-1").await.unwrap(), None);
    }

    #[tokio::test]
    async fn redeem_not_found_returns_not_found() {
        let store = store().await;
        let outcome = store
            .redeem(&RedeemArgs {
                token: "ghost",
                tenant_id: TENANT,
                redeemer_user_id: "u-1",
                now: &iso_from_epoch_ms(NOW),
            })
            .await
            .unwrap();
        assert_eq!(outcome, RedeemOutcome::NotFound);
    }

    #[tokio::test]
    async fn redeem_tenant_mismatch_takes_precedence_over_expiry_and_redeemed() {
        let store = store().await;
        // Expired AND wrong tenant: tenantMismatch wins (it is checked first).
        store
            .create(&args("inv-1", "tok-1", NOW - 1_000))
            .await
            .unwrap();
        let outcome = store
            .redeem(&RedeemArgs {
                token: "tok-1",
                tenant_id: "other-tenant",
                redeemer_user_id: "u-1",
                now: &iso_from_epoch_ms(NOW),
            })
            .await
            .unwrap();
        match outcome {
            RedeemOutcome::TenantMismatch(inv) => assert_eq!(inv.id, "inv-1"),
            other => panic!("expected TenantMismatch, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn redeem_ok_marks_redeemed_and_returns_post_redemption_row() {
        let store = store().await;
        store
            .create(&args("inv-1", "tok-1", NOW + 10_000))
            .await
            .unwrap();
        let now = iso_from_epoch_ms(NOW);
        let outcome = store
            .redeem(&RedeemArgs {
                token: "tok-1",
                tenant_id: TENANT,
                redeemer_user_id: "redeemer-9",
                now: &now,
            })
            .await
            .unwrap();
        match outcome {
            RedeemOutcome::Ok(inv) => {
                assert_eq!(inv.redeemed_at, Some(now.clone()));
                assert_eq!(inv.redeemed_by_user_id, Some("redeemer-9".to_owned()));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
        // Persisted: the row is now redeemed.
        let stored = store.get_by_token("tok-1").await.unwrap().unwrap();
        assert_eq!(stored.redeemed_at, Some(now));
        assert_eq!(stored.redeemed_by_user_id, Some("redeemer-9".to_owned()));
    }

    #[tokio::test]
    async fn redeem_already_redeemed_returns_already_redeemed() {
        let store = store().await;
        store
            .create(&args("inv-1", "tok-1", NOW + 10_000))
            .await
            .unwrap();
        let first = iso_from_epoch_ms(NOW);
        store
            .redeem(&RedeemArgs {
                token: "tok-1",
                tenant_id: TENANT,
                redeemer_user_id: "u-1",
                now: &first,
            })
            .await
            .unwrap();
        // A second redeem sees redeemed_at set ⇒ alreadyRedeemed; the original
        // redeemer is preserved (the guarded UPDATE never runs again).
        let outcome = store
            .redeem(&RedeemArgs {
                token: "tok-1",
                tenant_id: TENANT,
                redeemer_user_id: "u-2",
                now: &iso_from_epoch_ms(NOW + 1),
            })
            .await
            .unwrap();
        match outcome {
            RedeemOutcome::AlreadyRedeemed(inv) => {
                assert_eq!(inv.redeemed_by_user_id, Some("u-1".to_owned()));
            }
            other => panic!("expected AlreadyRedeemed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn redeem_expired_returns_expired_when_expires_at_le_now() {
        let store = store().await;
        // expires_at == now ⇒ expired (Date.parse(expiresAt) <= Date.parse(now)).
        store.create(&args("inv-eq", "tok-eq", NOW)).await.unwrap();
        let outcome = store
            .redeem(&RedeemArgs {
                token: "tok-eq",
                tenant_id: TENANT,
                redeemer_user_id: "u-1",
                now: &iso_from_epoch_ms(NOW),
            })
            .await
            .unwrap();
        match outcome {
            RedeemOutcome::Expired(inv) => assert_eq!(inv.id, "inv-eq"),
            other => panic!("expected Expired, got {other:?}"),
        }
        // expires_at strictly after now ⇒ NOT expired.
        store
            .create(&args("inv-fut", "tok-fut", NOW + 1))
            .await
            .unwrap();
        let outcome = store
            .redeem(&RedeemArgs {
                token: "tok-fut",
                tenant_id: TENANT,
                redeemer_user_id: "u-1",
                now: &iso_from_epoch_ms(NOW),
            })
            .await
            .unwrap();
        assert!(matches!(outcome, RedeemOutcome::Ok(_)));
    }
}
