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
    invite_code: Option<String>,
    email_code: Option<String>,
) -> CmdResult<AuthSession> {
    logging!(info, Type::Cmd, "[commercial] register user={}", username);
    auth::register(
        &username,
        &password,
        &email,
        invite_code.as_deref(),
        email_code.as_deref(),
    )
    .await
    .stringify_err()
}

#[tauri::command]
pub async fn commercial_send_email_code(
    email: String,
    purpose: String,
) -> CmdResult<serde_json::Value> {
    auth::send_email_code(&email, &purpose)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_email_status() -> CmdResult<serde_json::Value> {
    auth::email_status().await.stringify_err()
}

#[tauri::command]
pub async fn commercial_password_reset_request(email: String) -> CmdResult<serde_json::Value> {
    auth::password_reset_request(&email)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_password_reset_complete(
    email: String,
    email_code: String,
    new_password: String,
) -> CmdResult<serde_json::Value> {
    auth::password_reset_complete(&email, &email_code, &new_password)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_delete_account_send_code() -> CmdResult<serde_json::Value> {
    auth::delete_account_send_code().await.stringify_err()
}

#[tauri::command]
pub async fn commercial_delete_account(
    password: String,
    email_code: String,
) -> CmdResult<serde_json::Value> {
    logging!(info, Type::Cmd, "[commercial] delete-account requested");
    auth::delete_account(&password, &email_code)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_login(
    username: String,
    password: String,
    device_id: Option<String>,
    device_name: Option<String>,
    platform: Option<String>,
) -> CmdResult<AuthSession> {
    logging!(info, Type::Cmd, "[commercial] login user={}", username);
    auth::login(
        &username,
        &password,
        device_id.as_deref(),
        device_name.as_deref(),
        platform.as_deref(),
    )
    .await
    .stringify_err()
}

#[tauri::command]
pub async fn commercial_report_traffic(
    delta_bytes: u64,
    pool: Option<String>,
) -> CmdResult<serde_json::Value> {
    auth::report_traffic(delta_bytes, pool).await.stringify_err()
}

#[tauri::command]
pub async fn commercial_remove_device(device_id: String) -> CmdResult<serde_json::Value> {
    auth::remove_device(&device_id).await.stringify_err()
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
pub async fn commercial_purchase(
    product_id: String,
    pay_type: Option<String>,
    coupon_code: Option<String>,
    use_balance: Option<bool>,
) -> CmdResult<api::PurchaseResult> {
    logging!(info, Type::Cmd, "[commercial] purchase product={}", product_id);
    let session = auth::require_session().await.stringify_err()?;
    let result = api::purchase(
        session.token.as_str(),
        &product_id,
        pay_type.as_deref(),
        coupon_code.as_deref(),
        use_balance,
    )
    .await
    .stringify_err()?;
    // free / already granted — sync nodes; paid waits for notify + client poll
    if !result.need_pay {
        let _ = sync_official_subscription().await;
    }
    Ok(result)
}

#[tauri::command]
pub async fn commercial_get_catalog_item(product_id: String) -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::fetch_catalog_item(session.token.as_str(), &product_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_preview_checkout(
    product_id: String,
    coupon_code: Option<String>,
    use_balance: Option<bool>,
) -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::preview_checkout(
        session.token.as_str(),
        &product_id,
        coupon_code.as_deref(),
        use_balance,
    )
    .await
    .stringify_err()
}

#[tauri::command]
pub async fn commercial_balance_packs() -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::balance_packs(session.token.as_str())
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_balance_topup(
    amount_cents: i64,
    pay_type: Option<String>,
) -> CmdResult<api::PurchaseResult> {
    logging!(
        info,
        Type::Cmd,
        "[commercial] balance topup cents={}",
        amount_cents
    );
    let session = auth::require_session().await.stringify_err()?;
    api::balance_topup(
        session.token.as_str(),
        amount_cents,
        pay_type.as_deref(),
    )
    .await
    .stringify_err()
}

#[tauri::command]
pub async fn commercial_list_tickets() -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::list_tickets(session.token.as_str())
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_create_ticket(
    subject: String,
    body: String,
    category: Option<String>,
) -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::create_ticket(
        session.token.as_str(),
        &subject,
        &body,
        category.as_deref(),
    )
    .await
    .stringify_err()
}

#[tauri::command]
pub async fn commercial_get_ticket(ticket_id: String) -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::get_ticket(session.token.as_str(), &ticket_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_reply_ticket(
    ticket_id: String,
    body: String,
) -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::reply_ticket(session.token.as_str(), &ticket_id, &body)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_close_ticket(ticket_id: String) -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::close_ticket(session.token.as_str(), &ticket_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_checkin_status() -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::checkin_status(session.token.as_str())
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn commercial_do_checkin() -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::do_checkin(session.token.as_str()).await.stringify_err()
}

#[tauri::command]
pub async fn commercial_invite_info() -> CmdResult<serde_json::Value> {
    let session = auth::require_session().await.stringify_err()?;
    api::invite_info(session.token.as_str()).await.stringify_err()
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
