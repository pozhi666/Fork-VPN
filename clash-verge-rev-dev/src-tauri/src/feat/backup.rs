use crate::{
    config::{Config, IClashTemp, IProfiles, IVerge},
    constants::files::DNS_CONFIG,
    core::backup,
    process::AsyncHandler,
    utils::{
        dirs::{
            self, PathBufExec as _, app_home_dir, local_backup_dir, verge_path,
        },
        help,
    },
};
use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use clash_verge_logging::{Type, logging};
use reqwest_dav::list_cmd::ListFile;
use serde::Serialize;
use smartstring::alias::String;
use std::io::Read as _;
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};
use tokio::fs;

const BACKUP_MAX_ENTRIES: usize = 2_000;
const BACKUP_MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const BACKUP_MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug)]
struct RestoreFile {
    target: PathBuf,
    previous: Option<PathBuf>,
}

/// Files moved into `rollback_dir` remain available until runtime application
/// succeeds, so a malformed backup can never leave a partially restored app home.
#[derive(Debug)]
struct RestoreTransaction {
    rollback_dir: PathBuf,
    files: Vec<RestoreFile>,
}

impl RestoreTransaction {
    async fn rollback(mut self) -> Result<()> {
        let mut rollback_errors = Vec::new();
        for file in self.files.drain(..).rev() {
            if file.target.exists() {
                if let Err(err) = fs::remove_file(&file.target).await {
                    rollback_errors.push(format!("remove {}: {err}", file.target.display()));
                    continue;
                }
            }
            if let Some(previous) = file.previous {
                if let Some(parent) = file.target.parent()
                    && let Err(err) = fs::create_dir_all(parent).await
                {
                    rollback_errors.push(format!("create {}: {err}", parent.display()));
                    continue;
                }
                if let Err(err) = fs::rename(&previous, &file.target).await {
                    rollback_errors.push(format!(
                        "restore {} -> {}: {err}",
                        previous.display(),
                        file.target.display()
                    ));
                }
            }
        }
        if let Err(err) = fs::remove_dir_all(&self.rollback_dir).await
            && err.kind() != std::io::ErrorKind::NotFound
        {
            rollback_errors.push(format!("remove rollback snapshot: {err}"));
        }
        if rollback_errors.is_empty() {
            Ok(())
        } else {
            bail!("restore rollback incomplete: {}", rollback_errors.join("; "))
        }
    }

    async fn commit(mut self) -> Result<()> {
        if let Err(err) = fs::remove_dir_all(&self.rollback_dir).await
            && err.kind() != std::io::ErrorKind::NotFound
        {
            return Err(anyhow!("remove restore snapshot failed: {err}"));
        }
        self.files.clear();
        Ok(())
    }
}

/// Only restore known Clash Verge config paths — reject zip-slip / extras.
fn is_allowed_backup_rel_path(rel: &Path) -> bool {
    let s = rel.to_string_lossy().replace('\\', "/");
    if s == dirs::CLASH_CONFIG
        || s == dirs::VERGE_CONFIG
        || s == dirs::PROFILE_YAML
        || s == DNS_CONFIG
    {
        return true;
    }
    // profiles/<safe-file>.yaml | .yml | .js (script profiles)
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() == 2 && parts[0] == "profiles" {
        let name = parts[1];
        if name.is_empty() || name.starts_with('.') {
            return false;
        }
        if name.contains("..") {
            return false;
        }
        return name.ends_with(".yaml")
            || name.ends_with(".yml")
            || name.ends_with(".js")
            || name.ends_with(".json");
    }
    false
}

fn sanitize_zip_entry_name(name: &str) -> Result<PathBuf> {
    let name = name.replace('\\', "/");
    if name.is_empty() || name.ends_with('/') {
        bail!("skip directory entry");
    }
    if name.starts_with('/') || name.starts_with('\\') {
        bail!("absolute path not allowed in backup: {name}");
    }
    if name.contains('\0') {
        bail!("invalid path in backup");
    }
    // Drive letter / Windows absolute
    if name.len() >= 2 && name.as_bytes()[1] == b':' {
        bail!("absolute path not allowed in backup: {name}");
    }
    let path = Path::new(&name);
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            Component::ParentDir => bail!("path traversal not allowed: {name}"),
            Component::RootDir | Component::Prefix(_) => {
                bail!("absolute path not allowed in backup: {name}")
            }
        }
    }
    if out.as_os_str().is_empty() {
        bail!("empty path in backup");
    }
    Ok(out)
}

/// Extract backup zip with whitelist + size limits (no zip-slip into app dir).
fn safe_extract_backup_zip(zip_path: &Path, dest_root: &Path) -> Result<Vec<PathBuf>> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| anyhow!("open backup zip failed: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| anyhow!("invalid backup zip: {e}"))?;

    if archive.len() > BACKUP_MAX_ENTRIES {
        bail!(
            "backup has too many entries ({} > {})",
            archive.len(),
            BACKUP_MAX_ENTRIES
        );
    }

    let mut total: u64 = 0;
    let mut extracted = Vec::new();
    let mut seen_paths = HashSet::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| anyhow!("read zip entry {i}: {e}"))?;

        // Skip directories
        if entry.is_dir() {
            continue;
        }

        // Symlinks are not safe to materialize
        #[allow(deprecated)]
        if entry.unix_mode().is_some_and(|m| (m & 0o170000) == 0o120000) {
            bail!("symlink entries are not allowed in backup");
        }

        let raw_name = entry.name().to_string();
        let rel = match sanitize_zip_entry_name(&raw_name) {
            Ok(p) => p,
            Err(e) => {
                // Allow zip to contain empty dir markers; reject real dangerous files
                if raw_name.ends_with('/') {
                    continue;
                }
                logging!(
                    error,
                    Type::Backup,
                    "reject backup entry '{}': {e:#}",
                    raw_name
                );
                return Err(e);
            }
        };

        if !is_allowed_backup_rel_path(&rel) {
            logging!(
                warn,
                Type::Backup,
                "reject non-whitelisted backup path: {}",
                raw_name
            );
            bail!("backup contains non-whitelisted path: {raw_name}");
        }
        if !seen_paths.insert(rel.clone()) {
            bail!("backup contains duplicate path: {raw_name}");
        }

        let size = entry.size();
        if size > BACKUP_MAX_FILE_BYTES {
            bail!(
                "backup file too large: {} ({} bytes)",
                raw_name,
                size
            );
        }
        total = total.saturating_add(size);
        if total > BACKUP_MAX_TOTAL_BYTES {
            bail!("backup total size exceeds limit");
        }

        let out_path = dest_root.join(&rel);
        // Ensure still under dest_root after join
        let dest_canon = dest_root
            .canonicalize()
            .unwrap_or_else(|_| dest_root.to_path_buf());
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Write to temp then rename
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| anyhow!("read zip data {raw_name}: {e}"))?;
        if buf.len() as u64 > BACKUP_MAX_FILE_BYTES {
            bail!("backup file inflated beyond limit: {raw_name}");
        }

        // Path traversal check after full path built
        if let Ok(out_canon_parent) = out_path
            .parent()
            .unwrap_or(dest_root)
            .canonicalize()
        {
            if !out_canon_parent.starts_with(&dest_canon) {
                bail!("zip path escapes destination: {raw_name}");
            }
        }

        std::fs::write(&out_path, &buf)
            .map_err(|e| anyhow!("write restored file {raw_name}: {e}"))?;
        extracted.push(rel.clone());
        logging!(info, Type::Backup, "staged restored file: {}", rel.display());
    }

    if extracted.is_empty() {
        bail!("backup contained no allowed files");
    }
    Ok(extracted)
}

#[derive(Debug, Serialize)]
pub struct LocalBackupFile {
    pub filename: String,
    pub path: String,
    pub last_modified: String,
    pub content_length: u64,
}

#[derive(Clone)]
struct RestoreConfigSnapshot {
    clash: IClashTemp,
    profiles: IProfiles,
    verge: IVerge,
}

async fn capture_config_snapshot() -> RestoreConfigSnapshot {
    let clash_arc = Config::clash().await.data_arc();
    let profiles_arc = Config::profiles().await.data_arc();
    let verge_arc = Config::verge().await.data_arc();
    // `data_arc()` returns `&Box<T>`. Force resolution to `T::clone` so the
    // returned value is owned, not another Box.
    let clash_value: IClashTemp = <IClashTemp as Clone>::clone(&*clash_arc);
    let profiles_value: IProfiles = <IProfiles as Clone>::clone(&*profiles_arc);
    let verge_value: IVerge = <IVerge as Clone>::clone(&*verge_arc);
    RestoreConfigSnapshot {
        clash: clash_value,
        profiles: profiles_value,
        verge: verge_value,
    }
}

async fn restore_config_snapshot(snapshot: &RestoreConfigSnapshot) {
    let clash = Config::clash().await;
    clash.edit_draft(|draft| *draft = snapshot.clash.clone());
    clash.apply();

    let profiles = Config::profiles().await;
    profiles.edit_draft(|draft| *draft = snapshot.profiles.clone());
    profiles.apply();

    let verge = Config::verge().await;
    verge.edit_draft(|draft| *draft = snapshot.verge.clone());
    verge.apply();
}

async fn create_restore_staging_dir(app_home: &Path) -> Result<PathBuf> {
    let path = app_home.join(format!(".restore-staging-{}", nanoid::nanoid!()));
    fs::create_dir_all(&path).await?;
    Ok(path)
}

async fn prepare_staged_restore(
    staging_dir: &Path,
    files: &[PathBuf],
    webdav_url: Option<String>,
    webdav_username: Option<String>,
    webdav_password: Option<String>,
) -> Result<()> {
    let staged_verge = staging_dir.join(dirs::VERGE_CONFIG);
    if !staged_verge.exists() {
        bail!("backup is missing {}", dirs::VERGE_CONFIG);
    }

    // Parse every staged YAML before touching active configuration files.
    for relative in files {
        let path = staging_dir.join(relative);
        let is_yaml = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "yaml" | "yml"));
        if is_yaml {
            help::read_yaml::<serde_yaml_ng::Value>(&path).await?;
        }
    }

    let mut verge = help::read_yaml::<IVerge>(&staged_verge).await?;
    // A backup is never allowed to restore executable hooks or credentials.
    verge.startup_script = None;
    verge.webdav_url = webdav_url;
    verge.webdav_username = webdav_username;
    verge.webdav_password = webdav_password;
    fs::write(&staged_verge, serde_yaml_ng::to_string(&verge)?).await?;
    Ok(())
}

async fn commit_staged_restore(
    staging_dir: &Path,
    app_home: &Path,
    files: &[PathBuf],
) -> Result<RestoreTransaction> {
    let rollback_dir = app_home.join(format!(".restore-rollback-{}", nanoid::nanoid!()));
    fs::create_dir_all(&rollback_dir).await?;
    let mut transaction = RestoreTransaction {
        rollback_dir,
        files: Vec::with_capacity(files.len()),
    };

    // Create every parent before moving the first active file so a later
    // directory error cannot leave an earlier file committed.
    for relative in files {
        for path in [
            staging_dir.join(relative),
            app_home.join(relative),
            transaction.rollback_dir.join(relative),
        ] {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?;
            }
        }
    }

    for relative in files {
        let source = staging_dir.join(relative);
        let target = app_home.join(relative);
        let previous = if target.exists() {
            let snapshot = transaction.rollback_dir.join(relative);
            if let Err(error) = fs::rename(&target, &snapshot).await {
                let rollback = transaction.rollback().await;
                return match rollback {
                    Ok(()) => Err(anyhow!(
                        "snapshot active file {} failed: {error}",
                        relative.display()
                    )),
                    Err(rollback_error) => Err(anyhow!(
                        "snapshot active file {} failed: {error}; rollback also failed: {rollback_error}",
                        relative.display()
                    )),
                };
            }
            Some(snapshot)
        } else {
            None
        };

        transaction.files.push(RestoreFile {
            target: target.clone(),
            previous,
        });
        if let Err(error) = fs::rename(&source, &target).await {
            let rollback = transaction.rollback().await;
            return match rollback {
                Ok(()) => Err(anyhow!("commit restored file {} failed: {error}", relative.display())),
                Err(rollback_error) => Err(anyhow!(
                    "commit restored file {} failed: {error}; rollback also failed: {rollback_error}",
                    relative.display()
                )),
            };
        }
    }

    Ok(transaction)
}

async fn apply_committed_restore() -> Result<()> {
    let restored_verge = help::read_yaml::<IVerge>(&verge_path()?).await?;
    let restored_clash = IClashTemp::new().await;
    let restored_profiles = IProfiles::new().await;

    let clash = Config::clash().await;
    clash.edit_draft(|draft| *draft = restored_clash.clone());
    clash.apply();

    let profiles = Config::profiles().await;
    profiles.edit_draft(|draft| *draft = restored_profiles.clone());
    profiles.apply();

    let verge = Config::verge().await;
    verge.edit_draft(|draft| *draft = restored_verge.clone());
    verge.apply();

    // Do not hide runtime failures behind a successful file restore.
    super::patch_verge(&restored_verge, true).await
}

async fn restore_backup_zip(
    zip_path: PathBuf,
    webdav_url: Option<String>,
    webdav_username: Option<String>,
    webdav_password: Option<String>,
) -> Result<()> {
    let app_home = app_home_dir()?;
    let staging_dir = create_restore_staging_dir(&app_home).await?;
    let extract_staging = staging_dir.clone();
    let extracted = match AsyncHandler::spawn_blocking(move || {
        safe_extract_backup_zip(&zip_path, &extract_staging)
    })
    .await?
    {
        Ok(files) => files,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_dir).await;
            return Err(error);
        }
    };

    let result = async {
        prepare_staged_restore(
            &staging_dir,
            &extracted,
            webdav_url,
            webdav_username,
            webdav_password,
        )
        .await?;

        let config_snapshot = capture_config_snapshot().await;
        let transaction = commit_staged_restore(&staging_dir, &app_home, &extracted).await?;

        if let Err(apply_error) = apply_committed_restore().await {
            logging!(error, Type::Backup, "Restored config could not be applied: {apply_error:#}");
            restore_config_snapshot(&config_snapshot).await;
            let runtime_rollback = super::patch_verge(&config_snapshot.verge, true).await;
            let file_rollback = transaction.rollback().await;
            return match (runtime_rollback, file_rollback) {
                (Ok(()), Ok(())) => Err(anyhow!(
                    "backup restore was rolled back because runtime application failed: {apply_error}"
                )),
                (runtime, files) => Err(anyhow!(
                    "backup restore failed: {apply_error}; runtime rollback: {}; file rollback: {}",
                    runtime.err().map(|error| error.to_string()).unwrap_or_else(|| "ok".into()),
                    files.err().map(|error| error.to_string()).unwrap_or_else(|| "ok".into())
                )),
            };
        }

        transaction.commit().await?;
        Ok(())
    }
    .await;

    if let Err(error) = fs::remove_dir_all(&staging_dir).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        logging!(warn, Type::Backup, "Failed to remove restore staging directory: {error}");
    }
    result
}

/// Create a backup and upload to WebDAV
pub async fn create_backup_and_upload_webdav() -> Result<()> {
    let (file_name, temp_file_path) = backup::create_backup().await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to create backup: {err:#?}");
        err
    })?;

    if let Err(err) = backup::WebDavClient::global()
        .upload(temp_file_path.clone(), file_name)
        .await
    {
        logging!(error, Type::Backup, "Failed to upload to WebDAV: {err:#?}");
        // 上传失败时重置客户端缓存
        backup::WebDavClient::global().reset();
        return Err(err);
    }

    if let Err(err) = temp_file_path.remove_if_exists().await {
        logging!(warn, Type::Backup, "Failed to remove temp file: {err:#?}");
    }

    Ok(())
}

/// List WebDAV backups
pub async fn list_wevdav_backup() -> Result<Vec<ListFile>> {
    backup::WebDavClient::global().list().await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to list WebDAV backup files: {err:#?}");
        err
    })
}

/// Delete WebDAV backup
pub async fn delete_webdav_backup(filename: String) -> Result<()> {
    backup::WebDavClient::global().delete(filename).await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to delete WebDAV backup file: {err:#?}");
        err
    })
}

/// Restore WebDAV backup
pub async fn restore_webdav_backup(filename: String) -> Result<()> {
    let verge = Config::verge().await;
    let verge_data = verge.latest_arc();
    let webdav_url = verge_data.webdav_url.clone();
    let webdav_username = verge_data.webdav_username.clone();
    let webdav_password = verge_data.webdav_password.clone();

    let download_dir = app_home_dir()?
        .join(format!(".restore-download-{}", nanoid::nanoid!()));
    fs::create_dir_all(&download_dir).await?;
    let backup_storage_path = download_dir.join("backup.zip");
    let result = async {
        backup::WebDavClient::global()
            .download(filename, backup_storage_path.clone())
            .await
            .map_err(|err| {
                logging!(error, Type::Backup, "Failed to download WebDAV backup file: {err:#?}");
                err
            })?;
        restore_backup_zip(backup_storage_path.clone(), webdav_url, webdav_username, webdav_password).await
    }
    .await;
    if let Err(error) = fs::remove_dir_all(&download_dir).await {
        logging!(warn, Type::Backup, "Failed to remove WebDAV restore download directory: {error}");
    }
    result
}

/// Create a backup and save to local storage
pub async fn create_local_backup() -> Result<()> {
    create_local_backup_with_namer(|name| name.to_string().into())
        .await
        .map(|_| ())
}

pub async fn create_local_backup_with_namer<F>(namer: F) -> Result<String>
where
    F: FnOnce(&str) -> String,
{
    let (file_name, temp_file_path) = backup::create_backup().await.map_err(|err| {
        logging!(error, Type::Backup, "Failed to create local backup: {err:#?}");
        err
    })?;

    let backup_dir = local_backup_dir()?;
    let final_name = namer(file_name.as_str());
    let target_path = backup_dir.join(final_name.as_str());

    if let Err(err) = move_file(temp_file_path.clone(), target_path.clone()).await {
        logging!(error, Type::Backup, "Failed to move local backup file: {err:#?}");
        // 清理临时文件
        if let Err(clean_err) = temp_file_path.remove_if_exists().await {
            logging!(
                warn,
                Type::Backup,
                "Failed to remove temp backup file after move error: {clean_err:#?}"
            );
        }
        return Err(err);
    }

    Ok(final_name)
}

/// Import an existing backup file into the local backup directory
pub async fn import_local_backup(source: String) -> Result<String> {
    let source_path = PathBuf::from(source.as_str());
    if !source_path.exists() {
        return Err(anyhow!("Backup file not found: {source}"));
    }
    if !source_path.is_file() {
        return Err(anyhow!("Backup path is not a file: {source}"));
    }

    let ext = source_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "zip" {
        return Err(anyhow!("Only .zip backup files are supported"));
    }

    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Invalid backup file name"))?;

    let backup_dir = local_backup_dir()?;
    let target_path = backup_dir.join(file_name);

    if target_path == source_path {
        // Already located in the backup directory
        return Ok(file_name.to_string().into());
    }

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    if target_path.exists() {
        return Err(anyhow!("Backup file already exists: {file_name}"));
    }

    fs::copy(&source_path, &target_path)
        .await
        .map_err(|err| anyhow!("Failed to import backup file: {err:#?}"))?;

    Ok(file_name.to_string().into())
}

async fn move_file(from: PathBuf, to: PathBuf) -> Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).await?;
    }

    match fs::rename(&from, &to).await {
        Ok(_) => Ok(()),
        Err(rename_err) => {
            // Attempt copy + remove as fallback, covering cross-device moves
            logging!(
                warn,
                Type::Backup,
                "Failed to rename backup file directly, fallback to copy/remove: {rename_err:#?}"
            );
            fs::copy(&from, &to)
                .await
                .map_err(|err| anyhow!("Failed to copy backup file: {err:#?}"))?;
            fs::remove_file(&from)
                .await
                .map_err(|err| anyhow!("Failed to remove temp backup file: {err:#?}"))?;
            Ok(())
        }
    }
}

/// List local backups
pub async fn list_local_backup() -> Result<Vec<LocalBackupFile>> {
    let backup_dir = local_backup_dir()?;
    if !backup_dir.exists() {
        return Ok(vec![]);
    }

    let mut backups = Vec::new();
    let mut dir = fs::read_dir(&backup_dir).await?;
    while let Some(entry) = dir.next_entry().await? {
        let path = entry.path();
        let metadata = entry.metadata().await?;
        if !metadata.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|name| name.to_str()) {
            Some(name) => name,
            None => continue,
        };
        let last_modified = metadata
            .modified()
            .map(|time| chrono::DateTime::<Utc>::from(time).to_rfc3339())
            .unwrap_or_default();
        backups.push(LocalBackupFile {
            filename: file_name.into(),
            path: path.to_string_lossy().into(),
            last_modified: last_modified.into(),
            content_length: metadata.len(),
        });
    }

    backups.sort_by(|a, b| b.filename.cmp(&a.filename));
    Ok(backups)
}

/// Delete local backup
pub async fn delete_local_backup(filename: String) -> Result<()> {
    let backup_dir = local_backup_dir()?;
    let target_path = backup_dir.join(filename.as_str());
    if !target_path.exists() {
        logging!(warn, Type::Backup, "Local backup file not found: {}", filename);
        return Ok(());
    }
    target_path.remove_if_exists().await?;
    Ok(())
}

/// Restore local backup
pub async fn restore_local_backup(filename: String) -> Result<()> {
    let backup_dir = local_backup_dir()?;
    let target_path = backup_dir.join(filename.as_str());
    if !target_path.exists() {
        return Err(anyhow!("Backup file not found: {}", filename));
    }

    let (webdav_url, webdav_username, webdav_password) = {
        let verge = Config::verge().await;
        let verge = verge.latest_arc();
        (
            verge.webdav_url.clone(),
            verge.webdav_username.clone(),
            verge.webdav_password.clone(),
        )
    };

    restore_backup_zip(target_path, webdav_url, webdav_username, webdav_password).await
}

/// Export local backup file to user selected destination
pub async fn export_local_backup(filename: String, destination: String) -> Result<()> {
    let backup_dir = local_backup_dir()?;
    let source_path = backup_dir.join(filename.as_str());
    if !source_path.exists() {
        return Err(anyhow!("Backup file not found: {}", filename));
    }

    let dest_path = PathBuf::from(destination.as_str());
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    fs::copy(&source_path, &dest_path)
        .await
        .map(|_| ())
        .map_err(|err| anyhow!("Failed to export backup file: {err:#?}"))?;
    Ok(())
}
