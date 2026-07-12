use super::PRODUCT_NAME;
use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Default Fork backend address (production server).
/// Override anytime with env `FORK_API_BASE`.
pub const DEFAULT_API_BASE: &str = "https://your-domain.example/api/v1";

pub fn api_base() -> String {
    std::env::var("FORK_API_BASE").unwrap_or_else(|_| DEFAULT_API_BASE.into())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .no_proxy()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[derive(Debug, Deserialize)]
pub struct ApiSession {
    pub token: String,
    pub user_id: String,
    pub username: String,
    pub plan: String,
    pub expire_at: i64,
    pub status: String,
    #[serde(default)]
    pub product_name: Option<String>,
    #[serde(default)]
    pub issued_at: Option<i64>,
    #[serde(default)]
    pub access_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApiSubscription {
    pub name: String,
    pub content: String,
    pub expire_at: i64,
    pub plan: String,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub traffic_total: Option<u64>,
    #[serde(default)]
    pub node_count: Option<usize>,
    #[serde(default)]
    pub free_count: Option<usize>,
    #[serde(default)]
    pub paid_count: Option<usize>,
    /// Fingerprint of allowed sources/purchases — client re-syncs when this changes
    #[serde(default)]
    pub access_key: Option<String>,
}

async fn read_error(res: reqwest::Response) -> String {
    let status = res.status();
    if let Ok(err) = res.json::<ApiError>().await {
        if let Some(msg) = err.error {
            return msg;
        }
    }
    format!("请求失败 ({status})")
}

pub async fn register(username: &str, password: &str, email: &str) -> Result<ApiSession> {
    let url = format!("{}/auth/register", api_base());
    let res = client()
        .post(url)
        .json(&json!({
            "username": username,
            "password": password,
            "email": email,
        }))
        .send()
        .await
        .context("无法连接 Fork 后端，请确认已启动 fork-backend")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn login(username: &str, password: &str) -> Result<ApiSession> {
    let url = format!("{}/auth/login", api_base());
    let res = client()
        .post(url)
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .context("无法连接 Fork 后端，请确认已启动 fork-backend")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn me(token: &str) -> Result<ApiSession> {
    let url = format!("{}/auth/me", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法连接 Fork 后端")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn fetch_subscription(token: &str) -> Result<ApiSubscription> {
    let url = format!("{}/client/subscription", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法连接 Fork 后端拉取订阅")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub type_field: Option<String>,
    #[serde(default, rename = "type")]
    pub item_type: Option<String>,
    #[serde(default)]
    pub price_cents: Option<i64>,
    #[serde(default)]
    pub price_label: Option<String>,
    #[serde(default)]
    pub days: Option<i64>,
    #[serde(default)]
    pub owned: Option<bool>,
    #[serde(default)]
    pub source_name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CatalogResponse {
    #[serde(default)]
    pub free: Vec<CatalogItem>,
    #[serde(default)]
    pub paid: Vec<CatalogItem>,
    #[serde(default)]
    pub access_key: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PurchaseResult {
    pub product_id: String,
    pub name: String,
    #[serde(default)]
    pub expire_at: i64,
    #[serde(default)]
    pub price_cents: i64,
    #[serde(default)]
    pub message: String,
    /// true → open pay_url in browser; grant happens after 易支付 notify
    #[serde(default)]
    pub need_pay: bool,
    #[serde(default)]
    pub pay_url: Option<String>,
    #[serde(default)]
    pub order_id: Option<String>,
    #[serde(default)]
    pub out_trade_no: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub access_key: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OrderStatus {
    pub order_id: String,
    #[serde(default)]
    pub out_trade_no: Option<String>,
    pub status: String,
    #[serde(default)]
    pub product_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub expire_at: i64,
    #[serde(default)]
    pub price_cents: i64,
    #[serde(default)]
    pub paid_at: i64,
    #[serde(default)]
    pub pay_url: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub access_key: Option<String>,
}

pub async fn fetch_catalog(token: &str) -> Result<CatalogResponse> {
    let url = format!("{}/client/catalog", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法连接 Fork 后端获取商城")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn purchase(token: &str, product_id: &str) -> Result<PurchaseResult> {
    let url = format!("{}/client/purchase", api_base());
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({ "product_id": product_id }))
        .send()
        .await
        .context("无法连接 Fork 后端购买")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn get_order(token: &str, order_id: &str) -> Result<OrderStatus> {
    let url = format!("{}/client/orders/{}", api_base(), order_id);
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法连接 Fork 后端查询订单")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ProfilePurchase {
    pub product_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub expire_at: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub days_left: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct UserProfile {
    pub user_id: String,
    pub username: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub expire_at: i64,
    #[serde(default)]
    pub entitlement_until: Option<i64>,
    #[serde(default)]
    pub account_expire_at: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub product_name: String,
    #[serde(default)]
    pub access_key: Option<String>,
    #[serde(default)]
    pub purchase_names: Vec<String>,
    #[serde(default)]
    pub purchases: Vec<ProfilePurchase>,
    #[serde(default)]
    pub free_sources: Vec<String>,
    #[serde(default)]
    pub paid_sources: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OrderListItem {
    pub order_id: String,
    #[serde(default)]
    pub out_trade_no: Option<String>,
    pub status: String,
    #[serde(default)]
    pub product_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub money: Option<String>,
    #[serde(default)]
    pub money_cents: Option<i64>,
    #[serde(default)]
    pub pay_type: Option<String>,
    #[serde(default)]
    pub trade_no: Option<String>,
    #[serde(default)]
    pub expire_at: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub paid_at: i64,
    #[serde(default)]
    pub pay_url: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct OrderList {
    #[serde(default)]
    pub items: Vec<OrderListItem>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChangePasswordResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub message: Option<String>,
}

pub async fn fetch_profile(token: &str) -> Result<UserProfile> {
    let url = format!("{}/client/profile", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法连接 Fork 后端获取个人中心")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn fetch_orders(token: &str) -> Result<OrderList> {
    let url = format!("{}/client/orders", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法连接 Fork 后端获取订单")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn change_password(
    token: &str,
    old_password: &str,
    new_password: &str,
) -> Result<ChangePasswordResult> {
    let url = format!("{}/client/change-password", api_base());
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({
            "old_password": old_password,
            "new_password": new_password,
        }))
        .send()
        .await
        .context("无法连接 Fork 后端修改密码")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct RedeemResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub product_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub days: Option<i64>,
    #[serde(default)]
    pub expire_at: i64,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub access_key: Option<String>,
}

pub async fn redeem_coupon(token: &str, code: &str) -> Result<RedeemResult> {
    let url = format!("{}/client/redeem", api_base());
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({ "code": code }))
        .send()
        .await
        .context("无法连接 Fork 后端兑换")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChangeEmailResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

pub async fn change_email(
    token: &str,
    email: &str,
    password: &str,
) -> Result<ChangeEmailResult> {
    let url = format!("{}/client/change-email", api_base());
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({
            "email": email,
            "password": password,
        }))
        .send()
        .await
        .context("无法连接 Fork 后端修改邮箱")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct AnnouncementItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct AnnouncementList {
    #[serde(default)]
    pub items: Vec<AnnouncementItem>,
}

pub async fn fetch_announcements(token: &str) -> Result<AnnouncementList> {
    let url = format!("{}/client/announcement", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法连接 Fork 后端获取公告")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct AppUpdateInfo {
    pub update: bool,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub latest_version: Option<String>,
    #[serde(default)]
    pub client_version: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

pub async fn check_app_update(client_version: &str) -> Result<AppUpdateInfo> {
    let url = format!(
        "{}/client/app-update?version={}",
        api_base(),
        urlencoding_loose(client_version)
    );
    let res = client()
        .get(url)
        .send()
        .await
        .context("无法连接 Fork 后端检查版本")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

fn urlencoding_loose(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

pub fn session_product_name(api: &ApiSession) -> String {
    api.product_name
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| PRODUCT_NAME.into())
}
