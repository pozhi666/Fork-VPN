# Fork 商业模式说明

当前客户端可开启商业模式：注册登录、官方订阅同步和商城购买。

> 生产 API 必须经 HTTPS 域名访问。测试阶段的 HTTP 后端只可由显式测试配置使用，不能用于发布版客户端或视为安全上线。

## 与原版 Clash Verge 隔离

修改版产品名 **Fork**，可与安装版同时运行，互不抢配置：

| 项目 | 原版 | Fork |
|------|------|------|
| 产品名 | Clash Verge | **Fork** |
| 数据目录 | `%AppData%\io.github.clash-verge-rev.clash-verge-rev` | `%AppData%\com.fork.client`（dev 带 `.dev`） |
| 单例端口 | 33331 | 22331 / dev 22332 |
| mixed 端口 | 7897 | **17897** |
| socks / http | 7898 / 7899 | **17898 / 17899** |
| 控制器 | 127.0.0.1:9097 | **127.0.0.1:19097** |
| IPC 管道 | `\\.\pipe\verge-mihomo` | `\\.\pipe\fork-mihomo` |
| 深度链接 | clash:// | fork:// |

常量集中在 `src-tauri/src/commercial/mod.rs`。

## 账号和订阅

- 客户端可在登录页注册或使用已有账号登录；
- 空后端数据库不会创建默认管理员；管理员必须通过后端的 `npm run bootstrap-admin` 流程初始化；
- 登录成功后自动同步官方订阅；
- 商店页可开通付费线路；
- 会话本地缓存目前位于 `commercial_session.json`，后续将迁移到系统凭据库。

## 开关位置

| 位置 | 文件 |
|------|------|
| Rust 总开关 | `src-tauri/src/commercial/mod.rs` → `COMMERCIAL_MODE` |
| 前端 UI 开关 | `src/config/commercial.ts` → `COMMERCIAL_MODE` |

两处都设为 `false` 可恢复非商业模式行为。

## 后端和 API

后端源码：`D:\clash\fork-backend`。

本地开发：

```bash
cd D:\clash\fork-backend
npm install
npm run dev
```

本地调试可显式指定回环 HTTP 地址：

```text
FORK_API_BASE=http://127.0.0.1:8787/api/v1
```

正式发布 API（当前）：

```text
https://your-domain.example/api/v1
```

后端仅监听 `127.0.0.1:8787`，由 Nginx 提供 TLS（`your-domain.example`）。

### 自动更新（与原版相同：下载安装）

1. 本机密钥：`%USERPROFILE%\.tauri\fork.key`（私钥勿入库）  
2. 公钥已写入 `tauri.conf.json`  
3. 打包时设置 `TAURI_SIGNING_PRIVATE_KEY`  
4. 管理后台填写版本号 + 安装包 HTTPS 直链 + `.sig` 全文  
5. 清单：`https://your-domain.example/api/v1/client/updater/latest.json`  

详见 `docs/FORK_UPDATER.md`、`../docs/OPS_DONE.md`。

## 本地运行桌面端

```bash
corepack enable
pnpm install
pnpm run prebuild   # 需要下载 mihomo 内核
pnpm dev            # 需要已安装 Rust + Tauri 依赖
```

> 本机若未安装 Rust，无法完整启动桌面端；前端 `pnpm web:dev` 只能查看 UI，Tauri invoke 会失败。
