use super::{CmdResult, StringifyErr as _};
use crate::commercial::{
    self, AuthSession, SyncResult, api, auth, is_enabled, sync_official_subscription,
};
use clash_verge_logging::{Type, logging};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct CommercialStatus {
    pub enabled: bool,
    pub product_name: String,
    pub mock_backend: bool,
    pub api_base: String,
    pub demo_hint: String,
}

#[tauri::command]
pub async fn get_commercial_status() -> CmdResult<CommercialStatus> {
    Ok(CommercialStatus {
        enabled: is_enabled(),
        product_name: commercial::PRODUCT_NAME.into(),
        mock_backend: false,
        api_base: commercial::api::api_base(),
        demo_hint: "后端默认: https://your-domain.example （可用 FORK_API_BASE 覆盖）".into(),
    })
}

#[tauri::command]
pub async fn commercial_register(
    username: String,
    password: String,
    email: String,
) -> CmdResult<AuthSession> {
    logging!(info, Type::Cmd, "[commercial] register user={}", username);
    auth::register(&username, &password, &email)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_login(username: String, password: String) -> CmdResult<AuthSession> {
    logging!(info, Type::Cmd, "[commercial] login user={}", username);
    auth::login(&username, &password).await.stringify_err()
}

#[tauri::command]
pub async fn commercial_logout() -> CmdResult<()> {
    logging!(info, Type::Cmd, "[commercial] logout");
    auth::logout().await.stringify_err()
}

#[tauri::command]
pub async fn commercial_get_session() -> CmdResult<Option<AuthSession>> {
    match auth::current_session().await {
        Ok(s) => Ok(s),
        Err(e) => {
            // Expired / disabled — treat as logged out for session probe
            logging!(warn, Type::Cmd, "[commercial] session invalid: {}", e);
            Err(e.to_string().into())
        }
    }
}

#[tauri::command]
pub async fn commercial_sync_subscription() -> CmdResult<SyncResult> {
    logging!(info, Type::Cmd, "[commercial] sync official subscription");
    sync_official_subscription().await.stringify_err()
}

#[tauri::command]
pub async fn commercial_get_catalog() -> CmdResult<api::CatalogResponse> {
    let session = auth::require_session().await.stringify_err()?;
    api::fetch_catalog(session.token.as_str()).await.stringify_err()
}

#[tauri::command]
pub async fn commercial_purchase(product_id: String) -> CmdResult<api::PurchaseResult> {
    logging!(info, Type::Cmd, "[commercial] purchase product={}", product_id);
    let session = auth::require_session().await.stringify_err()?;
    let result = api::purchase(session.token.as_str(), &product_id)
        .await
        .stringify_err()?;
    // free / already granted — sync nodes; paid waits for notify + client poll
    if !result.need_pay {
        let _ = sync_official_subscription().await;
    }
    Ok(result)
}

#[tauri::command]
pub async fn commercial_get_order(order_id: String) -> CmdResult<api::OrderStatus> {
    let session = auth::require_session().await.stringify_err()?;
    api::get_order(session.token.as_str(), &order_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_get_announcements() -> CmdResult<api::AnnouncementList> {
    let session = auth::require_session().await.stringify_err()?;
    api::fetch_announcements(session.token.as_str())
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_check_app_update(version: String) -> CmdResult<api::AppUpdateInfo> {
    api::check_app_update(&version).await.stringify_err()
}

#[tauri::command]
pub async fn commercial_get_profile() -> CmdResult<api::UserProfile> {
    let session = auth::require_session().await.stringify_err()?;
    api::fetch_profile(session.token.as_str())
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_list_orders() -> CmdResult<api::OrderList> {
    let session = auth::require_session().await.stringify_err()?;
    api::fetch_orders(session.token.as_str())
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_change_password(
    old_password: String,
    new_password: String,
) -> CmdResult<api::ChangePasswordResult> {
    let session = auth::require_session().await.stringify_err()?;
    api::change_password(session.token.as_str(), &old_password, &new_password)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_redeem_coupon(code: String) -> CmdResult<api::RedeemResult> {
    let session = auth::require_session().await.stringify_err()?;
    let result = api::redeem_coupon(session.token.as_str(), &code)
        .await
        .stringify_err()?;
    // unlock nodes after redeem
    let _ = sync_official_subscription().await;
    Ok(result)
}

#[tauri::command]
pub async fn commercial_change_email(
    email: String,
    password: String,
) -> CmdResult<api::ChangeEmailResult> {
    let session = auth::require_session().await.stringify_err()?;
    api::change_email(session.token.as_str(), &email, &password)
        .await
        .stringify_err()
}
