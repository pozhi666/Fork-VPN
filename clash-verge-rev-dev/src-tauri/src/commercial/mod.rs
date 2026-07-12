//! Fork commercial mode: account auth + official subscription delivery.
//! Users may also import their own remote/local profiles.
//! Also owns **runtime isolation** from the stock Fork install
//! (data dir, ports, IPC pipe, singleton lock, product id).

pub mod api;
pub mod auth;
pub mod guard;
pub mod sync;

pub use auth::{AuthSession, CommercialUser};
pub use guard::ensure_import_allowed;
pub use sync::{SyncResult, sync_official_subscription};

/// Feature flag — commercial auth / shop / official sync.
/// Profile import is allowed; only the official profile is write-protected.
pub const COMMERCIAL_MODE: bool = true;

/// Product display name.
pub const PRODUCT_NAME: &str = "Fork";

/// Tauri / OS application identifier (must differ from stock Fork).
pub const APP_IDENTIFIER: &str = "com.fork.client";

/// App data folder name under Roaming / portable .config
#[cfg(not(feature = "verge-dev"))]
pub const APP_ID: &str = "com.fork.client";
#[cfg(feature = "verge-dev")]
pub const APP_ID: &str = "com.fork.client.dev";

#[cfg(not(feature = "verge-dev"))]
pub const BACKUP_DIR: &str = "fork-backup";
#[cfg(feature = "verge-dev")]
pub const BACKUP_DIR: &str = "fork-backup-dev";

/// Windows named pipe for mihomo external-controller (stock uses verge-mihomo).
pub const IPC_PIPE_NAME: &str = r"\\.\pipe\fork-mihomo";

/// Unix socket relative segments under safe dir.
pub const IPC_SOCK_NAMESPACE: &str = "fork";
pub const IPC_SOCK_FILE: &str = "fork-mihomo.sock";

/// Default proxy / controller ports — shifted away from stock 789x / 9097.
pub mod ports {
    pub const DEFAULT_MIXED: u16 = 17897;
    pub const DEFAULT_SOCKS: u16 = 17898;
    pub const DEFAULT_HTTP: u16 = 17899;
    #[cfg(not(target_os = "windows"))]
    pub const DEFAULT_REDIR: u16 = 17895;
    #[cfg(target_os = "linux")]
    pub const DEFAULT_TPROXY: u16 = 17896;

    pub const DEFAULT_EXTERNAL_CONTROLLER: &str = "127.0.0.1:19097";

    #[cfg(not(feature = "verge-dev"))]
    pub const SINGLETON_SERVER: u16 = 22331;
    #[cfg(feature = "verge-dev")]
    pub const SINGLETON_SERVER: u16 = 22332;
}

/// Official profile marker stored in profile `desc`.
pub const OFFICIAL_PROFILE_MARKER: &str = "fork-official";

/// Official profile display name.
pub const OFFICIAL_PROFILE_NAME: &str = "官方线路";

pub fn is_enabled() -> bool {
    COMMERCIAL_MODE
}
