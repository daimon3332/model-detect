# Model Detect 实施计划

## 0. 当前纠偏结论

上一版后端已经做到了“调用真实 CLI”，但日志里的 `request.headers`、`request.body`、`response.headers`、`response.body` 不是 CLI 发出的原始 HTTP 请求，而是后端根据 provider 配置推导出来的摘要信息。

这不符合项目目标。

项目真正要实现的是：

```text
前端
  -> 后端 API
      -> 写 provider 独立配置目录
      -> 启动本地 HTTP 代理 127.0.0.1:<proxyPort>
      -> 临时把 Codex / Claude Code 的 base_url 指向本地代理
      -> 调用真实 Codex CLI / Claude Code CLI
      -> 本地代理转发到真实上游 provider
      -> 本地代理记录 CLI 发出的原始请求头/请求体和上游响应头/响应体
      -> 后端保存检测结果和完整日志
      -> 前端展示最近 10 次状态和日志详情
```

所以后续所有实现都必须围绕“真实 CLI 原始流量采集”做，不能再用后端伪造请求头/请求体。

## 1. 项目目标

构建一个模型监控和 provider 管理工具，核心用于检测 Codex CLI 和 Claude Code CLI 在不同模型提供商、不同模型上的真实可用性。

要求：

1. 首页是模型监控。
2. 默认无任何内置 provider。
3. 用户自行添加 provider。
4. 每个 provider 可配置 Codex / Claude Code。
5. 每个 provider 可配置多个模型。
6. 每个 provider 拥有独立配置目录。
7. 检测必须调用真实 CLI。
8. 日志必须尽量记录 CLI 原始 HTTP 请求和响应。
9. 支持手动检测和定时检测。
10. Linux 作为主要部署环境。
11. 当前远程测试只允许操作 `/root/model-detect`。

## 2. 页面规划

### 2.1 模型监控首页

首页不显示大标题、统计卡片和说明性文案。

无 provider 时只显示：

```text
暂无模型提供商
[添加模型提供商]
```

添加 provider 后按 provider 分组：

```text
Provider A
  Codex
    gpt-5.5            最近10次：200 200 500 TIMEOUT ...
    gpt-5.4            最近10次：200 429 200 ...
  Claude Code
    deepseek-v4-pro    最近10次：200 200 500 ...
```

筛选：

- provider
- agent：Codex / Claude Code
- model
- state：正常 / 警告 / 异常 / 超时

点击状态码打开检测详情。

详情必须展示：

- 请求头
- 请求体
- 响应头
- 响应体
- 网关路由转发头
- 网关路由转发体

详情展示形式：

- 居中大屏弹窗，不从右侧抽屉展开。
- 顶部保留检测摘要：状态、provider、model、agent、耗时。
- 内容区只保留一行按钮：请求头、请求体、响应头、响应体、网关路由转发头、网关路由转发体。
- 默认打开请求头。
- 不展示 `CLI`、`全部交换`、`原始 JSON` 作为详情页入口。
- 后端仍保存 `stdout`、`stderr`、`exitCode`、`forward_url`、`exchanges[]`，用于后续高级诊断。

### 2.2 模型提供商页面

管理 provider：

- 添加
- 编辑
- 删除
- 启用 / 禁用
- Codex 启用 / 禁用
- Claude Code 启用 / 禁用
- Base URL
- API Key
- Prompt
- 超时时间
- 是否保存请求 / 响应 body
- 模型列表
- 定时任务开关
- 定时检测间隔使用全局统一配置，不在 provider 内单独配置

### 2.3 配置编辑

每个 provider 可编辑：

```text
.codex/config.toml
.claude/settings.json
```

前端编辑的是 provider 数据；后端执行检测时写入独立运行目录。

### 2.4 日志记录页面

表格字段：

- 时间
- Provider
- Agent
- Model
- HTTP 状态
- CLI 状态
- 耗时
- 操作

点击详情展示完整日志。

### 2.5 定时任务页面

每个 provider 配置：

- 是否启用定时检测
- 间隔分钟
- 上次运行时间
- 下次运行时间
- 手动触发

当前实现为后端每 30 秒扫描一次到期任务。

### 2.6 全局设置页面

配置：

- Codex CLI 路径
- Claude Code CLI 路径
- 数据目录
- 代理端口
- 日志保留天数
- 日志脱敏

## 3. UI 风格

参考 CCG Gateway 但不照抄。

使用：

- 浅色基底
- 蓝绿主色
- 顶部导航
- 全宽工作台
- 轻量卡片
- 淡色边框
- 柔和圆角
- 低透明玻璃感
- 表格管理
- 等宽字体配置编辑器

删除：

- MODEL MONITOR
- 首页大段说明文字
- 统计卡片
- 默认 CCG Gateway / OpenAI / Anthropic 假 provider

## 4. 后端设计

### 4.1 后端入口

```text
server/index.mjs
```

职责：

- HTTP API
- 静态前端服务
- provider 状态落盘
- CLI 配置目录写入
- CLI 调用
- 本地代理转发和日志采集
- 定时任务扫描

当前不引入 Express，使用 Node 内置模块，减少依赖。

### 4.2 数据目录

默认：

```text
data/
```

结构：

```text
data/state.json

data/providers/<provider-id>/codex-home/config.toml

data/providers/<provider-id>/claude-workspace/.claude/settings.json
```

Linux 远程测试目录：

```text
/root/model-detect/data
```

不得写入用户级配置：

```text
~/.codex/config.toml
~/.claude/settings.json
```

## 5. CLI 隔离调用方案

### 5.1 Codex

后端为每个 provider 生成：

```text
data/providers/<provider-id>/codex-home/config.toml
```

执行时设置：

```bash
CODEX_HOME=data/providers/<provider-id>/codex-home
```

执行命令：

```bash
codex exec --skip-git-repo-check --json "hello"
```

实际命令路径来自全局设置：

```text
settings.codexCommand
```

Linux 服务器当前使用项目内安装的 Codex：

```text
/root/model-detect/.tools/codex-local/node_modules/.bin/codex
```

### 5.2 Claude Code

后端为每个 provider 生成：

```text
data/providers/<provider-id>/claude-workspace/.claude/settings.json
```

执行时 cwd 设置为：

```text
data/providers/<provider-id>/claude-workspace
```

执行命令：

```bash
claude -p "hello"
```

实际命令路径来自全局设置：

```text
settings.claudeCommand
```

Linux 服务器当前使用：

```text
/root/.local/bin/claude
```

## 6. 原始 HTTP 日志采集方案

### 6.1 为什么不能只调用 CLI

只调用 CLI 能拿到：

- stdout
- stderr
- exit code
- 耗时

但看不到真实上游请求的：

- 原始请求头
- 原始请求体
- 原始响应头
- 原始响应体

所以仅调用 CLI 不够。

### 6.2 正确链路

检测时后端启动本地代理：

```text
127.0.0.1:<settings.proxyPort>
```

默认端口：

```text
7788
```

运行前临时把 CLI 配置里的 Base URL 改成本地代理。

Codex 示例：

```toml
[model_providers.provider]
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

代理收到 CLI 的请求后：

1. 读取请求头。
2. 读取请求体。
3. 根据 provider 的真实 `baseUrl` 转发到上游。
4. 读取上游响应头。
5. 读取上游响应体。
6. 原样返回给 CLI。
7. 把交换记录保存到检测日志。

### 6.3 日志结构

单次 run 保存：

```json
{
  "providerId": "...",
  "providerName": "...",
  "agent": "codex",
  "model": "gpt-5.5",
  "state": "success",
  "httpStatus": 200,
  "cliExitCode": 0,
  "latencyMs": 1234,
  "stdout": "...",
  "stderr": "...",
  "request": {
    "method": "POST",
    "url": "/v1/responses",
    "targetUrl": "https://upstream.example/v1/responses",
    "headers": {},
    "body": {}
  },
  "response": {
    "headers": {},
    "body": {}
  },
  "exchanges": []
}
```

`request` / `response` 选取主要模型请求。

`exchanges` 保存本次 CLI 过程中捕获到的全部上游请求。

### 6.4 当前限制

当前代理是 HTTP 层转发代理，不是 HTTPS MITM。

因此必须把 CLI 的 base_url 指向：

```text
http://127.0.0.1:<proxyPort>
```

而不是让 CLI 直接访问 HTTPS 上游。

这样不需要安装根证书，也不会改系统代理。

## 7. API 设计

### 7.1 `GET /api/state`

返回完整状态：

- providers
- runs
- settings

### 7.2 `POST /api/providers`

新增或更新 provider。

### 7.3 `DELETE /api/providers/:id`

删除 provider，同时删除：

- provider 配置目录
- provider 相关检测日志

### 7.4 `POST /api/settings`

保存全局设置。

### 7.5 `POST /api/checks`

执行检测。

请求：

```json
{
  "providerId": "可选"
}
```

不传 providerId 表示检测全部启用 provider。

### 7.6 `GET /api/logs`

返回检测日志。

## 8. Provider 配置字段

```ts
interface ProviderConfig {
  id: string
  name: string
  enabled: boolean
  baseUrl: string
  apiKey: string
  codexEnabled: boolean
  claudeEnabled: boolean
  prompt: string
  timeoutSeconds: number
  scheduleEnabled: boolean
  saveBody: boolean
  models: ProviderModel[]
  codexConfig: string
  claudeSettings: string
  lastRunAt?: string
  nextRunAt?: string
}
```

## 9. 测试计划

### 9.1 本地验证

```bash
npm run typecheck
npm run build
node --check server/index.mjs
```

### 9.2 本地 API 验证

```bash
PORT=5180 MODEL_DETECT_DATA_DIR=./data-test npm run server
curl http://127.0.0.1:5180/api/state
```

验证：

- `data-test/state.json` 自动生成
- API 返回空 providers
- 不写用户级配置

### 9.3 Linux 部署验证

只操作：

```text
/root/model-detect
```

启动：

```bash
cd /root/model-detect
npm run build
nohup npm run server > server.log 2>&1 & echo $! > server.pid
```

确认：

```bash
ss -ltnp | grep ':5173'
cat server.log
```

MCP 浏览器访问：

```text
http://134.185.110.164:5173
```

### 9.4 真实 CLI 检测

只执行短 prompt：

```text
hello
```

只做两次成功验证：

1. Codex + 鲨鱼辣椒 + `gpt-5.5`
2. Claude Code + DeepSeek + `deepseek-v4-pro`

成功后停止，避免浪费 token。

### 9.5 日志验证重点

点击状态码后必须看到：

- Codex 真实请求头里出现类似：
  - `session-id`
  - `x-codex-beta-features`
  - `x-codex-window-id`
  - `x-client-request-id`
  - `x-codex-turn-metadata`
  - `originator`
  - `user-agent`
  - `authorization`
- 请求体是 CLI 发出的原始 JSON，而不是后端伪造摘要。
- 响应头来自真实上游。
- 响应体来自真实上游。
- `stdout` / `stderr` 仍保留 CLI 输出。

## 10. 当前已完成

- 多页面前端。
- provider CRUD。
- localStorage 回退。
- Node 后端基础 API。
- provider 状态落盘。
- 独立 Codex / Claude 配置目录。
- 真实 CLI 调用。
- 定时任务扫描。
- 本地代理采集原始 HTTP 交换的代码已加入。

## 11. 当前待验证

- 重新部署 Linux 后端：已完成。
- 执行 Codex / Claude 各一次短测：已完成。
- 确认日志里的请求头/请求体来自代理捕获：已完成。
- MCP 浏览器确认详情页展示正确：已完成。

## 11.1 已验证的真实请求头

Codex + 鲨鱼辣椒 + `gpt-5.5` 已捕获：

```text
x-codex-beta-features
x-codex-window-id
x-codex-turn-metadata
x-client-request-id
session-id
thread-id
originator
user-agent
content-length
```

Claude Code + DeepSeek + `deepseek-v4-pro` 已捕获：

```text
x-claude-code-session-id
anthropic-beta
anthropic-version
x-stainless-arch
x-stainless-lang
x-stainless-os
x-stainless-package-version
x-stainless-runtime
x-api-key
x-app
```

详情页已调整为一行按钮切换：

```text
请求头 / 请求体 / 响应头 / 响应体 / 网关路由转发头 / 网关路由转发体
```

## 14. 三级定时任务与 Prompt 规则

最新需求要求定时任务和 prompt 都能配置到具体模型。

### 定时任务

定时任务采用三级开关：

```text
settings.scheduleEnabled
provider.scheduleEnabled
model.scheduleEnabled
```

执行条件：

```text
settings.scheduleEnabled === true
provider.enabled === true
provider.scheduleEnabled === true
model.enabled === true
model.scheduleEnabled !== false
agent 开关开启
```

关闭总定时任务时，所有 provider / model 定时检测失效。

关闭 provider 时，该 provider 下所有 model 失效。

关闭 provider 定时任务时，该 provider 下所有 model 定时检测失效。

关闭单个 model 定时任务时，只影响该模型。

定时执行间隔统一使用：

```text
settings.scheduleMinutes
```

### Prompt

Prompt 采用三级优先级：

```text
model.prompt
provider.prompt
settings.prompt
Hello
```

手动检测和定时检测都使用同一套 prompt 解析规则。

## 15. 请求详情页面规则

请求详情页改为一行按钮切换，不再展示 CLI / 全部交换 / 原始 JSON 作为主入口。

按钮顺序固定：

```text
请求头
请求体
响应头
响应体
网关路由转发头
网关路由转发体
```

默认打开：

```text
请求头
```

字段来源：

```text
请求头 = logDetail.client_headers
请求体 = logDetail.client_body
响应头 = logDetail.provider_headers
响应体 = logDetail.provider_body
网关路由转发头 = logDetail.forward_headers
网关路由转发体 = logDetail.forward_body
```

展示策略：

- 前端不再做 32K 字符截断。
- 字符串 body 按原始文本展示，不再 `JSON.stringify` 成带引号和 `\n` 转义的一行。
- SSE / event-stream 响应按换行展示。
- 后端仍保留日志体积上限，超过上限时由后端写入 `[truncated ... chars]` 标记。

## 12. 后续优化

1. 日志 body 大小限制可配置。
2. `exchanges[]` 在前端增加独立多请求切换 UI。
3. 定时任务页面展示上次/下次运行时间。
4. 支持只检测 provider 下选中的部分模型。
5. 后端增加 SQLite 替换 JSON 文件。
6. 增加 systemd 服务文件。
7. 增加日志清理任务。
8. 增加导出日志功能。

## 13. CCG Gateway 日志实现参考依据

已在当前工作区 `_refs/ccg-gateway` 查看参考项目，关键文件：

```text
_refs/ccg-gateway/src-tauri/src/db/models.rs
_refs/ccg-gateway/src-tauri/src/api/handlers.rs
_refs/ccg-gateway/src-tauri/src/services/stats.rs
_refs/ccg-gateway/src-tauri/src/commands/log_commands.rs
_refs/ccg-gateway/frontend/src/views/logs/index.vue
```

参考到的核心设计：

1. 后端日志结构使用 `RequestLogInfo`。
2. 详情字段分为：
   - `client_headers`
   - `client_body`
   - `forward_url`
   - `forward_headers`
   - `forward_body`
   - `provider_headers`
   - `provider_body`
   - `error_message`
3. 列表表只保存摘要字段。
4. 大体积详情拆成单独文件保存。
5. 前端详情页把三段日志映射成六个按钮：
   - 请求头 = `client_headers`
   - 请求体 = `client_body`
   - 响应头 = `provider_headers`
   - 响应体 = `provider_body`
   - 网关路由转发头 = `forward_headers`
   - 网关路由转发体 = `forward_body`
6. `forward_url` 和 `exchanges[]` 作为后端诊断数据保留。
7. 前端对 JSON 做格式化和大区域预览。

本项目已按该模板调整：

- 后端代理捕获 `client / forward / provider` 三段。
- run 中新增 `logDetail`。
- 前端详情改为居中大屏弹窗。
- 弹窗显示请求头、请求体、响应头、响应体、网关路由转发头、网关路由转发体六个按钮。
- 保留 `forward_url` 和 `exchanges[]` 用于后续高级诊断。

## 16. 本轮确认实施计划：模型检测按钮、提示词页、定时粒度、外部代理

用户已确认本轮继续实施以下改动，实施顺序必须先更新 `plan.md`，再修改代码，最后更新 `README.md`、验证、部署 Linux。

### 16.1 模型监控页增加单模型检测按钮

模型监控首页当前已有：

```text
检测全部
provider 级检测
```

需要在每个模型行增加单模型检测按钮：

```text
模型名 / Agent / [检测] / 最近10次检测
```

后端 `/api/checks` 支持更细粒度参数：

```json
{
  "providerId": "可选",
  "agent": "可选，codex 或 claude",
  "modelName": "可选"
}
```

执行规则：

- 不传参数：检测全部启用 provider 下全部启用模型。
- 只传 `providerId`：检测该 provider 下全部启用模型。
- 传 `providerId + agent + modelName`：只检测指定模型。
- 手动检测不受定时任务开关影响。

### 16.2 新增“提示词”页面

新增顶部导航页面：

```text
提示词
```

提示词配置从全局设置和 provider 抽屉中移出，集中到提示词页面。

页面结构：

```text
全局 Prompt

Provider A
  Provider Prompt
  Model A Prompt
  Model B Prompt

Provider B
  Provider Prompt
  Model Prompt
```

保存规则：

- 全局 Prompt 保存到 `settings.prompt`。
- Provider Prompt 保存到 `provider.prompt`。
- Model Prompt 保存到 `model.prompt`。

解析优先级保持不变：

```text
model.prompt -> provider.prompt -> settings.prompt -> Hello
```

### 16.3 修复 provider 编辑按钮

模型提供商页面的编辑按钮必须稳定生效。

修复策略：

- 编辑按钮使用 `@click.stop.prevent`，避免事件冒泡干扰。
- provider 配置由侧边抽屉改为居中大弹窗，避免 drawer 层级或遮罩导致点击无效。
- 保存逻辑仍使用 `saveProviderApi`。

### 16.4 定时任务改为天 / 小时 / 分钟

定时任务页保留总定时任务开关，但间隔配置改为三个输入：

```text
天 / 小时 / 分钟
```

字段：

```ts
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

说明：

- `24 小时` 等价于 `1 天`。
- `60 分钟` 等价于 `1 小时`。
- 所以小时上限使用 23，分钟上限使用 59。
- 如果全部为 0，后端按最小 1 分钟保护处理。

兼容旧数据：

```text
旧 settings.scheduleMinutes 可能是 1 - 1440 或更大
读取时转换为 days / hours / minutes
```

### 16.5 全局设置页精简

全局设置页移除：

- 总定时任务
- 统一检测间隔
- 全局 Prompt

这些配置分别迁移到：

```text
总定时任务 + 间隔 -> 定时任务页
全局 Prompt -> 提示词页
```

全局设置页保留：

- Codex 命令
- Claude Code 命令
- 数据目录
- 代理连接地址
- 日志保留天数
- 日志脱敏

### 16.6 Provider 级代理连接地址

用户要求代理配置放在每个模型提供商中，不放在全局设置中。默认无代理。

每个 provider 可单独配置一个“外部网络代理连接地址”，可能是 HTTP，也可能是 SOCKS5，例如：

```text
http://127.0.0.1:7890
socks5://127.0.0.1:7890
```

新增字段：

```ts
provider.proxyUrl
```

全局设置不再显示代理连接地址。

模型提供商页面必须展示代理状态：

```text
无代理
代理：http://127.0.0.1:7890
代理：socks5://127.0.0.1:7890
```

注意区分两个代理：

#### 内部抓包代理

用于捕获 CLI 原始请求头 / 请求体 / 响应头 / 响应体：

```text
http://127.0.0.1:<captureProxyPort>
```

当前默认仍为：

```text
7788
```

该代理不能替换成 SOCKS5，否则无法捕获 CLI 原始 HTTP 内容。

#### Provider 外部网络代理

用户在每个 provider 中配置的上游出站代理：

```text
provider.proxyUrl
```

链路：

```text
CLI
  -> 内部抓包代理 127.0.0.1:7788
    -> 如果 provider.proxyUrl 为空：直连 provider
    -> 如果 provider.proxyUrl 为 http://...：通过 HTTP 代理请求 provider
    -> 如果 provider.proxyUrl 为 socks5://...：通过 SOCKS5 代理请求 provider
```

实现要求：

- 支持 `http://`、`https://`、`socks://`、`socks5://`。
- 留空表示该 provider 直连。
- README 必须明确说明：该配置不是内部抓包代理，而是 provider 级上游出站代理。

### 16.7 验证计划

本地验证：

```bash
npm install
npm run typecheck
node --check server/index.mjs
npm run build
```

Linux 部署验证：

```bash
cd /root/model-detect
npm install
npm run typecheck
node --check server/index.mjs
npm run build
重启 5173 服务
```

MCP 浏览器验证：

- 模型监控页每个模型行有检测按钮。
- 模型提供商编辑按钮能打开配置弹窗。
- 新增“提示词”页面。
- 提示词页能编辑全局、provider、model prompt。
- 定时任务页显示天 / 小时 / 分钟。
- 全局设置不再显示总定时任务、统一检测间隔、全局 Prompt。
- 模型提供商页面展示无代理或 provider 代理地址。
- 全局设置不显示代理连接地址。
- 请求详情页仍保持六个按钮。
- SSE 响应体仍按多行展示。

默认不主动触发真实 CLI 检测，避免浪费 token。

## 17. 本轮确认实施计划：添加供应商修复与详情 JSON 折叠

用户确认继续实施以下修复。

### 17.1 添加供应商无反应

远程 `http://134.185.110.164:5173` 页面复现到真实错误：

```text
TypeError: crypto.randomUUID is not a function
```

原因：页面运行在普通 HTTP IP 地址下，浏览器可能不提供 `crypto.randomUUID()`。

修复：

```ts
function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
```

替换 `createProviderDraft()` 里的 `crypto.randomUUID()`。

### 17.2 模型提供商编辑按钮

此前 `structuredClone(provider)` 在 Vue reactive proxy 上会报：

```text
DataCloneError
```

已改为：

```ts
JSON.parse(JSON.stringify(provider))
```

本轮继续验证：

- 顶部添加提供商。
- 模型提供商页编辑按钮。
- 模型监控页点击 provider 名称。

都必须能打开 provider 配置弹窗。

### 17.3 请求详情 JSON 折叠 / 展开

当前详情页是 `<pre>` 文本展示。需要改为：

- object / array 使用 JSON Tree 递归展示。
- 每个对象 / 数组节点可以折叠和展开。
- 默认展开第一层。
- string body 保持文本展示。
- 如果 string body 是合法 JSON，先解析成 JSON Tree。
- SSE / event-stream 字符串继续按多行文本展示，不强制转 JSON Tree。

六个详情入口保持不变：

```text
请求头
请求体
响应头
响应体
网关路由转发头
网关路由转发体
```

### 17.4 验证

本地验证：

```bash
npm run typecheck
node --check server/index.mjs
npm run build
```

Linux 验证：

- 同步到 `/root/model-detect`。
- `npm run typecheck`。
- `node --check server/index.mjs`。
- `npm run build`。
- 重启 5173。
- MCP 浏览器验证添加、编辑、JSON 折叠。

默认不触发真实模型检测。

## 18. 本轮确认实施计划：管理员密码入口

用户确认增加一个简单管理员入口。

### 18.1 目标

进入页面前必须输入管理员密码，否则不能看到模型监控、模型提供商、日志、请求详情和全局设置。

规则：

```text
不需要账号
只需要密码
默认密码：admin
全局设置可以修改密码
```

### 18.2 后端鉴权

新增设置字段：

```ts
settings.adminPassword
```

默认值：

```text
admin
```

新增 API：

```text
POST /api/login
POST /api/logout
GET /api/session
```

登录成功后，后端设置 HttpOnly Cookie：

```text
model_detect_session=<token>; HttpOnly; Path=/; SameSite=Lax
```

session token 保存在后端内存中，服务重启后需要重新登录。

### 18.3 API 保护

除以下接口外，所有 `/api/*` 都需要登录：

```text
POST /api/login
POST /api/logout
GET /api/session
```

受保护接口包括：

```text
GET /api/state
GET /api/logs
POST /api/providers
DELETE /api/providers/:id
POST /api/settings
POST /api/checks
```

未登录时返回：

```http
401 Unauthorized
```

### 18.4 前端登录页

App 启动后先调用：

```text
GET /api/session
```

未登录时只显示登录页：

```text
Model Detect
管理员密码
进入
```

登录成功后再加载主应用状态。

### 18.5 全局设置修改密码

全局设置增加：

```text
新管理员密码
确认管理员密码
```

保存规则：

- 留空表示不修改密码。
- 两次输入必须一致。
- 新密码不能为空字符串。
- 保存后写入 `settings.adminPassword`。

### 18.6 验证

本地验证：

```bash
npm run typecheck
node --check server/index.mjs
npm run build
```

功能验证：

- 打开页面先显示登录页。
- 错误密码不能进入。
- 默认密码 `admin` 可以进入。
- 未登录请求 `/api/state` 返回 401。
- 登录后 `/api/state` 正常。
- 全局设置可以修改密码。
- 清 cookie 后新密码生效。

