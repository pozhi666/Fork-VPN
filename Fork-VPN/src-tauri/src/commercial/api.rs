use super::PRODUCT_NAME;
use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Default Fork backend address (production server).
/// Override anytime with env `FORK_API_BASE`.
pub const DEFAULT_API_BASE: &str = "https://your-domain.example/api/v1";

fn is_loopback_http(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|prefix| {
            lower == *prefix
                || lower
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with(':') || rest.starts_with('/'))
        })
}

fn is_allowed_api_base(value: &str) -> bool {
    let value = value.trim();
    if value.starts_with("https://") {
        return true;
    }
    let explicit_dev_override = std::env::var("FORK_ALLOW_INSECURE_HTTP")
        .map(|v| v == "1")
        .unwrap_or(false);
    (cfg!(debug_assertions) || explicit_dev_override) && is_loopback_http(value)
}

pub fn api_base() -> String {
    match std::env::var("FORK_API_BASE") {
        Ok(configured) if is_allowed_api_base(&configured) => configured.trim_end_matches('/').into(),
        Ok(configured) => {
            eprintln!(
                "[commercial] refusing insecure or untrusted FORK_API_BASE {:?}; using the production HTTPS endpoint",
                configured
            );
            DEFAULT_API_BASE.into()
        }
        Err(_) => DEFAULT_API_BASE.into(),
    }
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
    pub traffic_upload: Option<u64>,
    #[serde(default)]
    pub traffic_download: Option<u64>,
    #[serde(default)]
    pub traffic_unlimited: Option<bool>,
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

pub async fn register(
    username: &str,
    password: &str,
    email: &str,
    invite_code: Option<&str>,
    email_code: Option<&str>,
) -> Result<ApiSession> {
    let url = format!("{}/auth/register", api_base());
    let mut body = json!({
        "username": username,
        "password": password,
        "email": email,
    });
    if let Some(code) = invite_code {
        if !code.is_empty() {
            body["invite_code"] = json!(code);
        }
    }
    if let Some(code) = email_code {
        if !code.is_empty() {
            body["email_code"] = json!(code);
        }
    }
    let res = client()
        .post(url)
        .json(&body)
        .send()
        .await
        .context("无法连接 Fork 后端，请确认已启动 fork-backend")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

/// Send 6-digit email OTP. purpose: register | reset_password
pub async fn send_email_code(email: &str, purpose: &str) -> Result<serde_json::Value> {
    let url = format!("{}/auth/email-code/send", api_base());
    let res = client()
        .post(url)
        .json(&json!({ "email": email, "purpose": purpose }))
        .send()
        .await
        .context("无法连接 Fork 后端")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn email_status() -> Result<serde_json::Value> {
    let url = format!("{}/auth/email-status", api_base());
    let res = client()
        .get(url)
        .send()
        .await
        .context("无法连接 Fork 后端")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

/// Password reset via email OTP
pub async fn password_reset_request(email: &str) -> Result<serde_json::Value> {
    let url = format!("{}/auth/password-reset/request", api_base());
    let res = client()
        .post(url)
        .json(&json!({ "email": email, "mode": "code" }))
        .send()
        .await
        .context("无法连接 Fork 后端")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn password_reset_complete(
    email: &str,
    email_code: &str,
    new_password: &str,
) -> Result<serde_json::Value> {
    let url = format!("{}/auth/password-reset/complete", api_base());
    let res = client()
        .post(url)
        .json(&json!({
            "email": email,
            "email_code": email_code,
            "new_password": new_password,
        }))
        .send()
        .await
        .context("无法连接 Fork 后端")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

/// Send delete-account OTP to the bound email of the current user.
pub async fn delete_account_send_code(token: &str) -> Result<serde_json::Value> {
    let url = format!("{}/client/delete-account/send-code", api_base());
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .context("无法连接 Fork 后端")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

/// Self-service account deletion: password + email OTP.
pub async fn delete_account(
    token: &str,
    password: &str,
    email_code: &str,
) -> Result<serde_json::Value> {
    let url = format!("{}/client/delete-account", api_base());
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({
            "password": password,
            "email_code": email_code,
        }))
        .send()
        .await
        .context("无法连接 Fork 后端")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn login(
    username: &str,
    password: &str,
    device_id: Option<&str>,
    device_name: Option<&str>,
    platform: Option<&str>,
) -> Result<ApiSession> {
    let url = format!("{}/auth/login", api_base());
    let mut body = json!({ "username": username, "password": password });
    if let Some(id) = device_id {
        if !id.is_empty() {
            body["device_id"] = json!(id);
        }
    }
    if let Some(n) = device_name {
        if !n.is_empty() {
            body["device_name"] = json!(n);
        }
    }
    if let Some(p) = platform {
        if !p.is_empty() {
            body["platform"] = json!(p);
        }
    }
    let res = client()
        .post(url)
        .json(&body)
        .send()
        .await
        .context("无法连接 Fork 后端，请确认已启动 fork-backend")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn report_traffic(
    token: &str,
    delta_bytes: u64,
    pool: Option<&str>,
) -> Result<serde_json::Value> {
    let url = format!("{}/client/traffic/report", api_base());
    let pool = pool
        .map(|p| p.to_ascii_lowercase())
        .filter(|p| p == "free" || p == "paid" || p == "auto")
        .unwrap_or_else(|| "auto".into());
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({ "delta_bytes": delta_bytes, "pool": pool }))
        .send()
        .await
        .context("无法上报流量")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn register_device(
    token: &str,
    device_id: &str,
    name: &str,
    platform: &str,
) -> Result<serde_json::Value> {
    let url = format!("{}/client/devices/register", api_base());
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({
            "device_id": device_id,
            "name": name,
            "platform": platform,
        }))
        .send()
        .await
        .context("无法注册设备")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn remove_device(token: &str, device_id: &str) -> Result<serde_json::Value> {
    let url = format!(
        "{}/client/devices/{}",
        api_base(),
        percent_encode_segment(device_id)
    );
    let res = client()
        .delete(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法移除设备")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

fn percent_encode_segment(input: &str) -> String {
    const UNRESERVED: &str = "-._~";
    let mut out = String::with_capacity(input.len() * 3);
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let ok = b.is_ascii_alphanumeric() || UNRESERVED.as_bytes().contains(&b);
        if ok {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
        i += 1;
    }
    out
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
    #[serde(default)]
    pub balance_applied_cents: Option<i64>,
    #[serde(default)]
    pub gateway_cents: Option<i64>,
    #[serde(default)]
    pub balance_cents: Option<i64>,
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

pub async fn purchase(
    token: &str,
    product_id: &str,
    pay_type: Option<&str>,
    coupon_code: Option<&str>,
    use_balance: Option<bool>,
) -> Result<PurchaseResult> {
    let url = format!("{}/client/purchase", api_base());
    let mut body = json!({ "product_id": product_id });
    if let Some(t) = pay_type {
        if !t.is_empty() {
            body["pay_type"] = json!(t);
        }
    }
    if let Some(c) = coupon_code {
        if !c.is_empty() {
            body["coupon_code"] = json!(c);
        }
    }
    if let Some(ub) = use_balance {
        body["use_balance"] = json!(ub);
    }
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .context("无法连接 Fork 后端购买")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn fetch_catalog_item(token: &str, product_id: &str) -> Result<serde_json::Value> {
    let url = format!("{}/client/catalog/{}", api_base(), product_id);
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法获取商品详情")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn preview_checkout(
    token: &str,
    product_id: &str,
    coupon_code: Option<&str>,
    use_balance: Option<bool>,
) -> Result<serde_json::Value> {
    let url = format!("{}/client/checkout/preview", api_base());
    let mut body = json!({ "product_id": product_id });
    if let Some(c) = coupon_code {
        if !c.is_empty() {
            body["coupon_code"] = json!(c);
        }
    }
    if let Some(ub) = use_balance {
        body["use_balance"] = json!(ub);
    }
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .context("无法预览优惠")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn balance_packs(token: &str) -> Result<serde_json::Value> {
    let url = format!("{}/client/balance/packs", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法获取充值档位")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn balance_topup(
    token: &str,
    amount_cents: i64,
    pay_type: Option<&str>,
) -> Result<PurchaseResult> {
    let url = format!("{}/client/balance/topup", api_base());
    let mut body = json!({ "amount_cents": amount_cents });
    if let Some(t) = pay_type {
        if !t.is_empty() {
            body["pay_type"] = json!(t);
        }
    }
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .context("无法创建充值订单")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn list_tickets(token: &str) -> Result<serde_json::Value> {
    let url = format!("{}/client/tickets", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法获取工单")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn create_ticket(
    token: &str,
    subject: &str,
    body: &str,
    category: Option<&str>,
) -> Result<serde_json::Value> {
    let url = format!("{}/client/tickets", api_base());
    let mut payload = json!({ "subject": subject, "body": body });
    if let Some(c) = category {
        if !c.is_empty() {
            payload["category"] = json!(c);
        }
    }
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .context("无法创建工单")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn get_ticket(token: &str, ticket_id: &str) -> Result<serde_json::Value> {
    let url = format!("{}/client/tickets/{}", api_base(), ticket_id);
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法获取工单详情")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn reply_ticket(
    token: &str,
    ticket_id: &str,
    body: &str,
) -> Result<serde_json::Value> {
    let url = format!("{}/client/tickets/{}/reply", api_base(), ticket_id);
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({ "body": body }))
        .send()
        .await
        .context("无法回复工单")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn close_ticket(token: &str, ticket_id: &str) -> Result<serde_json::Value> {
    let url = format!("{}/client/tickets/{}/close", api_base(), ticket_id);
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .context("无法关闭工单")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn checkin_status(token: &str) -> Result<serde_json::Value> {
    let url = format!("{}/client/checkin", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法获取签到状态")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn do_checkin(token: &str) -> Result<serde_json::Value> {
    let url = format!("{}/client/checkin", api_base());
    let res = client()
        .post(url)
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .context("签到失败")?;
    if !res.status().is_success() {
        bail!("{}", read_error(res).await);
    }
    Ok(res.json().await?)
}

pub async fn invite_info(token: &str) -> Result<serde_json::Value> {
    let url = format!("{}/client/invite/info", api_base());
    let res = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .context("无法获取邀请信息")?;
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
    #[serde(default)]
    pub traffic_limit_bytes: Option<u64>,
    #[serde(default)]
    pub traffic_used_bytes: Option<u64>,
    #[serde(default)]
    pub traffic_unlimited: Option<bool>,
    #[serde(default)]
    pub traffic_label: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct TrafficPoolInfo {
    #[serde(default)]
    pub unlimited: bool,
    #[serde(default)]
    pub limit_bytes: u64,
    #[serde(default)]
    pub used_bytes: u64,
    #[serde(default)]
    pub remaining_bytes: Option<u64>,
    #[serde(default)]
    pub exhausted: bool,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct TrafficInfo {
    /// dual wallets (source of truth for UI)
    #[serde(default)]
    pub free: Option<TrafficPoolInfo>,
    #[serde(default)]
    pub paid: Option<TrafficPoolInfo>,
    #[serde(default)]
    pub is_paid_user: Option<bool>,
    /// legacy single-pool fields
    #[serde(default)]
    pub unlimited: bool,
    #[serde(default)]
    pub limit_bytes: u64,
    #[serde(default)]
    pub used_bytes: u64,
    #[serde(default)]
    pub remaining_bytes: Option<u64>,
    #[serde(default)]
    pub exhausted: bool,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DeviceInfo {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub last_seen_at: Option<i64>,
    #[serde(default)]
    pub created_at: Option<i64>,
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
    #[serde(default)]
    pub traffic: Option<TrafficInfo>,
    #[serde(default)]
    pub is_paid_user: Option<bool>,
    #[serde(default)]
    pub invite_code: Option<String>,
    #[serde(default)]
    pub devices: Vec<DeviceInfo>,
    #[serde(default)]
    pub max_devices: Option<i64>,
    #[serde(default)]
    pub support_tg: Option<String>,
    #[serde(default)]
    pub balance_cents: Option<i64>,
    #[serde(default)]
    pub balance_yuan: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::{is_allowed_api_base, is_loopback_http};

    #[test]
    fn accepts_only_known_loopback_http_hosts() {
        assert!(is_loopback_http("http://127.0.0.1:8787/api/v1"));
        assert!(is_loopback_http("http://localhost/api/v1"));
        assert!(!is_loopback_http("http://localhost.evil.example/api/v1"));
        assert!(!is_loopback_http("http://192.168.1.2/api/v1"));
    }

    #[test]
    fn accepts_https_api_bases() {
        assert!(is_allowed_api_base("https://your-domain.example/api/v1"));
    }
}
