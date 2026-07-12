# Fork

> 基于 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) 的商业化桌面客户端 · 可选自建后端  
> 当前版本：**0.1.0**（内测首版，基于上游 Verge Rev 二改）

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](./Fork-VPN/LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-orange.svg)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)

Fork 在保留 Clash Meta / Mihomo 能力的同时，增加 **账号体系、订阅商城、官方线路下发、个人中心**，并与原版 Clash Verge **数据目录与端口隔离**，可同时运行。

> **合规说明**：客户端基于 GPL-3.0 上游二次开发。分发二进制时须提供对应源码并保留许可证。  
> 本仓库面向可复现的开源发布；**请勿提交** 生产密钥、用户数据与服务器凭据。

---

## ✨ 特性

### 客户端（`Fork-VPN`）

- **商业模式**：注册 / 登录、会话校验、退出登录  
- **官方线路**：登录后同步服务端合并后的订阅（客户端不暴露源站 URL）  
- **订阅商城**：免费 / 付费商品、易支付收银台、订单轮询开通  
- **个人中心**：账号信息、权益列表、订单记录、修改密码、继续支付  
- **开放导入**：可自行导入远程 / 本地订阅；**官方配置**受保护，不可误删改  
- **公告与版本提示**：运营公告、可选 / 强制更新提示（安装包建议走签名更新通道）  
- **运行隔离**：独立 AppId、端口与 IPC，不与原版 Clash Verge 抢配置  

### 后端（`fork-backend`，可选）

- 用户注册登录（JWT）  
- 商品 / 订阅源 / 权益（`purchases`）  
- 易支付下单与异步回调  
- 管理后台静态面板（用户、源、商品、订单等）  
- 生产环境配置校验（强 JWT、无默认管理员密码等）  

---

## 📁 目录结构

```text
.
├── Fork-VPN/        # 桌面客户端（Tauri + React + Rust）
├── fork-backend/    # 商业 API 与管理后台
└── README.md
```

---

## 📣 社区与产品

| | 链接 |
|--|------|
| **Telegram 频道** | [t.me/forkdl](https://t.me/forkdl) |
| **正在运营的产品** | [https://forkvpn.i58.xyz](https://forkvpn.i58.xyz) |
| **GitHub 源码** | [pozhi666/Fork-VPN](https://github.com/pozhi666/Fork-VPN) |

---

## 🖼️ 功能一览

| 模块 | 说明 |
|------|------|
| 登录 / 注册 | 账号接入自建后端 |
| 订阅 | 导入自有订阅 + 同步官方线路 |
| 商城 | 开通免费 / 付费商品 |
| 个人中心 | 权益、订单、改密 |
| 代理 / 规则 | 沿用 Clash Verge Rev 能力 |
| 管理后台 | 浏览器访问后端根路径 |

---

## 🚀 快速开始

### 环境要求

- Node.js 20+、[pnpm](https://pnpm.io/)  
- Rust（stable）+ [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)  
- Windows / macOS / Linux  

### 1. 启动后端（可选，本地调试）

```bash
cd fork-backend
npm install
cp .env.example .env   # 按说明填写，勿提交真实密钥
npm run bootstrap-admin -- -u admin -p 'YourStrongPass1'
npm run dev
```

默认：`http://127.0.0.1:8787/`（管理面板）  
API：`http://127.0.0.1:8787/api/v1`

### 2. 启动客户端

```bash
cd Fork-VPN
corepack enable
pnpm install
pnpm run prebuild    # 拉取 mihomo 等原生依赖
# 开发时指向本地后端：
# Windows PowerShell:
$env:FORK_API_BASE="http://127.0.0.1:8787/api/v1"
pnpm dev
```

生产构建请使用 **HTTPS** API 地址（见 `COMMERCIAL.md`）。

### Windows 一键脚本

```powershell
.\start-fork.ps1              # 客户端 → 配置的生产 API
.\start-fork.ps1 -LocalBackend  # 本地后端 + 客户端
.\start-fork.ps1 -Stop
```

---

## ⚙️ 配置说明

### 客户端

| 变量 / 开关 | 说明 |
|-------------|------|
| `FORK_API_BASE` | 后端 API 根路径，如 `https://your.domain/api/v1` |
| `COMMERCIAL_MODE` | `src/config/commercial.ts` 与 `src-tauri/src/commercial/mod.rs` 需同时开关 |

与原版隔离的端口、数据目录等见：  
[`Fork-VPN/COMMERCIAL.md`](./Fork-VPN/COMMERCIAL.md)

### 后端（环境变量示例）

| 变量 | 说明 |
|------|------|
| `FORK_PORT` | 监听端口，默认 `8787` |
| `FORK_JWT_SECRET` | JWT 密钥（生产 ≥32 位随机串） |
| `FORK_PUBLIC_URL` | 对外根地址（支付回调） |
| `EZPAY_URL` / `EZPAY_PID` / `EZPAY_KEY` | 易支付网关（仅环境变量，勿入库） |
| `FORK_BIND` | 建议生产 `127.0.0.1`，经反向代理 TLS |

---

## 🔒 安全与开源注意

**请勿将以下内容推送到公开仓库：**

- `.env`、JWT / 易支付 / SSH 等密钥  
- `fork-backend/data/fork.json` 及任何用户/订单生产数据  
- 服务器密码、私钥、真实订阅 URL（若敏感）  

建议：

```gitignore
# fork-backend
.env
data/
node_modules/
*.tgz
```

分发客户端安装包时，请遵守 **GPL-3.0**：附带或提供对应源码获取方式，并保留版权与许可证声明。

---

## 🗺️ 路线图（节选）

- [x] 账号 / 商城 / 官方同步 / 个人中心  
- [x] 导入自有订阅 + 官方配置保护  
- [x] 易支付下单与回调  
- [ ] 生产全站 HTTPS 与反代最佳实践文档  
- [ ] 更强的备份恢复与权限收口  
- [ ] 事务型数据库与更完善的支付对账  

---

## 🙏 致谢

- [Clash Verge](https://github.com/zzzgydi/clash-verge)  
- [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)  
- [mihomo (Clash Meta)](https://github.com/MetaCubeX/mihomo)  
- [Tauri](https://tauri.app/)  

---

## 📄 许可证

客户端主体遵循 **GNU General Public License v3.0 only**（与上游一致）。  
详见 [`Fork-VPN/LICENSE`](./Fork-VPN/LICENSE)。

`fork-backend` 为配套商业后端示例代码，使用前请自行评估部署安全与合规要求。

---

## ⚠️ 免

本项目仅供学习与合法用途。请遵守当地法律法规及上游开源协议。  
使用自建后端提供代理服务时，运营者须自行承担合规与安全责任。
