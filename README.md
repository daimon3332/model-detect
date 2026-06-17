# Model Detect

Model Detect 是一个面向 Codex CLI / Claude Code CLI 的模型提供商监控工具。

它不是普通的“直接请求模型 API”的检测工具，而是通过真实 CLI 发起检测，并通过本地代理记录 CLI 发出的原始 HTTP 请求和上游响应。

## 前置条件

必须安装：

| 依赖 | 用途 | 验证命令 |
| --- | --- | --- |
| Node.js / npm | 安装依赖、构建前端、运行后端服务 | `node -v` / `npm -v` |
| Codex CLI | 检测 Codex 模型 | `codex --version` |
| Claude Code CLI | 检测 Claude Code 模型 | `claude --version` |

Node.js 建议使用 `^20.19.0` 或 `>=22.12.0`，因为当前项目使用 Vite 7。

真实检测还需要准备：

| 项目 | 是否必须 | 说明 |
| --- | --- | --- |
| 模型提供商 Base URL | 是 | 例如 OpenAI-compatible `/v1` 或 Anthropic-compatible 地址 |
| API Key | 是 | 在“模型提供商”页面配置 |
| Git | 部署推荐 | 用于 `git clone` / `git pull` 更新项目 |
| ufw | 可选 | Linux 开放端口时使用 |
| Nginx / Caddy | 可选 | 需要域名、HTTPS、反代时使用 |

不需要提前配置用户级 Codex / Claude Code。项目会为每个模型提供商创建独立目录：

```text
data/providers/<provider-id>/codex-home/config.toml
data/providers/<provider-id>/claude-workspace/.claude/settings.json
```

## 启动方式

### 本地完整启动

```bash
npm install
npm run build
npm run server
```

默认访问：

```text
http://127.0.0.1:5173
```

默认管理员密码：

```text
admin
```

### 本地前端开发

```bash
npm install
npm run dev
```

仅启动前端开发服务。后端不可用时，前端会回退到 localStorage mock，不能真实调用 CLI。

### 指定端口启动

服务默认端口是 `5173`，可以用 `PORT` 指定高位端口：

```bash
PORT=20020 npm run server
```

Windows PowerShell：

```powershell
$env:PORT="20020"; npm run server
```

## Linux 部署和后台运行

### 首次部署

```bash
cd /root
git clone https://github.com/daimon3332/model-detect.git
cd /root/model-detect
npm install
npm run build
ufw allow 20020/tcp
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

如果服务器已配置 GitHub SSH key，也可以使用：

```bash
git clone git@github.com:daimon3332/model-detect.git
```

访问：

```text
http://服务器IP:20020
```

首次登录后建议立刻到“全局设置”修改默认管理员密码。

### 已有仓库更新部署

当前推荐用 git 直接更新：

```bash
cd /root/model-detect
git pull
npm install
npm run build
fuser -k 20020/tcp || true
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

`data/` 是本地运行数据目录，已加入 `.gitignore`，`git pull` 不会覆盖 provider 配置、管理员密码和检测日志。

### 停止后台服务

优先使用 pid 文件：

```bash
cd /root/model-detect
kill $(cat server.pid)
```

如果 pid 文件不存在，按端口终止：

```bash
fuser -k 20020/tcp
```

### 查看运行状态

```bash
ss -ltnp | grep ':20020'
```

```bash
cd /root/model-detect
tail -f server.log
```

### Nginx / Cloudflare

可以使用 Nginx 反代到本地服务：

```text
Nginx / Cloudflare -> 127.0.0.1:20020
```

如果开启 Cloudflare 小黄云，必须给 `/api/*` 配置 bypass cache，避免接口、登录状态、日志和检测结果被缓存。

## 核心目标

1. 管理多个模型提供商。
2. 每个提供商可单独配置 Codex / Claude Code。
3. 每个提供商可配置多个模型。
4. 每个提供商使用独立 CLI 配置目录，不污染用户级配置。
5. 支持手动检测和定时检测。
6. 检测时调用真实 Codex CLI / Claude Code CLI。
7. 记录真实 CLI 请求头、请求体、响应头、响应体。
8. 首页按 provider / agent / model 展示最近 10 次检测结果。

## 当前功能

### 前端

- Vue 3 + TypeScript + Vite + Element Plus
- 顶部导航：
  - 模型监控
  - 模型提供商
  - 提示词
  - 日志记录
  - 定时任务
  - 全局设置
- 首页默认空数据，不内置假 provider。
- 添加 provider 后按 provider 分组显示模型状态。
- 支持按 provider / agent / model / state 筛选。
- 每个模型展示最近 10 次检测。
- 支持检测全部、检测单个 provider、检测单个模型。
- 点击状态码查看详情。
- 请求详情中的 JSON 对象 / 数组支持折叠和展开。
- 点击 provider 可编辑配置。
- provider 支持：
  - Base URL
  - API Key
  - Codex 启用
  - Claude Code 启用
  - provider 级代理连接地址
  - 超时
  - 定时检测
  - 是否保存 body
  - Codex 模型列表
  - Claude Code 模型列表
  - `.codex/config.toml`
  - `.claude/settings.json`

## 定时任务规则

定时任务是三级开关，必须全部开启才会执行：

```text
全局总定时任务开启
  -> provider 已启用，并且 provider 定时任务开启
    -> model 已启用，并且 model 定时任务开启
```

任意一级关闭都会让下级失效。

示例：

```text
DeepSeek 有 deepseek-v4-pro 和 deepseek-chat 两个模型
只打开 deepseek-v4-pro 的 model 定时任务
则定时任务只检测 deepseek-v4-pro
```

检测间隔在“定时任务”页面统一配置为：

```text
settings.scheduleDays
settings.scheduleHours
settings.scheduleMinutes
```

范围：

```text
天：0 - 365
小时：0 - 23
分钟：0 - 59
```

如果三项都为 0，后端按最小 1 分钟保护处理。所有被选中的 provider / model 使用同一个定时执行周期。

## Prompt 规则

Prompt 在“提示词”页面集中配置，也是三级优先级：

```text
model.prompt
  -> provider.prompt
    -> settings.prompt
      -> Hello
```

默认全局 Prompt 是：

```text
Hello
```

provider prompt 为空时继承全局 prompt。

model prompt 为空时继承 provider prompt，再继承全局 prompt。

### 后端

- Node 内置 HTTP 服务，无 Express。
- 提供 API。
- 托管前端 `dist/`。
- 保存 provider、settings、runs。
- 为每个 provider 创建独立配置目录。
- 调用真实 CLI。
- 启动本地 HTTP 代理采集原始请求/响应。
- 后台扫描定时任务。

## 参考 CCG Gateway 的日志模板

本项目的日志采集参考 `ccg-gateway` 的三段式结构。前端详情页按按钮展示六项：请求头、请求体、响应头、响应体、网关路由转发头、网关路由转发体。

内部仍然采集三段数据，便于后续排查：

```text
client  = Agent 请求，也就是 CLI 发到本地代理的原始请求
forward = 网关路由转发，也就是代理实际发给上游 provider 的请求
provider = 服务商响应，也就是真实 provider 返回给代理的响应
```

当前详情弹窗展示规则：

```text
请求头 = client_headers
请求体 = client_body
响应头 = provider_headers
响应体 = provider_body
网关路由转发头 = forward_headers
网关路由转发体 = forward_body
```

`forward_url` 和 `exchanges[]` 仍保存在日志数据中，用于后续高级诊断；当前详情页不再展示 `CLI`、`全部交换`、`原始 JSON` 入口。

详情页展示策略：

- 前端不再做 32K 字符截断，展示后端保存的完整字段内容。
- 如果后端因为日志体积限制截断，会在内容中出现 `[truncated ... chars]`。
- JSON object / array 使用可折叠树展示。
- 合法 JSON 字符串会自动解析为可折叠树。
- 普通字符串 body 按原始文本展示，不再用 `JSON.stringify` 包一层。
- SSE / event-stream 响应按真实换行展示，避免全部挤成一行。

### 1. Agent 请求

CLI 发到本地代理的原始请求。

字段：

```text
client_headers
client_body
```

这里应该能看到 Codex / Claude Code 自己带的真实请求头。比如 Codex 可能包含：

```text
session-id
x-codex-beta-features
x-codex-window-id
x-client-request-id
x-codex-turn-metadata
originator
user-agent
authorization
accept
content-type
```

### 2. 网关路由转发

本地代理转发给真实上游 provider 的请求。

字段：

```text
forward_url
forward_headers
forward_body
```

这里是代理实际转发到上游 provider 的内容，当前前端详情页通过“网关路由转发头 / 网关路由转发体”按钮展示。

### 3. 服务商响应

真实 provider 返回给本地代理的响应。

字段：

```text
provider_headers
provider_body
```

这里展示真实上游的响应头和响应体。

### CLI 信息

后端日志仍保存 CLI 信息：

```text
exitCode
stdout
stderr
```

当前详情弹窗不展示 CLI tab；后续如果需要可在日志详情中增加高级模式。

## 真实调用链路

```text
浏览器
  -> 后端 /api/checks
    -> 写入 provider 独立配置目录
    -> 启动/复用 127.0.0.1:<proxyPort> 本地代理
    -> 临时把 CLI base_url 指向本地代理
    -> 执行真实 CLI
      -> CLI 请求本地代理
        -> 代理记录 Agent 请求
        -> 代理转发到真实上游 provider
        -> 代理记录转发请求
        -> 代理记录服务商响应
        -> 响应返回 CLI
    -> 后端保存 run 日志
    -> 前端展示状态码和详情
```

## 数据目录

默认数据目录：

```text
data/
```

生成内容：

```text
data/state.json

data/providers/<provider-id>/codex-home/config.toml

data/providers/<provider-id>/claude-workspace/.claude/settings.json
```

`data/` 已加入 `.gitignore`。

## Codex 隔离配置

检测 Codex 时，后端设置：

```bash
CODEX_HOME=data/providers/<provider-id>/codex-home
```

实际配置文件：

```text
data/providers/<provider-id>/codex-home/config.toml
```

执行命令：

```bash
codex exec --skip-git-repo-check --json "hello"
```

不会修改：

```text
~/.codex/config.toml
```

## Claude Code 隔离配置

检测 Claude Code 时，后端设置 cwd：

```text
data/providers/<provider-id>/claude-workspace
```

实际配置文件：

```text
data/providers/<provider-id>/claude-workspace/.claude/settings.json
```

执行命令：

```bash
claude -p "hello"
```

不会修改用户级 Claude Code 配置。

## 代理机制

项目里有两类代理，不能混淆。

### 1. 内部抓包代理

后端为了记录 CLI 原始请求，会启动内部抓包代理：

```text
http://127.0.0.1:7788
```

检测时，后端会把 CLI 的 Base URL 临时改成本地抓包代理。

Codex 示例：

```toml
base_url = "http://127.0.0.1:7788/v1"
```

Claude Code 示例：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:7788/anthropic"
  }
}
```

这个内部代理用于捕获请求头、请求体、响应头、响应体，不是用户配置的上网代理。

### 2. Provider 级外部代理

每个模型提供商可以单独配置一个外部代理连接地址，默认为空，表示直连。

支持示例：

```text
http://127.0.0.1:7890
https://127.0.0.1:7890
socks://127.0.0.1:7890
socks5://127.0.0.1:7890
```

链路：

```text
CLI
  -> 内部抓包代理 127.0.0.1:7788
    -> 如果 provider.proxyUrl 为空：直连 provider
    -> 如果 provider.proxyUrl 是 http/https/socks/socks5：通过该代理访问 provider
```

模型提供商页面会显示：

```text
Proxy: 无代理
Proxy: http://127.0.0.1:7890
Proxy: socks5://127.0.0.1:7890
```

注意：当前是 HTTP 层转发，不做 HTTPS MITM，也不修改系统代理。

## API

### `GET /api/state`

返回完整状态。

### `POST /api/providers`

新增或更新 provider。

### `DELETE /api/providers/:id`

删除 provider、相关日志和配置目录。

### `POST /api/settings`

更新全局设置。

### `POST /api/checks`

执行检测。

请求体：

```json
{
  "providerId": "可选"
}
```

不传 `providerId` 时检测全部启用 provider。

### `GET /api/logs`

返回检测日志。

## 日志数据结构

单条 run 大致结构：

```json
{
  "providerId": "provider-id",
  "providerName": "Provider",
  "agent": "codex",
  "model": "gpt-5.5",
  "state": "success",
  "httpStatus": 200,
  "cliExitCode": 0,
  "latencyMs": 1234,
  "stdout": "...",
  "stderr": "...",
  "logDetail": {
    "client_headers": {},
    "client_body": {},
    "forward_url": "https://upstream.example/v1/responses",
    "forward_headers": {},
    "forward_body": {},
    "provider_headers": {},
    "provider_body": {}
  },
  "exchanges": []
}
```

`exchanges` 保存一次 CLI 执行中捕获到的所有 HTTP 交换。

首页状态码默认使用主要模型请求的 `statusCode`。

## 验证命令

```bash
npm run typecheck
npm run build
node --check server/index.mjs
```

## 已验证结果

在 Linux `/root/model-detect` 中已完成短 prompt 验证：

```text
Codex + 鲨鱼辣椒 + gpt-5.5
state: success
httpStatus: 200
捕获到 Codex 原始请求头：x-codex-beta-features / x-codex-window-id / x-codex-turn-metadata / x-client-request-id / session-id / thread-id / originator / user-agent

Claude Code + DeepSeek + deepseek-v4-pro
state: success
httpStatus: 200
捕获到 Claude Code 原始请求头：x-claude-code-session-id / anthropic-beta / anthropic-version / x-stainless-* / x-api-key / x-app
```

详情页按钮顺序：

```text
请求头
请求体
响应头
响应体
网关路由转发头
网关路由转发体
```

默认打开 `请求头`。

`CLI`、`全部交换`、`原始 JSON` 不再作为详情页主入口展示。

## Linux 测试约束

当前测试服务器只允许操作：

```text
/root/model-detect
```

不要修改其他目录。

真实 CLI 测试只使用短 prompt：

```text
hello
```

成功验证 Codex 和 Claude Code 各一次后停止，避免浪费 token。

## 当前限制

- 目前使用 JSON 文件保存状态，后续可换 SQLite。
- 当前代理不做 HTTPS MITM，只支持 CLI base_url 指向本地 HTTP 代理。
- 前端当前不展示 `exchanges[]`，详情页展示请求头、请求体、响应头、响应体、网关路由转发头、网关路由转发体。
- 日志体大小当前在后端截断，后续可做配置项。

## 后续计划

1. 日志存储改 SQLite。
2. 请求详情文件拆分保存，避免 `state.json` 过大。
3. 日志详情增加多 exchange 切换器。
4. 定时任务页展示上次运行和下次运行。
5. 增加 systemd 服务文件。
6. 增加日志清理策略。

## 当前前端页面

### 模型监控

- 默认首页。
- 支持 provider / agent / model / state 筛选。
- 支持“检测全部”。
- 每个 provider 有 provider 级“检测”。
- 每个模型行有单模型“检测”。
- 每个模型显示最近 10 次检测状态。
- 点击状态码打开请求详情。

### 模型提供商

- 添加、编辑、删除 provider。
- 编辑弹窗中配置：
  - 名称
  - Base URL
  - API Key
  - provider 级代理连接地址
  - CLI 超时
  - provider 启用状态
  - Codex / Claude Code 启用状态
  - 定时任务开关
  - 是否保存请求/响应 body
  - Codex 模型列表
  - Claude Code 模型列表
  - `.codex/config.toml`
  - `.claude/settings.json`
- 列表展示是否有代理；有代理时展示代理地址。

### 提示词

- 集中配置全局 Prompt、Provider Prompt、Model Prompt。
- Provider Prompt 留空时继承全局 Prompt。
- Model Prompt 留空时继承 Provider Prompt，再继承全局 Prompt。

### 定时任务

- 配置总定时任务开关。
- 配置统一执行间隔：天 / 小时 / 分钟。
- 配置 provider 定时任务开关。
- 配置 model 定时任务开关。
- 总开关关闭时所有定时任务失效。
- provider 关闭时该 provider 下所有 model 失效。
- model 关闭时只影响该 model。

### 全局设置

- Codex 命令。
- Claude Code 命令。
- 数据目录。
- 日志保留天数。
- 日志脱敏。
- 修改管理员密码。

全局设置不再包含：

- 全局 Prompt。
- 总定时任务。
- 统一检测间隔。
- 代理连接地址。

## 管理员密码

页面默认启用管理员密码入口。

默认密码：

```text
admin
```

首次部署后建议立刻进入：

```text
全局设置 -> 新管理员密码 / 确认管理员密码 -> 保存
```

说明：

- 不需要账号，只需要密码。
- 未登录时只能看到登录页。
- 未登录直接请求 `/api/state`、`/api/logs`、`/api/checks` 等接口会返回 `401 Unauthorized`。
- 登录成功后后端会写入 HttpOnly Cookie。
- session 保存在服务进程内存中，重启服务后需要重新登录。
- 修改密码时，两个密码输入框留空表示不修改密码。

## 浏览器兼容说明

远程测试常用普通 HTTP 地址，例如：

```text
http://134.185.110.164:5173
```

该环境不一定提供 `crypto.randomUUID()`。项目内添加 provider 时使用兼容 ID 生成逻辑：

```text
crypto.randomUUID 可用时使用 crypto.randomUUID
不可用时使用时间戳 + 随机字符串
```

因此在普通 HTTP 页面下也可以正常添加模型提供商。
