use super::{OFFICIAL_PROFILE_MARKER, OFFICIAL_PROFILE_NAME, is_enabled};
use crate::config::{Config, PrfItem};
use anyhow::{Result, bail};

/// User import / create is allowed in commercial mode (self-service subscriptions).
pub fn ensure_import_allowed() -> Result<()> {
    Ok(())
}

/// Deep-link / clipboard subscription install is allowed.
pub fn ensure_deep_link_allowed() -> Result<()> {
    Ok(())
}

pub fn is_official_item(item: &PrfItem) -> bool {
    item.desc.as_deref() == Some(OFFICIAL_PROFILE_MARKER)
        || item.name.as_deref() == Some(OFFICIAL_PROFILE_NAME)
}

/// Block mutating the server-managed official profile.
pub async fn ensure_not_official_profile(index: &str, action: &str) -> Result<()> {
    if !is_enabled() {
        return Ok(());
    }
    // Global enhance profiles are user-owned again.
    if index == "Merge" || index == "Script" {
        return Ok(());
    }
    let profiles = Config::profiles().await;
    let guard = profiles.latest_arc();
    if let Ok(item) = guard.get_item(index)
        && is_official_item(item)
    {
        bail!("官方线路不可{action}，请使用「同步官方线路」更新");
    }
    Ok(())
}

/// Saving YAML of the official profile is blocked; user imports are editable.
pub async fn ensure_profile_edit_allowed(index: &str) -> Result<()> {
    ensure_not_official_profile(index, "编辑").await
}
