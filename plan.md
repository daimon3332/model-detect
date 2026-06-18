# Plan

## 当前任务：默认 CLI 配置模板与重置功能

### 用户要求

1. 全局默认 Codex `config.toml` 必须按指定内容保存，不在全局默认模板里写 `env_key`：

```toml
model_reasoning_summary = "none"
model_reasoning_effort = "low"
model_verbosity = "low"
model = "gpt-5.5"
model_provider = "provider"
approval_policy = "never"
sandbox_mode = "read-only"
model_instructions_file = "~/.codex/instruction.md"

[model_providers.provider]
name = "Provider"
base_url = "https://example.com/v1"
wire_api = "responses"
```

2. Codex 运行时仍由 `buildCodexConfig()` 自动补 `env_key = "OPENAI_API_KEY"`，用于把 provider 的 API Key 注入给真实 Codex CLI。
3. 新增后端统一重置接口：

```http
POST /api/providers/reset-config
```

请求体：

```json
{
  "providerId": "可选，不传表示全部 provider",
  "target": "codex 或 claude"
}
```

4. 重置逻辑：

```text
target = codex  -> provider.codexConfig = state.settings.defaultCodexConfig
target = claude -> provider.claudeSettings = state.settings.defaultClaudeSettings
providerId 为空 -> 重置全部 provider
providerId 存在 -> 只重置指定 provider
每个变更后的 provider 调用 materializeProvider(provider)
返回 publicState
```

5. 重置不修改：

```text
API Key
Base URL
模型列表
prompt
定时任务
检测记录
管理员密码
```

6. 全局设置页面新增：
   - 重置所有 Codex config.toml
   - 重置所有 Claude settings.json
7. 单个提供商编辑弹窗中，在对应配置编辑区上方新增：
   - 重置 Codex config.toml
   - 重置 Claude settings.json
8. README 增加完整默认 Codex `config.toml`、重置功能说明和更新部署说明。
9. 完成验证、提交、push，并同步 Linux `/root/model-detect`，构建后重启 `PORT=20020` 服务。

### 实施步骤

1. 修改 `server/index.mjs`：
   - 调整 `defaultCodexConfig` 为用户指定内容和顺序。
   - 保留 `buildCodexConfig()` 运行时自动补 `env_key` 的逻辑。
   - 新增 `resetProviderConfig()`。
   - 在 `handleApi()` 增加 `POST /api/providers/reset-config`。
2. 修改 `src/mockApi.ts`：
   - 调整前端 mock 默认 Codex 模板，与后端保持一致。
3. 修改 `src/api.ts`：
   - 新增 `resetProviderConfigApi()`。
4. 修改 `src/App.vue`：
   - 引入 `resetProviderConfigApi()`。
   - 新增全局重置按钮和确认框。
   - 新增 provider 弹窗内局部重置按钮。
   - 局部重置只修改当前弹窗 draft，点击保存后才写入 provider。
5. 修改 `README.md`：
   - 补全默认 Codex 模板。
   - 说明全局重置和单 provider 重置的行为边界。
   - 保留并强调 `git pull -> npm install -> npm run build -> 重启后台`。
6. 验证：

```bash
npm run typecheck
npm run build
node --check server/index.mjs
```

当前本地验证结果：

```text
npm run typecheck               通过
npm run build                   通过
node --check server/index.mjs   通过
```

7. Git：

```bash
git status --short
git add .
git commit -m "Add provider config reset controls"
git push
```

8. Linux 同步：

```bash
cd /root/model-detect
git pull --ff-only
npm install
npm run build
fuser -k 20020/tcp || true
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
curl http://127.0.0.1:20020/api/session
```

---

## 本轮目标

1. 修复“定时任务”页面开关点击后先滑回、再滑过去的问题。
2. 新添加的模型提供商和模型默认不开启定时任务。
3. 增加备份导出 / 导入功能，方便迁移到其他服务器。
4. 全局提示词拆分为 Codex Prompt 和 Claude Code Prompt。
5. 优化 Claude Code 默认检测提示词和默认 settings，减少 Claude Code 检测回复长度和额外开销。
6. 检测详情的 `CLI 输入输出 / 请求头 / 请求体 / 响应头 / 响应体 / 网关路由转发头 / 网关路由转发体` 增加一键复制。
7. 检测详情 JSON 默认展开，不再默认折叠。
8. 更新 README，补充定时任务、备份迁移、Claude Code 低输出检测、详情复制等说明。
9. 完成 typecheck/build/server 语法验证，提交并推送。

## 问题原因

### 定时任务开关抖动

当前定时任务页直接用：

```vue
<el-switch v-model="provider.scheduleEnabled" @change="saveTaskProvider(provider)" />
<el-switch v-model="model.scheduleEnabled" @change="saveTaskProvider(provider)" />
```

`saveTaskProvider(provider)` 会调用完整 provider 保存接口：

```text
POST /api/providers
  -> normalizeProvider
  -> materializeProvider
  -> 写 data/providers/<provider-id>/codex-home/config.toml
  -> 写 data/providers/<provider-id>/claude-workspace/.claude/settings.json
  -> 返回 state
```

这条路径适合“编辑提供商配置”，但不适合定时任务开关。定时任务开关只需要改几个布尔值，却走了重路径；如果请求超时或被刷新状态覆盖，Element Plus switch 就会出现：

```text
用户点击 -> v-model 本地切过去 -> API 超时/旧 state 覆盖 -> 滑回去 -> 后端稍后保存/刷新 -> 又滑过去
```

Nginx 返回 `504 Gateway Time-out` 说明反代等后端响应超过超时时间，不是浏览器单纯网络慢。

## 实施方案

### 1. 新增轻量定时任务 API

新增三个只更新定时任务字段的接口：

```http
POST /api/schedule/settings
POST /api/schedule/provider
POST /api/schedule/model
```

它们只更新：

```ts
settings.scheduleEnabled
settings.scheduleDays
settings.scheduleHours
settings.scheduleMinutes
provider.scheduleEnabled
model.scheduleEnabled
```

不重写 Codex / Claude Code 配置文件，不调用 `materializeProvider()`。

### 2. 前端 switch 独立保存和失败回滚

前端为每个开关维护独立 saving key：

```ts
scheduleSaving[key] = true
try {
  await saveScheduleXxxApi(...)
} catch {
  switchValue = previousValue
}
finally {
  scheduleSaving[key] = false
}
```

这样某个模型的定时任务开关保存中，不影响其他模型、其他提供商和其他页面操作。

### 3. 默认关闭定时任务

新增 provider：

```ts
scheduleEnabled: false
```

新增模型：

```ts
scheduleEnabled: false
```

后端 normalize 也改为只有显式 `true` 才开启，避免历史空值被当成开启。

### 4. 备份导出 / 导入

新增：

```http
GET /api/backup/export
POST /api/backup/import
```

导出结构：

```json
{
  "version": 1,
  "exportedAt": "ISO time",
  "state": {
    "providers": [],
    "settings": {}
  },
  "runs": []
}
```

导入采用覆盖模式：

```text
导入 providers/settings/runs
重建 data/providers/<provider-id>/codex-home/config.toml
重建 data/providers/<provider-id>/claude-workspace/.claude/settings.json
```

备份包含 API Key、管理员密码配置、检测日志和请求/响应内容，README 必须提示妥善保存。

### 5. 全局 Prompt 拆分

新增：

```ts
settings.codexPrompt
settings.claudePrompt
```

保留旧字段：

```ts
settings.prompt
```

用于兼容旧数据。

检测时优先级：

```text
model.prompt > provider.prompt > agent-specific global prompt > default
```

即：

```ts
const globalPrompt = model.agent === 'claude'
  ? state.settings.claudePrompt
  : state.settings.codexPrompt
```

默认值：

```text
Codex Prompt: Hello
Claude Code Prompt: Reply exactly: ok
```

### 6. Claude Code 低输出 / 低开销默认配置

根据官方文档：

- `claude -p` 是 print mode。
- `--bare` 会跳过 hooks、skills、plugins、MCP servers、auto memory、CLAUDE.md 自动发现，使脚本调用更快。
- `--max-turns 1` 限制 agent turn。
- `--no-session-persistence` 禁用会话持久化。
- `--effort low` 降低 reasoning effort。
- `MAX_THINKING_TOKENS=0` 可关闭或省略 thinking 参数。
- `CLAUDE_CODE_EFFORT_LEVEL=low` 可设置低 effort。

实现：

```bash
claude --bare --max-turns 1 --no-session-persistence --effort low --settings <run-settings.json> -p "Reply exactly: ok"
```

同时默认 Claude settings 模板增加：

```json
{
  "env": {
    "MAX_THINKING_TOKENS": "0",
    "CLAUDE_CODE_EFFORT_LEVEL": "low",
    "CLAUDE_CODE_SKIP_PROMPT_HISTORY": "1"
  }
}
```

### 7. 检测详情复制和 JSON 默认展开

详情页按钮保持：

```text
CLI 输入输出 | 请求头 | 请求体 | 响应头 | 响应体 | 网关路由转发头 | 网关路由转发体
```

新增“复制当前内容”按钮。

复制内容规则：

```ts
object/array -> JSON.stringify(value, null, 2)
string       -> 原文本
其他类型     -> String(value)
```

JSON Tree 默认全部展开。

## 验证

本地运行：

```bash
npm run typecheck
npm run build
node --check server/index.mjs
```

通过后再提交和推送。

## 本轮追加文档更新

1. 回答 Codex 是否还有更省 token 的方案。
2. 将当前 Claude Code 省 token 方案补充到 README。
3. README 新增 Codex 省 token 策略说明：
   - 更短 prompt：`Reply exactly: ok`
   - `model_verbosity = "low"`
   - `model_reasoning_effort = "low"`
   - `model_reasoning_summary = "none"`
   - 空临时 workspace 属于更激进方案，会降低真实项目内 CLI 调用相似度，暂不作为默认。
4. README 明确 Claude Code 当前方案：
   - `Reply exactly: ok`
   - `--bare`
   - `--max-turns 1`
   - `--no-session-persistence`
   - `--effort low`
   - `--settings <run-settings.json>`
   - `MAX_THINKING_TOKENS=0`
   - `CLAUDE_CODE_EFFORT_LEVEL=low`
   - `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`

## 本轮实施确认

用户已确认继续，并补充备份必须包含：

```text
providers
提示词
定时任务
全局配置
```

不需要包含检测记录 runs。

## 本轮目标

1. Codex 改为更省 token 的默认检测方案。
2. 备份导出不再包含测试记录，避免备份文件和导入过程被大日志拖慢。
3. 备份导入仍导入 providers、提示词、定时任务、全局配置。
4. 备份导入增加进度展示。
5. 更新 README。
6. 本地验证、提交、推送。

## Codex 省 token 实施

当前 Codex 检测已经使用每次 run 的临时 `CODEX_HOME`：

```text
data/providers/<provider-id>/run-contexts/<run-id>/codex-home
```

但当前 `cwd` 仍是项目根目录，因此 Codex 可能读取项目上下文、AGENTS.md、环境信息等。

修改为：

```text
CODEX_HOME = data/providers/<provider-id>/run-contexts/<run-id>/codex-home
cwd        = data/providers/<provider-id>/run-contexts/<run-id>/codex-workspace
```

这样 Codex 仍是真实 CLI 调用，但运行在空临时 workspace，减少项目上下文输入。

Codex 命令增加：

```bash
--ephemeral
```

默认 Codex Prompt 改为：

```text
Reply exactly: ok
```

默认 Codex `config.toml` 增加：

```toml
model_verbosity = "low"
model_reasoning_effort = "low"
model_reasoning_summary = "none"
```

## 备份导出 / 导入实施

导出结构改为：

```json
{
  "version": 2,
  "exportedAt": "ISO time",
  "state": {
    "providers": [],
    "settings": {}
  },
  "runsIncluded": false
}
```

导入规则：

```text
导入 providers/settings
忽略 backup.runs
清空当前 runs.json
重建 provider 配置目录
刷新前端状态
```

导入后的内容包括：

```text
providers
provider prompt
model prompt
settings.codexPrompt
settings.claudePrompt
定时任务总开关和间隔
provider/model 定时任务开关
全局 CLI 命令、默认模板、并发数、日志配置、管理员密码等 settings
```

## 导入进度

新增后台导入 job：

```text
POST /api/backup/import -> 返回 job
GET /api/backup/import/:id -> 查询进度
```

job 字段：

```ts
{
  id,
  status: 'queued' | 'running' | 'completed' | 'failed',
  stage,
  message,
  total,
  completed,
  error,
  done
}
```

前端导入流程：

```text
选择文件
确认覆盖
POST 创建导入任务
显示导入进度弹窗
轮询 job
完成后 refreshState
```

## 验证

```bash
npm run typecheck
npm run build
node --check server/index.mjs
```

## 本轮 README 更新

1. 在 Linux 已有仓库更新部署部分补充每次更新后的标准步骤：
   - `git pull`
   - `npm install`
   - `npm run build`
   - 重启 `PORT=20020` 后台服务
2. 明确说明：只要不确定是否有后端改动，更新后都建议重启后台服务。
3. 说明纯前端改动理论上构建后即可读取新的 `dist/`，但生产环境仍建议重启，避免旧进程、缓存或状态不同步。

