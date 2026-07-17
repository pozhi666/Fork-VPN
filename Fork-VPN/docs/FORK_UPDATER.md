# Fork 自动更新（与原版 Clash 相同流程）

客户端使用 **Tauri Updater**：检查 → 下载 → 安装 → 重启。  
清单由 **你们后台** 提供，不再请求 Clash Verge Rev。

## 1. 签名密钥（首次必做）

原版公钥无法用来签你们自己的包。生成 Fork 专用密钥：

```bash
cd Fork-VPN
pnpm tauri signer generate -w ~/.tauri/fork.key
```

- 私钥：`~/.tauri/fork.key`（**绝勿提交仓库**）
- 终端会打印 **公钥** base64，写入 `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`

打包时：

```bash
# Windows PowerShell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:USERPROFILE\.tauri\fork.key -Raw
# 若生成时设了密码：
# $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "..."
pnpm build
```

产物目录中有安装包和对应的 **`.sig` 文件**。

## 2. 后台发布

管理后台 → **客户端版本更新**：

| 字段 | 示例 |
|------|------|
| 最新版本号 | `0.1.1`（与 package.json / 安装包一致） |
| 更新说明 | 更新日志 |
| Windows 安装包 URL | `https://cdn.example.com/Fork_0.1.1_x64-setup.exe` |
| Windows 签名 | `.sig` 文件**全文**粘贴 |

保存后公开清单：

```text
GET https://your-domain.example/api/v1/client/updater/latest.json
```

客户端 `tauri.conf.json` 的 `endpoints` 已指向该地址。

## 3. 用户侧流程

1. 静默检查 / 强制更新弹窗读后台版本策略  
2. 点「立即更新」→ Tauri 拉 `latest.json` → 校验签名 → 下载安装包 → 安装重启  

## 4. 注意

- 版本号必须 **semver**，且与安装包内版本一致  
- URL 需客户端可直连 HTTPS  
- 换公钥后，所有旧客户端必须重新发一版才能用新签名更新链  
