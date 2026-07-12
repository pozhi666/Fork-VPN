use super::PRODUCT_NAME;
use super::api::{self, ApiSession};
use crate::utils::dirs;
use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use smartstring::alias::String as SmartString;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;

const SESSION_FILE: &str = "commercial_session.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommercialUser {
    pub id: SmartString,
    pub username: SmartString,
    pub password_hash: SmartString,
    pub expire_at: i64,
    pub plan: SmartString,
    pub status: SmartString,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSession {
    pub token: SmartString,
    pub user_id: SmartString,
    pub username: SmartString,
    pub plan: SmartString,
    pub expire_at: i64,
    pub status: SmartString,
    pub product_name: SmartString,
    pub issued_at: i64,
    #[serde(default)]
    pub access_key: SmartString,
}

async fn read_json_file<T: DeserializeOwned>(path: &PathBuf) -> Result<T> {
    let raw = fs::read_to_string(path)
        .await
        .with_context(|| format!("failed to read {}", path.display()))?;
    Ok(serde_json::from_str(&raw)?)
}

async fn write_json_file<T: Serialize>(path: &PathBuf, data: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.ok();
    }
    let raw = serde_json::to_string_pretty(data)?;
    fs::write(path, raw.as_bytes())
        .await
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn session_path() -> Result<PathBuf> {
    Ok(dirs::app_home_dir()?.join(SESSION_FILE))
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn from_api(api: ApiSession) -> AuthSession {
    let product_name = api::session_product_name(&api);
    let issued_at = api.issued_at.unwrap_or_else(now_ts);
    AuthSession {
        token: api.token.into(),
        user_id: api.user_id.into(),
        username: api.username.into(),
        plan: api.plan.into(),
        expire_at: api.expire_at,
        status: api.status.into(),
        product_name: product_name.into(),
        issued_at,
        access_key: api.access_key.unwrap_or_default().into(),
    }
}

async fn save_session(session: &AuthSession) -> Result<()> {
    write_json_file(&session_path()?, session).await
}

pub async fn clear_session() -> Result<()> {
    let path = session_path()?;
    if path.exists() {
        fs::remove_file(&path).await.ok();
    }
    Ok(())
}

pub async fn load_session() -> Result<Option<AuthSession>> {
    let path = session_path()?;
    if !path.exists() {
        return Ok(None);
    }
    match read_json_file::<AuthSession>(&path).await {
        Ok(session) => Ok(Some(session)),
        Err(_) => {
            let _ = clear_session().await;
            Ok(None)
        }
    }
}

pub async fn register(username: &str, password: &str, email: &str) -> Result<AuthSession> {
    let api_sess = api::register(username.trim(), password, email.trim()).await?;
    let session = from_api(api_sess);
    save_session(&session).await?;
    Ok(session)
}

pub async fn login(username: &str, password: &str) -> Result<AuthSession> {
    let api_sess = api::login(username.trim(), password).await?;
    let session = from_api(api_sess);
    save_session(&session).await?;
    Ok(session)
}

pub async fn logout() -> Result<()> {
    clear_session().await
}

/// Validate local token against backend.
pub async fn current_session() -> Result<Option<AuthSession>> {
    let Some(local) = load_session().await? else {
        return Ok(None);
    };

    match api::me(local.token.as_str()).await {
        Ok(api_sess) => {
            let session = from_api(api_sess);
            save_session(&session).await?;
            Ok(Some(session))
        }
        Err(e) => {
            let msg = e.to_string();
            // network down: keep cached session for offline UX of UI shell
            if msg.contains("无法连接") {
                return Ok(Some(local));
            }
            clear_session().await?;
            bail!(msg);
        }
    }
}

pub async fn require_session() -> Result<AuthSession> {
    match current_session().await? {
        Some(s) => Ok(s),
        None => bail!("请先登录"),
    }
}

pub fn product_name() -> &'static str {
    PRODUCT_NAME
}
