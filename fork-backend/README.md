# Fork Backend

Fork 客户端的商业后端：用户注册登录、订阅代拉和管理面板。

> **安全状态：** 当前 HTTP 直连仅允许用于明确设置 `FORK_TEST_INSECURE_HTTP=1` 的短期测试环境。正式部署必须使用 HTTPS 域名、Nginx/Caddy TLS 反代、回环监听和显式 CORS allowlist；HTTP 测试环境不能视为 Phase 0 验收通过。

## 流量额度（重要）

商品字段 `traffic_bytes`（字节，**0 = 不限流量**）在开通权益时写入用户的 `purchases[]`：

- `traffic_limit_bytes` / `traffic_used_bytes`
- 用尽后：`GET /client/subscription` 返回 **403**，无法再同步官方线路
- 上报：`POST /client/traffic/report`（`delta_bytes` 或 `upload`+`download`）
- 管理端：商品表单可填 **流量 GB**；用户列表可 **清零流量**

> 说明：节点在上游机场时，本后端**无法在链路上硬截断**字节流。当前为「额度账本 + 同步拦截」模型；客户端上报可完善自动计量。请勿把付费商品设为 0（不限），以免跑亏。

## 本地开发

```bash
cd D:\clash\fork-backend
npm install
npm run dev
```

- 本地面板：`http://127.0.0.1:8787/`
- API 前缀：`/api/v1`
- 空数据库**不会**创建默认管理员。

## 初始化管理员

开发环境：

```bash
npm run bootstrap-admin -- --username admin --password 'StrongPass123!'
```

生产环境还必须在服务器受限 `.env` 中设置一次性 `FORK_BOOTSTRAP_TOKEN`，并传入同一个 token：

```bash
npm run bootstrap-admin -- \
  --username admin \
  --password 'StrongPass123!' \
  --token "$FORK_BOOTSTRAP_TOKEN"
```

初始化成功后立即从 `.env` 删除或轮换 `FORK_BOOTSTRAP_TOKEN`。脚本不会输出密码。

## 正式部署要求

生产后端必须位于 TLS 反向代理之后：

```text
桌面客户端
  -> https://<正式域名>/api/v1
  -> Nginx/Caddy :443
  -> http://127.0.0.1:8787
  -> fork-backend
```

生产 `.env` 最低配置：

```text
NODE_ENV=production
FORK_BIND=127.0.0.1
FORK_PORT=8787
FORK_PUBLIC_URL=https://<正式域名>
FORK_CORS_ORIGINS=https://<正式域名>,https://<正式域名>:8443
FORK_JWT_SECRET=CHANGE_ME_JWT_SECRET_AT_LEAST_32_CHARS 32 字符的随机密钥>
EZPAY_URL=<支付网关地址>
EZPAY_PID=CHANGE_ME ID>
EZPAY_KEY=CHANGE_ME
```

生产模式会拒绝弱 JWT、非 HTTPS public URL、公开监听、空/不安全 CORS origin 和未初始化管理员。没有正式域名时，如需临时测试 HTTP，必须显式设置：

```text
FORK_TEST_INSECURE_HTTP=1
```

该开关会在启动日志中输出警告，且必须在 HTTPS 切换后移除。

### 管理面板

生产环境不应公开管理 API。推荐通过 SSH 隧道访问：

```bash
ssh -L 8443:127.0.0.1:443 <ssh-user>@<server>
```

随后在本机打开：

```text
https://<正式域名>:8443/
```

Nginx 应限制 `/api/v1/admin/*` 仅可由 loopback 访问。不要把 8787 端口暴露到公网。

### 文件和密钥

- `.env` 仅运行账户可读；
- `data/` 仅运行账户可写；
- 代码和 `public/` 不可 world-writable；
- PM2 ecosystem 文件不得写入 JWT、支付密钥或 bootstrap token；
- 不要使用已禁用的 `scripts/deploy-ezpay.mjs`；它曾把支付密钥写入 PM2 配置。

## 常用接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/auth/register` | 用户注册 |
| POST | `/api/v1/auth/login` | 用户登录 |
| GET | `/api/v1/auth/me` | 当前用户 |
| GET | `/api/v1/client/subscription` | 下发订阅 YAML（Bearer） |
| POST | `/api/v1/admin/login` | 管理员登录 |
| * | `/api/v1/admin/*` | 用户/套餐/订阅源管理 |

## 权限模型

| 类型 | 谁可用 |
|------|--------|
| **免费订阅源** | 所有登录且账号未过期的用户 |
| **付费订阅源** | 仅 `purchases[]` 有效期内的商品解锁 |

- `trial` 等系统项：只影响注册默认账号天数，**不售卖、不解锁节点**。
- 商品（`kind=product` + 上架）：绑定一个付费源，出现在客户端商店。
- `plan_id` 仅作展示，**不再**作为解锁依据。

## 易支付流程

1. 客户端购买付费商品 → `POST /api/v1/client/purchase` 创建订单和 `pay_url`；
2. 浏览器打开收银台付款；
3. 易支付异步通知 `GET/POST /api/v1/pay/ezpay/notify` → 验签 → 开通 `purchases[]`；
4. 客户端轮询 `GET /api/v1/client/orders/:id` → 同步节点。

`notify_url` 和 `return_url` 从 `FORK_PUBLIC_URL` 生成；正式环境必须为 HTTPS 域名。
