# 脱敏源码包说明

打包日期：20260717  
内容：客户端 **`Fork-VPN/`**（由本机开发目录同步并改名）+ **`fork-backend/`**

## 已排除

- `node_modules/`、Rust `target/`、前端 `dist/`
- `fork-backend/data/`（用户、订单、管理员哈希、真实订阅）
- `.env` 与生产密钥
- 预编译 sidecar / geo / service 二进制（需 `pnpm run prebuild`）
- 内部运维脚本（`deploy-*`、`_*`、repair 等）与本地交接文档

## 已替换

- 生产域名 → `your-domain.example`
- 生产 IP → `YOUR_SERVER_IP`
- 本机开发目录名 → 公开名 **`Fork-VPN`**

## 合规

基于 Clash Verge Rev，见 `Fork-VPN/LICENSE`（GPL-3.0）。
