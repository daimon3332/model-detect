# Plan

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
