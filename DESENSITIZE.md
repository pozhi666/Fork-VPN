# 脱敏源码包说明

打包日期：20260712
内容：客户端 `clash-verge-rev-dev` + 后端 `fork-backend` 源码（已脱敏）

## 已排除

- `node_modules/`、Rust `target/`、前端 `dist/`
- `fork-backend/data/`（用户、订单、管理员哈希、真实订阅 URL）
- `.env` 与一切生产密钥
- 预编译 sidecar / 资源二进制（exe、geoip 等；客户端需 `pnpm run prebuild` 重新拉取）
- 内部运维脚本（`deploy-*`、`_*` 临时脚本）与生产运维备忘

## 已替换 / 脱敏

- 生产域名 → `your-domain.example`
- 生产服务器 IP → `YOUR_SERVER_IP`
- 文档中的运维细节已裁剪

## 本地启动（摘要）

### 后端

```bash
cd fork-backend
cp .env.example .env
npm install
npm run bootstrap-admin -- -u admin -p 'YourStrongPass1'
npm run dev
```

管理后台：`http://127.0.0.1:8787/forkvpnadmin/`

### 客户端

```bash
cd clash-verge-rev-dev
corepack enable && pnpm install
pnpm run prebuild
# Windows:
# $env:FORK_API_BASE="http://127.0.0.1:8787/api/v1"
pnpm dev
```

默认 API 占位为 `https://your-domain.example/api/v1`，务必用环境变量覆盖。

## 合规

基于 Clash Verge Rev，许可证见 `clash-verge-rev-dev/LICENSE`（GPL-3.0）。
分发二进制时请同时提供对应源码获取方式。
