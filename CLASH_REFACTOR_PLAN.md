# Clash 二次开发项目完整改造方案

> 适用范围：`D:\clash\Fork-VPN` 桌面客户端与 `D:\clash\fork-backend` 商业后端  
> 文档版本：1.0  
> 制定日期：2026-07-11  
> 方案性质：静态源码审查后的工程改造计划

---

## 1. 文档目的

本文用于指导当前 Clash 二次开发项目从“功能可用的 Fork”升级为具备以下能力的可长期维护产品：

- 安全的账号、支付、订阅和更新链路；
- 可靠的数据持久化、事务和故障恢复；
- 客户端 UI 状态与真实代理运行状态一致；
- 明确的前端、Rust、后端模块边界和接口契约；
- 可自动验证的测试、CI、发布、签名和回滚流程；
- 完整的可观测性、运维和合规基础；
- 可继续演进的用户体验、性能、国际化和无障碍能力。

本方案不要求一次性推倒重写。建议按照本文优先级逐步迁移，每个阶段都应形成可独立验收、可回滚的交付物。

---

## 2. 项目范围和当前技术栈

### 2.1 桌面客户端

路径：`D:\clash\Fork-VPN`

主要技术：

- Tauri 2；
- Rust 2024；
- React 19；
- TypeScript；
- Vite 8；
- MUI + Emotion；
- SWR；
- Mihomo IPC/WebSocket；
- YAML profile、merge、script 和 runtime 配置；
- Tauri updater；
- Windows/macOS/Linux 多平台打包。

### 2.2 商业后端

路径：`D:\clash\fork-backend`

主要技术：

- Node.js ESM；
- Express 5；
- JWT；
- bcryptjs；
- JSON 文件数据库；
- 易支付兼容支付回调；
- js-yaml 订阅解析与合并；
- 静态管理后台。

### 2.3 当前整体判断

客户端上游工程基础较好，已有内核生命周期管理、配置验证与回滚、虚拟列表、Web Worker、Canvas 流量图、路由懒加载和跨平台发布框架。

主要不足集中在：

1. 商业后端仍是原型级实现；
2. 默认管理员、JWT、HTTP API 等安全配置不适合生产；
3. 备份恢复、WebDAV 和 Tauri 权限存在较高风险；
4. 账号、支付、订阅、更新缺少完整信任链；
5. UI 操作与 Rust 真实运行状态可能不一致；
6. TS、Rust、Node 三端接口依赖手工同步；
7. 前后端测试和运行时验证明显不足；
8. CI、依赖来源、签名和发布门禁不完整。

---

## 3. 改造总原则

### 3.1 安全默认原则

- 生产环境不得存在默认账号、默认密码和默认密钥；
- 生产环境不得使用 HTTP 传输账号、Token、订单或订阅；
- 不可信输入不得直接变为文件、Shell、URL、HTML 或系统配置操作；
- WebView 即使发生内容注入，也不应获得任意文件和命令执行能力；
- 所有敏感操作采用最小权限和明确白名单。

### 3.2 单一事实源原则

- 运行状态以 Rust/native 层核验结果为准；
- 服务端状态以事务数据库为准；
- API 结构以 OpenAPI/Schema 为准；
- Tauri IPC 类型以 Rust 自动生成的 binding 为准；
- 版本、产品名称、API 地址和协议常量只保留一个权威来源。

### 3.3 事务和可补偿原则

配置、节点、订阅、TUN、系统代理和支付权益等操作，应遵循：

```text
validate -> plan -> lock -> execute -> verify -> persist -> notify -> unlock
```

操作失败时必须满足以下至少一项：

- 完整回滚；
- 执行补偿；
- 明确报告部分成功；
- 提供可重试和人工恢复入口。

不得出现 UI 显示成功、底层实际失败的情况。

### 3.4 增量迁移原则

- 不一次性重写全部客户端；
- 先通过 façade/repository/adapter 建立边界；
- 新功能只进入新架构；
- 旧功能逐模块迁移；
- 每次迁移都必须有契约测试和回归验证。

---

# 4. P0：发布和运营前必须完成的安全止血

## 4.1 修复备份恢复导致的启动脚本执行链

### 现状证据

- `Fork-VPN/src-tauri/src/feat/backup.rs:129-137`
- `Fork-VPN/src-tauri/src/feat/backup.rs:314-318`
- `Fork-VPN/src-tauri/src/utils/resolve/mod.rs:119-121`
- `Fork-VPN/src-tauri/src/utils/init.rs:411-447`

当前备份恢复会将 ZIP 内容直接解压至应用目录，恢复后的 `verge.yaml` 可携带 `startup_script`，应用下次启动时可能执行备份中植入的 PowerShell、Batch 或 Shell 脚本。

### 改造方案

建立版本化备份格式：

```text
backup.json
config.yaml
verge.yaml
profiles.yaml
dns_config.yaml
profiles/<safe-file-name>.yaml
```

新增 `BackupManifestV2`：

```json
{
  "version": 2,
  "created_at": "ISO-8601",
  "app_version": "x.y.z",
  "files": [
    {
      "path": "config.yaml",
      "size": 1234,
      "sha256": "..."
    }
  ]
}
```

恢复流程：

1. 将 ZIP 解压到随机临时目录；
2. 遍历全部条目；
3. 只允许白名单路径；
4. 拒绝绝对路径、`..`、符号链接、重复条目和过深目录；
5. 限制条目数量、单文件大小和解压总大小；
6. 校验 manifest 中的 SHA-256；
7. 解析 YAML 并清除敏感或危险字段；
8. 不恢复 `startup_script`、JWT、WebDAV 密码和本地加密密钥；
9. 对恢复后的配置执行完整验证；
10. 创建当前配置快照；
11. 使用原子替换提交恢复结果；
12. 失败时恢复旧配置。

### 启动脚本进一步治理

- 仅允许用户通过系统文件选择器显式选择；
- 保存 canonical path；
- 显示脚本路径、Hash 和最近修改时间；
- 脚本被修改后重新要求确认；
- 禁止从备份、订阅、远程响应或 deep link 自动设置；
- 可选：将启动脚本功能放入高级开发者模式。

### 验收标准

- 包含 `../evil.ps1` 的 ZIP 被拒绝；
- 包含绝对路径和符号链接的 ZIP 被拒绝；
- ZIP bomb 被限制；
- 恢复后的配置不包含 `startup_script`；
- 恢复失败后原配置保持不变；
- 应用重启不会执行恢复包中的任何脚本。

---

## 4.2 移除默认管理员和默认 JWT 密钥

### 现状证据

- `fork-backend/src/seed.js:7-17`
- `fork-backend/src/auth.js:4`
- `fork-backend/src/server.js:27`
- `fork-backend/src/server.js:14-18`
- `Fork-VPN/COMMERCIAL.md:56-60`

### 改造方案

#### 生产配置检查

新增 `validateProductionConfig()`。生产模式缺少以下配置时拒绝启动：

- `FORK_JWT_SECRET`；
- `FORK_PUBLIC_URL`；
- 数据库连接；
- 支付商户号和支付密钥；
- 管理员初始化状态；
- HTTPS 反向代理标识或安全部署声明。

JWT secret 要求：

- 至少 32 字节随机数据；
- 禁止开发占位值；
- 禁止提交到仓库；
- 支持版本号和轮换。

#### 管理员初始化

移除启动时自动创建固定管理员，新增：

```bash
npm run bootstrap-admin
```

初始化规则：

- 必须提供一次性 bootstrap token；
- 管理员用户名和密码由部署者输入；
- 密码执行强度校验；
- 初始化成功后 bootstrap token 失效；
- 不在日志打印明文密码；
- 首次登录可要求设置 TOTP。

#### 网络暴露

- 默认监听 `127.0.0.1`；
- 公网部署必须经 Caddy/Nginx；
- 管理后台可配置独立域名；
- 管理接口增加 IP allowlist 或 VPN 限制；
- CORS 改为明确 allowlist。

### 线上处置

如果当前后端已经部署：

1. 立即修改管理员密码；
2. 轮换 JWT secret；
3. 轮换支付密钥；
4. 使全部现有 Token 失效；
5. 检查管理员、用户、订单、订阅源和更新配置的历史改动；
6. 检查访问日志中是否存在异常 admin 请求。

### 验收标准

- 空数据库启动后不存在默认管理员；
- 未设置强 JWT secret 时生产服务启动失败；
- `admin/admin123` 无法登录；
- 源码和文档中不存在生产默认口令；
- 管理后台默认不能从公网直接访问。

---

## 4.3 商业 API、支付和订阅全面 HTTPS 化

### 现状证据

- `Fork-VPN/src-tauri/src/commercial/api.rs:8-20`
- `Fork-VPN/src/services/commercial.ts:191-205`
- `fork-backend/src/ezpay.js:8-24`

### 改造方案

- 使用正式 HTTPS 域名；
- 客户端发布构建拒绝 `http://` API；
- Rust 和 TS 不再分别维护默认 IP；
- API base 从统一构建配置生成；
- 开发 HTTP 仅通过明确 development feature 启用；
- 反向代理启用 TLS 1.2+、HSTS 和自动续期；
- 支付通知地址仅允许 HTTPS；
- 禁止 HTTPS 重定向到 HTTP；
- 对下载页和支持链接使用域名 allowlist。

### Token 方案

建议改为：

- Access Token：10～30 分钟；
- Refresh Token：可轮换、可吊销；
- Token 包含 `iss`、`aud`、`jti`；
- 管理员 Token 有更短有效期；
- 修改密码、封禁账号、退出登录时撤销 session；
- 服务端保存 refresh session 的 Hash，不保存明文 Token。

### 桌面端凭据存储

使用系统凭据库：

- Windows：Credential Manager 或 DPAPI；
- macOS：Keychain；
- Linux：Secret Service/libsecret。

不得继续将长期 Bearer Token 明文写入 `commercial_session.json`。

### 验收标准

- 发布构建配置 HTTP API 时构建或启动失败；
- MITM 替换证书时登录失败；
- 磁盘中不存在明文 Bearer Token；
- 退出登录后 refresh session 被服务端撤销；
- 支付回调 URL 必须是 HTTPS。

---

## 4.4 统一更新信任链

### 现状

项目同时存在：

1. Tauri 签名 updater；
2. 商业后端返回强制更新和 `download_url`。

相关文件：

- `Fork-VPN/src-tauri/tauri.conf.json:31-42`
- `Fork-VPN/src/components/layout/force-update-dialog.tsx:42-166`

### 目标方案

程序二进制更新只允许通过 Tauri 签名 updater 完成。

商业后端只提供：

- 最低支持 API 版本；
- 运营公告；
- 当前版本是否建议升级；
- 固定产品官网链接 ID。

商业后端不得提供任意可执行文件下载地址。

如果保留“强制升级”产品体验：

- 客户端调用 Tauri updater；
- updater manifest 必须签名；
- 下载制品必须通过 Tauri 签名验证；
- UI 只负责提示，不负责决定下载来源；
- 服务端 API 版本准入与二进制更新信任链分开处理。

### 验收标准

- 后端篡改 `download_url` 无法触发任意网址或程序下载；
- 签名错误的安装包不能安装更新；
- updater endpoint 被篡改时更新失败而不是降级接受。

---

## 4.5 固定预构建原生依赖来源和 Hash

### 现状证据

- `Fork-VPN/scripts/prebuild.mjs:172-180`
- `Fork-VPN/scripts/prebuild.mjs:230-275`
- `Fork-VPN/scripts/prebuild.mjs:494-537`
- `Fork-VPN/scripts/prebuild.mjs:579-737`

### 改造方案

新增 `native-assets.lock.json`：

```json
{
  "mihomo-windows-amd64": {
    "version": "x.y.z",
    "url": "https://...",
    "sha256": "...",
    "source": "MetaCubeX/mihomo"
  }
}
```

规则：

- 禁止下载 `latest`；
- 固定版本和 URL；
- 下载后强制校验 SHA-256；
- 支持签名的上游同时验签；
- Hash 不匹配立即失败；
- lock 文件变更要求 code owner 审批；
- CI 记录原生制品来源；
- 每次发布生成 SBOM 和原生资产清单。

### 验收标准

- 上游替换同名资产后构建失败；
- 无 lock 清单的资产不能进入安装包；
- 发布制品可追溯到明确的版本、URL 和 Hash。

---

# 5. 后端生产化改造

## 5.1 数据库迁移

### 当前问题

`fork-backend/src/db.js` 使用 JSON 文件同步覆盖写入。解析失败时可能重建空数据库，且无法保证并发、事务、唯一约束和支付一致性。

### 数据库选型

推荐优先级：

1. 正式商业部署：PostgreSQL；
2. 明确单机、小规模部署：SQLite WAL；
3. 不再继续扩展 JSON 文件数据库。

### 建议数据模型

#### users

- `id`
- `username`
- `email`
- `password_hash`
- `status`
- `created_at`
- `updated_at`
- `disabled_at`

#### admin_users

- `id`
- `username`
- `password_hash`
- `totp_secret_encrypted`
- `status`
- `created_at`
- `last_login_at`

#### sessions

- `id/jti`
- `user_id`
- `role`
- `refresh_token_hash`
- `expires_at`
- `revoked_at`
- `created_ip`
- `last_used_at`

#### products

- `id`
- `name`
- `price_cents`
- `duration_days`
- `traffic_bytes`
- `status`
- `created_at`
- `updated_at`

#### orders

- `id`
- `out_trade_no`
- `user_id`
- `product_id`
- `amount_cents`
- `status`
- `provider`
- `provider_trade_no`
- `created_at`
- `paid_at`
- `cancelled_at`

#### payment_events

- `id`
- `provider`
- `event_key`
- `raw_payload_encrypted`
- `signature_valid`
- `processed_at`
- `result`

#### entitlements

- `id`
- `user_id`
- `product_id`
- `starts_at`
- `expires_at`
- `traffic_limit_bytes`
- `status`
- `source_order_id`

#### subscription_sources

- `id`
- `name`
- `url_encrypted`
- `access_level`
- `status`
- `fetch_policy`
- `created_at`
- `updated_at`

#### announcements

- `id`
- `title`
- `content`
- `status`
- `starts_at`
- `ends_at`

#### audit_logs

- `id`
- `actor_type`
- `actor_id`
- `action`
- `target_type`
- `target_id`
- `request_id`
- `metadata`
- `created_at`

### 关键约束

- 用户名和邮箱唯一；
- `out_trade_no` 唯一；
- 支付平台交易号唯一；
- 金额使用整数分，不使用浮点数；
- 订单兑现和权益发放在同一事务；
- 支付事件 append-only；
- 删除商品不能破坏历史订单；
- migration 有明确版本；
- 启动时不自动执行不可逆数据修正。

### 迁移步骤

1. 冻结 JSON schema；
2. 编写 JSON 数据检查工具；
3. 清理重复用户、订单和非法值；
4. 创建数据库 migration；
5. 编写一次性导入工具；
6. 双读校验；
7. 暂停写入并最终迁移；
8. 切换数据库 repository；
9. 保留只读 JSON 备份；
10. 做恢复演练。

---

## 5.2 后端目录和模块拆分

建议结构：

```text
fork-backend/
  src/
    app/
      create-app.ts
    config/
      env.ts
    http/
      middleware/
        auth.ts
        error-handler.ts
        rate-limit.ts
        request-id.ts
      routes/
        auth.routes.ts
        catalog.routes.ts
        orders.routes.ts
        subscriptions.routes.ts
        admin.routes.ts
    domain/
      auth/
      orders/
      entitlements/
      subscriptions/
    services/
      auth-service.ts
      order-service.ts
      payment-service.ts
      subscription-service.ts
    repositories/
      user-repository.ts
      order-repository.ts
      entitlement-repository.ts
    db/
      migrations/
      client.ts
    schemas/
      auth.schema.ts
      order.schema.ts
      admin.schema.ts
    security/
      password.ts
      tokens.ts
      ssrf.ts
      url-policy.ts
    observability/
      logger.ts
      metrics.ts
      audit.ts
```

职责要求：

- Route：HTTP 参数和响应转换；
- Schema：运行时输入输出验证；
- Service：业务用例；
- Domain：订单、权益和访问规则；
- Repository：数据库访问；
- Security：认证、SSRF、URL 和密码策略；
- Observability：日志、指标和审计。

禁止 route 直接修改数据库对象。

---

## 5.3 输入输出 Schema

建议后端迁移 TypeScript，并使用 Zod 或同类 schema 工具。

所有写接口必须校验：

- 字符串长度；
- 枚举；
- 整数范围；
- URL scheme；
- 日期格式；
- 数组数量；
- 对象未知字段；
- 正数/非负数；
- 价格和时长上限。

示例约束：

```text
price_cents: integer, 0..100000000
duration_days: integer, 1..3650
traffic_bytes: integer, >= 0
status: active | inactive | archived
source URL: HTTPS only by default
announcement length: bounded
```

统一错误响应：

```json
{
  "error": {
    "code": "ORDER_AMOUNT_MISMATCH",
    "message": "...",
    "request_id": "...",
    "details": {}
  }
}
```

前端不依赖随意变化的中文错误字符串判断逻辑。

---

## 5.4 支付和权益状态机

### 订单状态

```text
pending
payment_confirmed
fulfilled
cancelled
expired
refunded
failed
```

### 支付回调流程

```text
接收回调
-> 记录 payment_event
-> 验证签名
-> 验证商户号
-> 查找订单
-> 验证金额
-> 检查 provider_trade_no 唯一性
-> 锁定订单
-> 更新订单状态
-> 发放权益
-> 标记 fulfilled
-> 提交事务
-> 返回成功
```

要求：

- 重复回调不重复发放权益；
- 数据库失败时不返回处理成功；
- 支付平台重试可安全执行；
- 管理员手工修改订单必须进入审计日志；
- 预留退款和撤销权益流程；
- 支付成功、订阅同步失败不能回滚支付权益，应进入可重试同步状态。

---

## 5.5 SSRF 和订阅抓取防护

相关位置：

- `fork-backend/src/subscription.js:81-174`
- `fork-backend/src/routes.js:805-887`

必须实现：

1. 默认只允许 HTTPS；
2. URL 解析后检查 scheme；
3. DNS 解析后检查所有 IP；
4. 禁止：
   - loopback；
   - RFC1918；
   - link-local；
   - IPv6 ULA；
   - CGNAT；
   - 云元数据 IP；
   - IPv4-mapped IPv6；
5. 每次重定向后重新检查；
6. 限制重定向次数；
7. 限制连接、读取和总超时；
8. 流式读取并限制响应大小；
9. 限制 YAML 深度、节点数量和字段长度；
10. 限制并发抓取数量；
11. 配置出站网络 ACL；
12. 记录抓取目标、结果和 request ID，但对 Token 脱敏。

---

# 6. 客户端状态一致性改造

## 6.1 建立 Core Action Coordinator

需要统一协调的动作：

- 切换 profile；
- 切换代理节点；
- 切换代理模式；
- 开关链式代理；
- 开关系统代理；
- 开关 TUN；
- reload/restart core；
- 同步商业订阅；
- 批量更新 profile。

定义统一操作模型：

```rust
struct OperationRequest<T> {
    operation_id: String,
    request_version: u64,
    payload: T,
}

struct OperationResult<T> {
    operation_id: String,
    status: OperationStatus,
    actual_state: Option<T>,
    completed_steps: Vec<OperationStep>,
    failed_step: Option<OperationStep>,
    rollback_status: Option<RollbackStatus>,
    error: Option<AppError>,
}
```

状态：

```text
pending
running
succeeded
partial
failed
rolling_back
rolled_back
```

### 核心规则

- 同一资源操作串行化；
- 每个资源维护最新 request version；
- 旧版本操作不得覆盖新版本；
- 前端 AbortController 不能替代后端并发控制；
- UI 成功状态必须来自 `actual_state`；
- 部分成功必须明确显示。

---

## 6.2 修复 profile 快速切换竞态

相关位置：

- `Fork-VPN/src/pages/profiles.tsx:432-459`
- `Fork-VPN/src/hooks/use-profiles.ts:33-60`
- `Fork-VPN/src/services/cmds.ts:22-26`

推荐实现：

1. 前端生成递增 `request_version`；
2. Rust 收到切换请求后记录该 profile 资源的最新版本；
3. 在提交运行配置和持久化前检查版本；
4. 旧操作发现版本落后时返回 `superseded`；
5. 成功后重新读取 current profile；
6. UI 只依据 Rust 返回的 current profile 更新。

### 验收标准

在 mock 中使 A 请求比 B 请求更晚完成，连续执行 100 次 A→B：

- UI current profile 为 B；
- `profiles.yaml` current 为 B；
- runtime config 来源为 B；
- Mihomo 当前代理和规则来自 B；
- A 返回 `superseded`，不能覆盖 B。

---

## 6.3 修复链式代理状态撒谎

相关位置：

- `Fork-VPN/src/pages/proxies.tsx:74-90`

关闭链式代理时不能先更新 localStorage 和 React 状态。

新流程：

```text
UI 显示 closing
-> Rust 读取实际 chain runtime
-> 生成清理计划
-> 清理 runtime chain
-> 恢复必要节点
-> 处理连接
-> 验证 runtime config
-> 持久化设置
-> 返回 actual_state=disabled
-> UI 更新
```

失败时：

- UI 保持 enabled 或 unknown；
- 显示失败步骤；
- 提供“重新同步”和“恢复默认链路”；
- 不得仅写 `console.error`。

---

## 6.4 节点选择的运行时与持久化一致性

相关位置：

- `Fork-VPN/src/hooks/use-proxy-selection.ts:81-115`
- `Fork-VPN/src/components/proxy/proxy-groups.tsx:424-432`

将以下动作组合为一个用例：

1. Mihomo runtime 选择节点；
2. 保存 profile selection；
3. 同步托盘；
4. 根据策略关闭或保留连接；
5. 重新读取实际选择结果。

如果 runtime 成功但持久化失败：

- 返回 `partial`；
- UI 显示“已临时切换，但未保存”；
- 提供重试持久化；
- 不得静默失败。

---

## 6.5 配置变更事务

相关位置：

- `Fork-VPN/src-tauri/src/feat/config.rs:202-290`

当前配置修改可能先执行内核、系统代理、自动启动、热键和托盘副作用，最后保存；失败时只回滚 Draft，无法保证系统状态恢复。

建议建立：

```text
ConfigChangeRequest
ConfigChangePlan
ConfigExecutionJournal
ConfigChangeResult
```

执行步骤：

1. 读取旧配置和实际系统状态；
2. 合并 patch；
3. 校验新配置；
4. 计算变更计划；
5. 为每个步骤声明补偿动作；
6. 依序执行；
7. 记录 journal；
8. 验证实际状态；
9. 原子保存配置；
10. 发布 typed event；
11. 失败时逆序补偿。

不可回滚操作必须返回 `partial`，不能伪装为普通失败。

---

# 7. Tauri 权限和桌面安全改造

## 7.1 当前风险位置

- CSP 关闭：`Fork-VPN/src-tauri/tauri.conf.json:49-60`
- 文件范围 `**`：`Fork-VPN/src-tauri/capabilities/migrated.json:8-18`
- Shell 权限：`Fork-VPN/src-tauri/capabilities/migrated.json:66-81`
- 任意 HTTP/HTTPS：`Fork-VPN/src-tauri/capabilities/desktop.json:22-27`
- 原始 HTML Markdown：`Fork-VPN/src/components/setting/mods/update-viewer.tsx:48-56`

## 7.2 Capability 重建

按窗口和业务能力拆分：

```text
main-window.json
settings-window.json
update-window.json
```

主窗口只保留必要能力。

文件 scope 建议限制为：

```text
$APPDATA/<product>/profiles/**
$APPDATA/<product>/icons/**
$APPDATA/<product>/logs/**
用户通过系统文件选择器显式授权的文件
```

删除通用：

- `shell:default`；
- 任意 execute；
- 任意 spawn；
- 任意 stdin write；
- 全盘文件 `**`；
- `http://*/*`；
- `https://*/*`。

## 7.3 用专用 Rust command 替代 Shell

示例：

```text
open_support_link(link_id)
open_app_data_directory()
install_service()
repair_service()
run_user_confirmed_startup_script(script_id)
```

每个 command：

- 固定动作；
- 固定程序；
- 固定参数结构；
- 禁止前端传入任意可执行文件；
- 校验 canonical path；
- 记录安全审计日志。

## 7.4 CSP

建议基础策略：

```text
default-src 'self'
script-src 'self'
style-src 'self' 'unsafe-inline'
img-src 'self' asset: data: https:
connect-src 'self' ipc: http://127.0.0.1:<mihomo-port> https://<api-domain>
object-src 'none'
base-uri 'none'
frame-ancestors 'none'
```

实际配置应根据 Tauri 运行要求调整，但目标是禁止：

- 远程脚本；
- `eval`；
- 任意 connect；
- 插件对象；
- 未授权 frame。

## 7.5 远程内容

- 更新说明默认禁用 `rehypeRaw`；
- 如必须支持 HTML，使用严格 sanitizer allowlist；
- 公告内容不能注入 script、iframe、style 和事件属性；
- 外链只允许 HTTPS；
- 订阅返回的主页 URL 需要协议校验和用户确认。

---

# 8. 前端架构改造

## 8.1 Tauri IPC 自动生成

当前前端命令集中于：

- `Fork-VPN/src/services/cmds.ts`

Rust handler 位于：

- `Fork-VPN/src-tauri/src/lib.rs:132-230`

建议使用 Specta 或 ts-rs 从 Rust 生成 TypeScript binding。

拆分为：

```text
src/services/ipc/
  profiles-api.ts
  core-api.ts
  system-api.ts
  backup-api.ts
  commercial-api.ts
  generated/
```

CI 增加：

- binding 重新生成后必须无 diff；
- TS 引用的 command 必须存在；
- 参数和返回类型必须一致；
- 删除或修复 `clear_logs` 等疑似失配调用。

## 8.2 商业 API OpenAPI 化

建立 OpenAPI 3.1 规范：

```text
contracts/commercial-api.openapi.yaml
```

由它生成：

- 后端请求响应校验；
- Rust API client DTO；
- TypeScript API client DTO；
- API 文档；
- contract tests。

API 版本策略：

- URL 主版本，例如 `/api/v1`；
- 响应包含兼容版本；
- 字段新增保持向后兼容；
- 删除字段必须跨版本；
- 客户端声明支持的 API 范围。

## 8.3 收敛缓存

当前 SWR 与自建 Map 双缓存位于：

- `Fork-VPN/src/services/query-client.ts:32-132`

目标：只保留一个 server-state cache。

低成本方案：继续使用 SWR，并删除自建全局 Map。

建立 typed query keys：

```ts
queryKeys.profiles.all()
queryKeys.profiles.current()
queryKeys.core.status()
queryKeys.system.proxy()
queryKeys.connections.active()
queryKeys.rules.current()
```

规则：

- render 期间不写缓存；
- mutation 后精确失效；
- typed event 映射到 typed query key；
- 不再通过多个字符串数组批量猜测 invalidation。

## 8.4 统一 ResourceState

```ts
type ResourceState<T> =
  | { status: "loading"; previous?: T }
  | { status: "ready"; data: T; updatedAt: number }
  | { status: "empty"; updatedAt: number }
  | { status: "stale"; data?: T; error: AppError; updatedAt?: number }
  | { status: "error"; error: AppError };
```

应用到：

- proxies；
- rules；
- connections；
- logs；
- traffic；
- profiles；
- providers；
- commercial catalog/order。

每个页面必须区分：

- 初次加载；
- 真正为空；
- 核心未启动；
- WebSocket 断开；
- 正在重连；
- 使用旧数据；
- 权限/认证失败。

## 8.5 核心状态机

Rust 对外暴露：

```text
initializing
stopped
starting
running_sidecar
running_service
reloading
switching_profile
degraded
failed
```

附加字段：

```text
operation_id
since
last_error
last_successful_contact
core_version
runtime_mode
```

UI 不再通过多个布尔值推断真实状态。

## 8.6 前端目录逐步转为 feature-based

目标结构：

```text
src/
  app/
  shared/
    components/
    hooks/
    types/
  features/
    core/
    profiles/
    proxies/
    connections/
    rules/
    logs/
    system-proxy/
    tun/
    backup/
    commercial/
    settings/
  services/
    ipc/
    api/
```

迁移顺序：

1. commercial；
2. profiles；
3. core/system proxy/TUN；
4. proxies；
5. observations；
6. settings。

---

# 9. UX、可访问性和性能改造

## 9.1 全局状态栏

建议所有页面持续显示：

```text
内核状态 | 当前订阅 | 代理模式 | 当前出口 | 系统代理 | TUN | 活动连接数 | 最后错误
```

每个状态可点击进入详情或诊断页面。

## 9.2 操作结果透明化

节点切换应显示：

- 运行时是否成功；
- 是否保存；
- 托盘是否同步；
- 是否关闭连接；
- 是否部分成功。

会关闭连接的操作应提前显示影响数量，并在操作后显示关闭结果。

## 9.3 加载、空态和错误态

当前部分 Suspense fallback 为 `null`：

- `Fork-VPN/src/pages/_routers.tsx:90-102`
- `Fork-VPN/src/pages/_layout.tsx:567-580`

改为统一 Route Skeleton：

- 保留页面标题；
- 100ms 内显示 loading；
- 支持 chunk load retry；
- 使用 `aria-busy`；
- 不出现无反馈空白。

ErrorBoundary 改为：

- 用户可读原因；
- 错误 ID；
- 重试页面；
- 返回首页；
- 重连内核；
- 复制诊断；
- stack 仅在开发模式或手动展开时显示。

## 9.4 可访问性

删除：

- `Fork-VPN/src/pages/_layout/hooks/use-custom-theme.ts:302-305` 中全局 `outline: none !important`。

统一 `:focus-visible` 样式。

将关键 `Box/Paper/div onClick` 替换为：

- Button；
- IconButton；
- ToggleButton；
- ListItemButton；
- RadioGroup。

键盘必须能完成：

- 切换订阅；
- 切换节点；
- 切换代理模式；
- 打开连接详情；
- 操作搜索选项；
- 确认和关闭弹窗；
- 使用 Escape 返回触发控件。

使用 axe 作为自动化门禁，禁止 serious/critical violation。

## 9.5 国际化

重点清理：

- 登录；
- 注册；
- 商城；
- 支付状态；
- 当前代理健康；
- ErrorBoundary；
- 图表控制；
- 公告；
- 强制更新提示。

CI 检查：

- locale key 完整性；
- 用户可见硬编码字符串；
- 长文本语言；
- RTL；
- 日期、数字和流量单位本地化。

## 9.6 支付恢复体验

保存本地待处理订单状态：

```text
order_id
product_id
created_at
last_checked_at
status
```

商城进入时恢复未完成订单，并提供：

- 我已支付，立即检查；
- 稍后检查；
- 停止本地轮询；
- 支付成功后重试同步；
- 查看订单状态。

轮询必须支持 AbortSignal，页面卸载时停止。

## 9.7 信息架构

建议一级导航：

1. 状态中心；
2. 代理；
3. 订阅与配置；
4. 观察：Connections、Traffic、Logs；
5. 诊断与工具：Rules、测速、流媒体解锁、IP 检测；
6. 设置。

完整测速页 `src/pages/test.tsx` 应正式注册为路由，首页只保留概览和入口。

## 9.8 性能预算

### 基准数据集

- 10,000 个代理节点；
- 1,000 条规则；
- 5,000 个活动连接；
- 每秒两次连接快照；
- 每秒 100 条日志；
- 连续运行 60 分钟。

### 指标

- 搜索和筛选 p95 输入响应低于 100ms；
- 主线程超过 50ms 的长任务可监控并设置预算；
- 窗口隐藏后停止非必要图表绘制和轮询；
- 日志严格不超过 1,000 条；
- 已关闭连接严格不超过 500 条；
- 高频更新不触发整页重渲染。

### Bundle

当前 `vite.config.mts` 的 4MB 警告阈值过宽，应：

- 降低 chunk warning；
- CI 输出 gzip/brotli；
- Monaco 独立 chunk；
- 商城、解锁和编辑器保持 lazy；
- 设置首屏和异步 chunk 回归预算。

---

# 10. 文件写入可靠性

## 10.1 客户端原子写

相关位置：

- `Fork-VPN/src-tauri/src/utils/help.rs:61-73`
- `Fork-VPN/src-tauri/src/cmd/save_profile.rs:55-90`
- `Fork-VPN/src-tauri/src/config/profiles.rs:164-269`

统一实现 `atomic_write()`：

```text
写同目录临时文件
-> flush
-> fsync 临时文件
-> 原子 rename
-> 必要时 fsync 父目录
-> 保留上一个已验证版本
```

适用于：

- verge.yaml；
- config.yaml；
- profiles.yaml；
- DNS 配置；
- profile 文件；
- commercial metadata；
- backup manifest。

解析失败时：

- 不覆盖原文件；
- 进入恢复模式；
- 提供恢复上一版本入口；
- 记录错误和文件 Hash。

## 10.2 后端数据库备份

迁移数据库后要求：

- 自动备份；
- 加密存储；
- 明确保留周期；
- 定期恢复演练；
- 数据库 migration 前备份；
- 支付事件保留独立审计记录。

---

# 11. 测试体系

建议执行时间比例：

- 65% 单元测试；
- 25% 集成与契约测试；
- 10% E2E、安装和发布验证。

## 11.1 后端单元测试

### 认证

- 生产缺少 JWT secret 拒绝启动；
- Token 过期；
- issuer/audience 错误；
- 角色越权；
- 密钥轮换；
- 修改密码后 session 撤销；
- 禁用用户不能刷新 Token。

### 订单和支付

- pending -> fulfilled；
- 回调重放；
- 金额不符；
- 商户号不符；
- 交易号重复；
- 未知订单；
- 数据库异常；
- 权益只发放一次；
- 退款/撤销预留。

### 权益

- 到期；
- 延期；
- 撤销；
- 多商品；
- public/locked source；
- access fingerprint。

### 订阅

- YAML/base64/URI；
- 去重；
- 超时；
- 响应过大；
- SSRF；
- 重定向；
- YAML 深度和节点数。

推荐：Vitest + Supertest。

## 11.2 前端单元和组件测试

推荐：Vitest + Testing Library。

覆盖：

- ResourceState；
- profile 切换竞态；
- chain mode 失败；
- 节点选择 partial success；
- 支付状态恢复；
- ErrorBoundary；
- 键盘操作；
- route skeleton；
- i18n 完整性；
- URL allowlist。

## 11.3 Rust 测试

- 备份路径和 ZIP bomb；
- 启动脚本清理；
- 原子写中断；
- profile request version；
- 配置事务补偿；
- WebDAV 无效证书；
- controller 非回环绑定；
- updater 签名失败；
- OS credential vault；
- service handoff；
- core reload/restart 失败。

## 11.4 集成和契约测试

- 注册 -> 登录 -> 商品 -> 购买 -> 权益 -> 订阅；
- 管理员授权/撤销 -> 用户访问变化；
- 支付 sandbox callback -> 幂等权益；
- OpenAPI request/response compatibility；
- Rust/TS Tauri binding 一致性；
- HTTPS-only；
- CORS allowlist；
- 登录限流；
- SSRF block；
- 敏感字段不出现在响应中。

## 11.5 E2E

- Windows x64 基础主流程；
- Windows ARM64 smoke；
- macOS Intel/ARM smoke；
- Linux x64 smoke；
- 全新安装；
- 上一稳定版本升级；
- 登录、同步、profile 切换、退出登录；
- 支付 sandbox；
- TUN/service 安装卸载；
- 更新签名失败；
- 升级失败回滚。

---

# 12. CI 门禁

## 12.1 PR 必跑

### 前端

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

### Rust

```bash
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --locked
```

### 后端

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
```

### 安全和供应链

- cargo audit；
- cargo deny；
- OSV/npm audit；
- gitleaks；
- dependency review；
- actionlint；
- zizmor；
- OpenAPI contract test；
- Tauri capability 安全断言；
- native asset Hash 校验。

## 12.2 工具链统一

当前本地与 CI 的 Node/Rust 版本不一致。应统一：

- 一个 Node 版本；
- 一个 pnpm 版本；
- 一个 Rust toolchain；
- CI、本地、发布全部读取同一配置。

所有构建使用：

```text
pnpm install --frozen-lockfile
cargo build --locked
cargo test --locked
```

## 12.3 GitHub Actions 安全

- 禁止 `permissions: write-all`；
- 每个 job 使用最小权限；
- Action 固定完整 commit SHA；
- 禁止 `@master` 和 `@main`；
- build、attest、publish 分离；
- 发布环境需要人工审批；
- 使用 OIDC 短期凭据；
- updater 私钥与普通仓库 secret 隔离；
- workflow、lock 文件、prebuild、capabilities 和支付代码由 code owner 审批。

## 12.4 分支保护

- Required checks；
- 至少一到两名审批；
- 禁止 force push；
- 发布 tag 由自动化创建；
- 强制签名 tag；
- 数据库 migration、支付和更新代码要求额外审批。

---

# 13. 发布流水线

## 13.1 候选制品

1. 从受保护分支和签名 tag 触发；
2. 校验 package、Cargo 和 Tauri 三处版本一致；
3. 锁定依赖安装；
4. 执行全量测试和安全检查；
5. 校验原生资产版本和 Hash；
6. 构建多平台制品；
7. 生成 SHA256SUMS；
8. 生成 SPDX/CycloneDX SBOM；
9. 生成 provenance；
10. 执行安装和升级 smoke。

## 13.2 签名

### Windows

- EXE 签名；
- NSIS 签名；
- sidecar 签名；
- RFC3161 timestamp；
- 发布前运行 Authenticode 验证。

当前配置需处理：

- `Fork-VPN/src-tauri/tauri.windows.conf.json:7-9`

### macOS

- codesign；
- notarization；
- staple；
- `spctl --assess`；
- 校验 entitlement 与 bundle identifier 一致。

### Linux

- DEB/RPM 仓库签名；
- 或提供 detached signature；
- 根据用户分布决定 AppImage/Flatpak。

### Tauri updater

- 私钥独立保护；
- manifest 和 binary 均验证；
- 发布后从公网 endpoint 下载并二次验签。

## 13.3 灰度发布

发布渠道：

```text
internal -> canary -> stable
```

灰度期间监控：

- 启动成功率；
- crash rate；
- 升级成功率；
- core 启动失败率；
- profile 同步失败率；
- 支付失败率；
- API 错误率。

达到稳定窗口后人工批准进入 stable。

## 13.4 回滚

- 保留上一稳定安装包；
- updater manifest 可撤回；
- 数据库 migration 使用 expand/contract；
- 不允许应用版本回滚后读不到新数据库；
- 发布后自动执行新装、升级和关键 API smoke。

---

# 14. 可观测性和运维

## 14.1 后端日志

采用 JSON structured logging：

```text
request_id
user_id/admin_id
route
action
status
duration_ms
error_code
```

脱敏：

- password；
- JWT；
- refresh token；
- 支付密钥；
- 完整订阅 URL；
- 订阅节点凭据；
- WebDAV 密码。

## 14.2 审计日志

必须记录：

- 管理员登录；
- 用户状态修改；
- 密码重置；
- 商品改价；
- 权益发放/撤销；
- 订单状态修改；
- 订阅源修改；
- 更新策略修改；
- 支付密钥配置修改。

审计日志不允许普通管理员直接删除。

## 14.3 指标

建议指标：

- API 请求量、错误率、p95；
- 登录失败和限流次数；
- 支付回调成功率；
- 订单 pending 时长；
- 订阅抓取成功率和耗时；
- 数据库连接和事务失败；
- 客户端启动成功率；
- core 启动、reload、restart 失败率；
- updater 成功率。

## 14.4 客户端诊断

提供“导出诊断包”：

- 应用版本；
- OS；
- core 版本；
- 核心状态；
- 脱敏配置摘要；
- 最近错误；
- 日志；
- operation journal。

导出前明确显示会包含哪些内容，并执行 Token/URL 脱敏。

---

# 15. 合规和文档

需要补充：

- fork-backend LICENSE；
- THIRD_PARTY_NOTICES；
- SBOM；
- SECURITY.md；
- 隐私政策；
- 数据保留和删除策略；
- 支付、退款和争议说明；
- 管理后台部署手册；
- 密钥轮换手册；
- 数据库备份和恢复手册；
- 安全事件响应流程；
- 支持平台矩阵。

修正文档与实现不一致：

- Windows x86 支持声明；
- 商业模式是否允许用户自行导入 profile；
- 真实支持 URL；
- 删除默认管理员、生产 IP 和本地绝对路径。

---

# 16. 分阶段实施计划

## 阶段 0：安全止血

预计：3～7 人日。

交付：

- 修复备份恢复执行链；
- 删除默认管理员；
- 删除默认 JWT secret；
- 轮换线上密钥；
- 商业 API 和支付切换 HTTPS；
- 禁止后端任意强更下载 URL；
- WebDAV 恢复正常证书校验；
- 文档移除账号、密码和生产 IP；
- 限制管理后台公网访问。

发布门槛：阶段 0 未完成前，不继续扩大收费和公开后台。

## 阶段 1：供应链和权限

预计：8～14 人日。

交付：

- native assets lock + Hash；
- 固定工具链；
- frozen lockfile/locked build；
- GitHub Actions 最小权限和 SHA 固定；
- Tauri capability 收口；
- CSP；
- 移除通用 Shell；
- 外部 URL allowlist。

## 阶段 2：后端生产化

预计：12～20 人日。

交付：

- TypeScript；
- PostgreSQL/SQLite WAL；
- migration；
- repository；
- Zod schema；
- 支付事务；
- rate limit；
- CORS/Helmet；
- SSRF 防护；
- 审计日志；
- Docker/Compose 或 systemd；
- 备份恢复。

## 阶段 3：客户端状态一致性

预计：12～20 人日。

交付：

- Action Coordinator；
- operation ID/version；
- profile last-write-wins；
- chain mode 事务；
- 节点选择一致性；
- ConfigChangePlan；
- core 状态机；
- typed event。

## 阶段 4：契约和测试基线

预计：15～25 人日。

交付：

- OpenAPI；
- Rust -> TS binding；
- 后端单元/集成测试；
- React 测试；
- Rust 故障测试；
- contract tests；
- PR CI 门禁；
- 测试覆盖率基线。

## 阶段 5：UX、性能和无障碍

预计：10～18 人日。

交付：

- ResourceState；
- 全局状态栏；
- route skeleton；
- ErrorBoundary；
- 支付恢复；
- i18n 完整性；
- 键盘可用；
- 响应式布局；
- 性能和 Bundle 预算。

## 阶段 6：发布、签名和运维

预计：14～23 人日。

交付：

- Windows 签名；
- macOS notarization；
- Linux 包签名；
- SBOM/provenance；
- canary/stable；
- 回滚；
- metrics/alerts；
- 运维 runbook；
- 合规文档。

预计总工作量：约 70～120 人日。

---

# 17. 建议任务执行顺序

1. 修复备份恢复和启动脚本执行链；
2. 移除默认管理员和默认 JWT secret；
3. 轮换已部署密钥和 session；
4. 全面 HTTPS；
5. 移除后端任意强更下载 URL；
6. 修复 WebDAV TLS；
7. 固定 native assets 版本和 Hash；
8. 收紧 Tauri capability 和 CSP；
9. 数据库迁移；
10. 支付事务和幂等；
11. SSRF、限流和输入验证；
12. profile 切换竞态；
13. chain mode 和节点选择一致性；
14. ConfigChangePlan 和 core 状态机；
15. OpenAPI 和 IPC bindings；
16. 测试和 CI；
17. UI ResourceState 和全局状态栏；
18. 签名、灰度发布、可观测性和合规。

---

# 18. 最终验收清单

## 安全

- [ ] 无默认管理员、密码和 JWT secret；
- [ ] 生产 API 全部 HTTPS；
- [ ] Token 使用系统凭据库；
- [ ] 恶意备份不能写入任意文件或脚本；
- [ ] WebDAV 不接受无效证书；
- [ ] Renderer 不能任意读写文件或执行 Shell；
- [ ] CSP 已启用；
- [ ] SSRF 防护测试通过；
- [ ] 原生构建资产全部校验 Hash；
- [ ] 更新只接受签名制品。

## 可靠性

- [ ] 后端使用事务数据库；
- [ ] 支付回调幂等；
- [ ] 配置文件原子写；
- [ ] profile 快速切换无竞态；
- [ ] chain mode UI 与 runtime 一致；
- [ ] 节点运行时和持久化状态一致；
- [ ] 配置副作用失败可补偿或报告 partial；
- [ ] 数据库和配置恢复演练通过。

## 工程质量

- [ ] TS、Rust、Node 契约自动生成或自动校验；
- [ ] 前端、后端、Rust 测试进入 CI；
- [ ] CI 使用冻结依赖；
- [ ] Actions 固定 SHA；
- [ ] cargo audit/deny、OSV 和 secret scan 进入门禁；
- [ ] Windows/macOS 制品签名验证通过；
- [ ] 发布附带 Hash、SBOM 和 provenance。

## UX

- [ ] 所有核心页面区分 loading/empty/stale/error；
- [ ] 所有核心操作显示真实结果；
- [ ] 支付订单可恢复；
- [ ] 路由加载不出现空白；
- [ ] 键盘可完成核心工作流；
- [ ] 无 serious/critical a11y 问题；
- [ ] 支持语言无关键硬编码文案；
- [ ] 窄窗口和 200% 缩放可用。

## 运维

- [ ] 结构化日志和 request ID；
- [ ] 管理审计日志；
- [ ] 支付和订阅指标；
- [ ] 告警规则；
- [ ] 数据备份和恢复 runbook；
- [ ] 密钥轮换 runbook；
- [ ] 灰度和回滚流程；
- [ ] 隐私、安全和第三方许可文档。

---

# 19. 总结

当前项目的客户端基础并不差，Rust 内核生命周期、配置校验、实时数据性能和多平台打包已经具备较好基础。真正需要优先投入的是商业功能加入后形成的安全、事务、契约和运营质量差距。

建议不要先花大量时间做视觉重构，也不要直接重写客户端。正确顺序应是：

```text
安全止血
-> 后端生产化
-> 客户端状态一致性
-> 权限与接口契约
-> 自动测试和发布门禁
-> UX、性能与无障碍
-> 签名、灰度、运维和合规
```

完成阶段 0～3 后，项目才具备较可靠的商业运行基础；完成阶段 4～6 后，才能形成可持续维护和发布的正式产品工程体系。
