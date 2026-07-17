# Fork VPN

> 基于 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) 的商业化桌面客户端 · 可选自建后端  
> 当前版本：**0.2.0**

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](./Fork-VPN/LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-orange.svg)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)

Fork 在保留 Clash Meta / Mihomo 能力的同时，增加 **账号体系、订阅商城、官方线路下发、个人中心、余额与工单** 等，并与原版 Clash Verge **数据目录与端口隔离**，可同时运行。

> **合规说明**：客户端基于 GPL-3.0 上游二次开发。分发二进制时须提供对应源码并保留许可证。  
> **请勿提交** 生产密钥、用户数据与服务器凭据。本仓库为**脱敏**源码。

---

## 目录结构

```text
.
├── Fork-VPN/        # 桌面客户端（Tauri 2 + React + Rust）
├── fork-backend/    # 商业 API 与管理后台
├── DESENSITIZE.md   # 脱敏说明
└── README.md
```

---

## 功能概览

### 客户端（`Fork-VPN/`）

- 注册 / 登录、会话校验、找回密码（邮箱 OTP）
- 官方线路同步（客户端不暴露源站 URL）
- 订阅商城、易支付、站内余额
- 个人中心：权益、订单、工单、改密
- 签到与双流量钱包（免费 / 付费）
- 与原版 Clash Verge 端口 / AppId / 数据目录隔离

### 后端（`fork-backend/`）

- JWT 用户体系与管理员
- 商品 / 订阅源 / 权益 / 退款撤权
- 易支付下单与回调
- 管理后台静态面板（`/forkvpnadmin/`）

---

## 快速开始

### 环境

- Node.js 20+、[pnpm](https://pnpm.io/)
- Rust（stable）+ [Tauri 依赖](https://v2.tauri.app/start/prerequisites/)

### 1. 后端

```bash
cd fork-backend
cp .env.example .env
npm install
npm run bootstrap-admin -- -u admin -p 'YourStrongPass1'
npm run dev
```

- API：`http://127.0.0.1:8787/api/v1`
- 管理后台：`http://127.0.0.1:8787/forkvpnadmin/`

### 2. 客户端

```bash
cd Fork-VPN
corepack enable
pnpm install
pnpm run prebuild
# 本地后端（PowerShell）:
# $env:FORK_API_BASE="http://127.0.0.1:8787/api/v1"
pnpm dev
```

默认 API 占位为 `https://your-domain.example/api/v1`，本地务必用环境变量覆盖。

---

## 社区

| | |
|--|--|
| Telegram | [t.me/forkdl](https://t.me/forkdl) |
| 源码 | 本仓库 |

---

## 许可证

客户端见 `Fork-VPN/LICENSE`（GPL-3.0）。后端与文档以仓库内说明为准。
