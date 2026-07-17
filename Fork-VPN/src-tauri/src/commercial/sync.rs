use super::auth::require_session;
use super::{OFFICIAL_PROFILE_MARKER, OFFICIAL_PROFILE_NAME, api};
use crate::config::{
    Config, PrfExtra, PrfItem,
    profiles::{
        profiles_append_item_safe, profiles_draft_update_item_safe, profiles_save_file_safe,
    },
};
use crate::core::handle;
use crate::feat;
use anyhow::Result;
use serde::Serialize;
use smartstring::alias::String as SmartString;

#[derive(Debug, Clone, Serialize)]
pub struct SyncResult {
    pub profile_uid: SmartString,
    pub name: SmartString,
    pub updated: usize,
    pub expire_at: i64,
    pub plan: SmartString,
    pub message: SmartString,
    #[serde(default)]
    pub access_key: SmartString,
}

fn find_official_uid(items: &[PrfItem]) -> Option<SmartString> {
    items.iter().find_map(|item| {
        let is_official = item.desc.as_deref() == Some(OFFICIAL_PROFILE_MARKER)
            || item.name.as_deref() == Some(OFFICIAL_PROFILE_NAME);
        if is_official {
            item.uid.clone()
        } else {
            None
        }
    })
}

/// Pull official config from Fork backend and write into managed profile.
pub async fn sync_official_subscription() -> Result<SyncResult> {
    let session = require_session().await?;
    let sub = api::fetch_subscription(session.token.as_str()).await?;
    let yaml = sub.content;
    let now = chrono::Local::now().timestamp() as usize;

    let extra = Some(PrfExtra {
        upload: sub.traffic_upload.unwrap_or(0),
        download: sub.traffic_download.unwrap_or(0),
        total: if sub.traffic_unlimited.unwrap_or(false) {
            // large ceiling so UI shows "plenty left" while still showing used download
            sub.traffic_total
                .unwrap_or(1024 * 1024 * 1024 * 1024)
                .max(sub.traffic_download.unwrap_or(0).saturating_add(1))
        } else {
            sub.traffic_total.unwrap_or(0).max(sub.traffic_download.unwrap_or(0))
        },
        expire: sub.expire_at.max(0) as u64,
    });

    let profile_name: SmartString = if sub.name.is_empty() {
        OFFICIAL_PROFILE_NAME.into()
    } else {
        sub.name.clone().into()
    };

    let profiles_draft = Config::profiles().await;
    let existing_uid = {
        let guard = profiles_draft.latest_arc();
        let items = guard.items.as_deref().unwrap_or(&[]);
        find_official_uid(items)
    };
    drop(profiles_draft);

    let profile_uid = if let Some(uid) = existing_uid {
        let mut update = PrfItem {
            name: Some(profile_name.clone()),
            desc: Some(OFFICIAL_PROFILE_MARKER.into()),
            extra,
            updated: Some(now),
            file_data: Some(yaml.into()),
            ..Default::default()
        };
        profiles_draft_update_item_safe(&uid, &mut update).await?;
        uid
    } else {
        let mut item = PrfItem::from_local(
            profile_name.clone(),
            OFFICIAL_PROFILE_MARKER.into(),
            Some(yaml.into()),
            None,
        )
        .await?;
        item.extra = extra;
        item.updated = Some(now);
        let uid = item.uid.clone().unwrap_or_default();
        profiles_append_item_safe(&mut item).await?;
        profiles_save_file_safe().await?;
        uid
    };

    {
        let profiles = Config::profiles().await;
        profiles.edit_draft(|d| {
            d.current = Some(profile_uid.clone());
        });
        profiles.apply();
        drop(profiles);
        profiles_save_file_safe().await?;
    }

    let _ = feat::enhance_profiles().await?;
    handle::Handle::refresh_clash();
    handle::Handle::notify_profile_changed(&profile_uid);

    // Entitlement change must kill in-flight tunnels (paid node still open after revoke).
    // Same as tray "close all connections" — profile reload alone does not drop existing flows.
    if let Err(err) = handle::Handle::mihomo()
        .await
        .close_all_connections()
        .await
    {
        clash_verge_logging::logging!(
            warn,
            clash_verge_logging::Type::System,
            "commercial sync: close_all_connections failed: {err}"
        );
    }

    let free = sub.free_count.unwrap_or(0);
    let paid = sub.paid_count.unwrap_or(0);
    let total = sub.node_count.unwrap_or(0);
    let msg = if total == 0 {
        "已同步：当前无可用节点（权益可能已撤销，请重新开通）".to_string()
    } else {
        format!("已同步：共 {total} 节点（公共/免费 {free} · 商品线路 {paid}）")
    };
    Ok(SyncResult {
        profile_uid,
        name: profile_name,
        updated: now,
        expire_at: sub.expire_at,
        plan: sub.plan.into(),
        message: msg.into(),
        access_key: sub.access_key.unwrap_or_default().into(),
    })
}
