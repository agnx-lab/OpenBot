## 上游嵌入

- 上游：`CopilotKit/OpenBot`（<https://github.com/CopilotKit/OpenBot>）@ `0.0.15`（上游压缩包 `OpenBot-main.zip`，无 git 元数据故无 commit sha），许可证 **MIT**
- 上游原生平台：桌面 ✅ | 网页 ✅ | 移动 ✅
  - 桌面：`desktop/src-tauri/`（Tauri 壳，`Cargo.toml` version = 0.0.15）
  - 网页：`app/` 是完整的 React 19 + Vite SPA，自带 18 条主界面路由（`/`、`/bot`、`/agents`、`/admin/*` 等），由 `app/serve.ts` 静态托管并把 `/api` 反代给 `server/`
  - 移动：`mobile/`（Expo）—— 本子应用**不做**移动适配（Agnx 子应用形态只有桌面/网页 guest）
- **判断结论**：上游**不是**「纯 Tauri 桌面壳」——它同时有第一方 web 应用，且 AG-UI Bot 是可选的外部端点，不构成嵌入前提。因此走**首选路径**：原样起服 + iframe 嵌入，未自画任何平行 UI。
- 工作方式：**原样嵌入（首选）**，仅加端口/来源注入
- 上游改动清单：**上游源文件 0 处改动**。唯一在「上游目录内」新增的文件是兼容层 `shared/listen-port.js`（与上游 `shared/listen-port.ts` 逐行等价），原因见下「已知限制 3」。
  - 胶水只做三件事：端口（`--port 8101`）、内部端口（server 8103）、`TRUSTED_ORIGINS` 登录来源注入。
- 挂载：`guest.auth=none`（上游 `OPENBOT_SINGLE_USER=true` 时单一管理员 `dev@openbot.local`，无登录页）/ 策略=`auto`
- 启动：`ensureTool=.agnx/tools/ensure-openbot.mjs`，端口 **8101**，上游命令
  - `bun serve.ts`（cwd=`app/`，`APP_PORT=8101`）
  - `bun --env-file=../.env src/index.ts`（cwd=`server/`，`SERVER_PORT=8103`）
- 面板与 Tab：`openbot.main`（走 ensureTool）；命令 `openbot.open`，侧栏标签 `OpenBot`，order 59
- 数据落盘：`$AGNX_HOME/apps/data/openbot/`（`openbot.json` 状态、`openbot.pids`、`logs/{app,server}.log`）；数据库为 `$AGNX_HOME` 之外的 PostgreSQL 库 `openbot_agnx`
- 已知限制：见下（逐条带文件行号依据）

### 端口拓扑

| 用途 | 端口 | 说明 |
| --- | --- | --- |
| Agnx guest 入口（app） | **8101** | `app/serve.ts` 直接监听，内建 `/api` 反代 |
| OpenBot server（不对外） | **8103** | `--port + 2`；避开同批子应用 8100–8104 的占用 |

## 阻塞 / 能力边界（上游硬性限制，非接入缺陷）

1. **对话功能需要 CopilotKit Intelligence 项目键**（上游设计，无法绕过）
   - `server/src/config.ts:896-903`：缺 `INTELLIGENCE_API_URL` / `INTELLIGENCE_GATEWAY_WS_URL` / `INTELLIGENCE_API_KEY` 任一即 `throw` —— **server 拒绝启动**。
   - 当前 `.env` 填的是本地占位值，因此：界面 / 路由 / 代理目录 / 工作流全部可用，但**真实对话被拒**：
     `401 /api/copilotkit/agent/<id>/run`，界面提示 `The "Chat" feature requires a CopilotKit license`；
     `/api/copilotkit/threads` 返回 500（`Failed to initialize thread`）。
   - 解除方式：`npx --yes copilotkit@latest login && npx --yes copilotkit@latest project select`，把 `cpk-...` 写入 `<appRoot>/.env` 的 `INTELLIGENCE_API_KEY=`。这是**上游账号授权**，属于只有用户能提供的外部凭据。
2. **Bot 的「一台电脑」（浏览器自动化）需要 Docker**（本轮未启用）
   - `README.md` Requirements：Docker 用于 PostgreSQL 与随仓 Bots；`docker compose` 起 `agent-computer`（4100）/ `supervisor`（4500）。
   - 本机 Docker 守护进程未运行，故 `COMPUTER_SUPERVISOR_URL` 留空 → 单一共享电脑，且 `127.0.0.1:4100` 不可达：
     server 日志 `egress-policy-push-failed`；界面 `/bot` 显示 `Reconnecting: browser ownership could not be checked. Input is paused.`
   - 不影响首页/导航/代理目录，但「让 Bot 自己开浏览器」这条链路需要用户启动 Docker 后再 `docker compose up -d agent-computer`。
3. **`shared/listen-port.js` 兼容层**：上游 `app/serve.ts`、`app/vite.config.ts` 用无扩展名 `import "../shared/listen-port"`，上游靠 Bun 直接跑 `.ts`。本胶水用 Bun 启动，本可直接吃 `.ts`，但为免任何解析顺序差异，落了一份等价的 `.js`；上游 `.ts` 原文件未动。
4. **`TRUSTED_ORIGINS` 必须与 guest origin 一致**：面板注入 `http://127.0.0.1:8101,http://localhost:8101`；若宿主改用其他 host 访问，cookie/WS 会被上游拒绝，需在 `.env` 同步。
5. **数据库依赖 pgvector**：`server/drizzle/0000_schema.sql:10` `CREATE EXTENSION vector`；本机已 `brew install pgvector` 并对 PG16 生效（PG16.14 主集群未重启、未被替换）。

## 嵌页宿主能力缺口

| 上游能力 | 信号位置 | 嵌后风险 | 处置 | 主路径 | 备注 |
| --- | --- | --- | --- | --- | --- |
| WebSocket（CopilotKit runtime / 线程流） | `app/serve.ts` 的 `upstreamWebSocketHeaders` + `BunWebSocket` 桥接 | iframe 内 WS 若被宿主编排层改写会断流 | guest 声明 `capabilities: ["websocket"]` | iframe 直连 8101 | 已实测 `/api` 与首页正常；WS 在对话被许可拦下前无法端到端验证 |
| Cookie（Better Auth 会话） | `.env` `TRUSTED_ORIGINS`；`OPENBOT_SINGLE_USER=true` 时退化 | origin 不一致会被拒 | ensure 现算注入 `TRUSTED_ORIGINS` | iframe 同源 | 单用户模式无登录页，风险低 |
| 系统浏览器 OAuth（桌面登录） | `README.md`「Organization sign-in for desktop installations」 | iframe 内无法弹系统浏览器 | 不启用（`OPENBOT_SINGLE_USER`） | — | 需要组织认证服务器，与本子应用无关 |
| Bot 的隔离电脑（容器） | `docker-compose.yml` / `supervisor` | 无 Docker 时浏览器自动化不可用 | 如实降级为共享电脑并留日志 | 用户启动 Docker 后补 | 见「阻塞 2」 |
| 文件下载/上传（附件） | `shared/attachments.ts` | iframe 内下载需 guest 放行 | 依赖宿主 guest 默认能力 | iframe | 未单独验证 |

## 复现 / 维护

```bash
# 首次装配（已在本机执行过）
cd /Users/apple/.agnx-dev/apps/openbot
bun install                                     # 2348 包，约 9s
bun run generate:app-config                     # 生成 app/src/lib/generated/application-config.ts
cd app && bun --bun node_modules/vite/bin/vite.js build   # 约 32s → app/dist
# 数据库（PG16 已装 pgvector）
createdb openbot_agnx && psql -d openbot_agnx -c 'CREATE EXTENSION IF NOT EXISTS vector'
cd ../server && bun --env-file=../.env node_modules/drizzle-kit/bin.cjs migrate --config=drizzle.config.ts

# 日常：ensure-tool 会自行补齐 dist / 迁移 / .env
node .agnx/tools/ensure-openbot.mjs --port 8101 --work-dir "$HOME/.agnx-dev/apps/data/openbot"
node .agnx/scripts/build.mjs
```

`ensure-openbot.mjs` 的行为合同：

- 端口上已是 OpenBot 且 server（8103）健康 → `{"ok":true,"reused":true,...}`
- 否则后台起 server → app，健康检查通过后打印 `{"ok":true,"reused":false,"port":8101,"origin":"http://127.0.0.1:8101","pid":...}`
- `--force-restart`：按状态文件 + 按端口 `lsof` 双路收拾旧实例（换 work-dir 后也能清理）
- 失败一律 `{"ok":false,"error":"<可读中文原因>"}` + exit 1（缺 bun / 缺 dist 且构建失败 / 缺 Intelligence 键 / 库迁移失败 / 端口被他人占用）
- 日志：`<workDir>/logs/{app,server}.log`（用文件而非管道，避免 `ensure | tail` 挂住）
