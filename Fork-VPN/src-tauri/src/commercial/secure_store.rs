use super::PRODUCT_NAME;
use super::auth::AuthSession;
use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};

const SERVICE_NAME: &str = "ForkVPN";
const ACCOUNT_NAME: &str = "commercial_session";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    token: String,
    user_id: String,
    username: String,
    plan: String,
    expire_at: i64,
    status: String,
    product_name: String,
    issued_at: i64,
    #[serde(default)]
    access_key: String,
}

impl From<&AuthSession> for StoredSession {
    fn from(session: &AuthSession) -> Self {
        StoredSession {
            token: session.token.to_string(),
            user_id: session.user_id.to_string(),
            username: session.username.to_string(),
            plan: session.plan.to_string(),
            expire_at: session.expire_at,
            status: session.status.to_string(),
            product_name: session.product_name.to_string(),
            issued_at: session.issued_at,
            access_key: session.access_key.to_string(),
        }
    }
}

impl From<StoredSession> for AuthSession {
    fn from(stored: StoredSession) -> Self {
        AuthSession {
            token: stored.token.into(),
            user_id: stored.user_id.into(),
            username: stored.username.into(),
            plan: stored.plan.into(),
            expire_at: stored.expire_at,
            status: stored.status.into(),
            product_name: stored.product_name.into(),
            issued_at: stored.issued_at,
            access_key: stored.access_key.into(),
        }
    }
}

fn service_name() -> String {
    format!("{SERVICE_NAME}-{PRODUCT_NAME}")
}

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(&service_name(), ACCOUNT_NAME).context("credential store entry")
}

pub async fn save_session(session: &AuthSession) -> Result<()> {
    let payload = serde_json::to_string(&StoredSession::from(session))?;
    let entry = entry()?;
    tokio::task::spawn_blocking(move || entry.set_password(&payload))
        .await
        .context("join credential write")?
        .context("write session to credential store")
}

pub async fn delete_session() -> Result<()> {
    let entry = entry()?;
    // Ignore "no entry" errors.
    let _ = tokio::task::spawn_blocking(move || entry.delete_credential()).await;
    Ok(())
}

pub async fn load_session() -> Result<Option<AuthSession>> {
    let entry = entry()?;
    let payload = tokio::task::spawn_blocking(move || entry.get_password())
        .await
        .context("join credential read")?;
    match payload {
        Ok(json) => {
            let stored: StoredSession =
                serde_json::from_str(&json).context("stored session payload is invalid")?;
            Ok(Some(stored.into()))
        }
        Err(error) => {
            // keyring returns NoEntry when nothing is stored; treat as missing.
            if matches!(error, keyring::Error::NoEntry) {
                return Ok(None);
            }
            log::debug!("[commercial] secure session read failed: {error}");
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_a_session_payload() {
        let original = StoredSession {
            token: "tok".into(),
            user_id: "u1".into(),
            username: "alice".into(),
            plan: "paid".into(),
            expire_at: 100,
            status: "active".into(),
            product_name: "Fork".into(),
            issued_at: 10,
            access_key: "key".into(),
        };
        let json = serde_json::to_string(&original).unwrap();
        let decoded: StoredSession = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.token, original.token);
        assert_eq!(decoded.user_id, original.user_id);
    }
}
