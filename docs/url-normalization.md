# Base URL 自动规范化规则

模型提供商填写的是 API base，不是完整 endpoint。项目运行时会按 CLI 类型自动规范化，避免出现 `/v1/v1/messages`、`/v1/responses/responses` 这类重复路径。

## 标准 endpoint

| API 类型 | 标准 endpoint |
| --- | --- |
| OpenAI Chat Completions | `/v1/chat/completions` |
| OpenAI Responses API | `/v1/responses` |
| Anthropic Messages API | `/v1/messages` |

本项目调用真实 CLI：

```text
Codex CLI       -> 在 base_url 后追加 /responses
Claude Code CLI -> 在 ANTHROPIC_BASE_URL 后追加 /v1/messages
```

所以运行时要给两个 CLI 不同形式的 base。

## 统一处理流程

1. 读取用户填写的 Base URL。
2. 如果用户误填完整 endpoint，先去掉 endpoint：
   - `/v1/responses` -> `/v1`
   - `/v1/chat/completions` -> `/v1`
   - `/v1/messages` -> `/v1`
   - `/anthropic/v1/messages` -> `/anthropic/v1`
3. 按 CLI 类型规范化：
   - Codex：base 必须以一个版本段结尾，默认补 `/v1`。
   - Claude Code：base 不能以版本段结尾，末尾 `/v1` 会被移除。
4. CLI 再追加自己的 endpoint。

## Claude Code 规则

Claude Code 自己追加：

```text
/v1/messages
```

因此 `ANTHROPIC_BASE_URL` 末尾不能保留 `/v1`。

| 用户填写 | 运行时上游 base | Claude Code 追加 | 最终上游路径 |
| --- | --- | --- | --- |
| `https://anyrouter.top` | `https://anyrouter.top` | `/v1/messages` | `/v1/messages` |
| `https://anyrouter.top/v1` | `https://anyrouter.top` | `/v1/messages` | `/v1/messages` |
| `https://anyrouter.top/v1/messages` | `https://anyrouter.top` | `/v1/messages` | `/v1/messages` |
| `https://api.deepseek.com/anthropic` | `https://api.deepseek.com/anthropic` | `/v1/messages` | `/anthropic/v1/messages` |
| `https://api.deepseek.com/anthropic/v1` | `https://api.deepseek.com/anthropic` | `/v1/messages` | `/anthropic/v1/messages` |
| `https://api.deepseek.com/anthropic/v1/messages` | `https://api.deepseek.com/anthropic` | `/v1/messages` | `/anthropic/v1/messages` |

DeepSeek 的 `/anthropic` 只来自 base，`/v1/messages` 只来自 Claude Code，最终只会是：

```text
/anthropic/v1/messages
```

不会变成：

```text
/anthropic/anthropic/v1/messages
/v1/v1/messages
```

## Codex 规则

Codex Responses API 自己追加：

```text
/responses
```

因此 `base_url` 需要保留或补齐一个 `/v1`。

| 用户填写 | 运行时上游 base | Codex 追加 | 最终上游路径 |
| --- | --- | --- | --- |
| `https://anyrouter.top` | `https://anyrouter.top/v1` | `/responses` | `/v1/responses` |
| `https://anyrouter.top/v1` | `https://anyrouter.top/v1` | `/responses` | `/v1/responses` |
| `https://anyrouter.top/v1/responses` | `https://anyrouter.top/v1` | `/responses` | `/v1/responses` |
| `https://anyrouter.top/v1/chat/completions` | `https://anyrouter.top/v1` | `/responses` | `/v1/responses` |
| `https://gateway.test/openai` | `https://gateway.test/openai/v1` | `/responses` | `/openai/v1/responses` |
| `https://gateway.test/openai/v1/responses` | `https://gateway.test/openai/v1` | `/responses` | `/openai/v1/responses` |

项目不会把 Codex 的真实 Responses 请求转换成 Chat Completions。用户误填 `/v1/chat/completions` 时，只会把它还原为 `/v1` base，然后仍由 Codex 请求 `/v1/responses`。

## 填写建议

优先填写最短、最稳定的 base：

```text
OpenAI-compatible / Codex: https://host 或 https://host/v1
Anthropic-compatible / Claude Code: https://host 或 https://host/anthropic
DeepSeek Claude Code: https://api.deepseek.com/anthropic
```

不要手动填写完整 endpoint；即使填写了，项目也会尽量还原成正确 base。

## Claude Code 鉴权头和超时显示

Claude Code CLI 的原始请求可能同时带有：

```text
authorization: Bearer <token>
x-api-key: <token>
```

项目的捕获代理会保留 `client_headers` 用于观察 CLI 原始请求，但转发到上游时会使用当前模型提供商配置的 API Key 统一覆盖：

```text
authorization: Bearer <provider.apiKey>
x-api-key: <provider.apiKey>
```

这样可以避免 CLI 环境变量或旧 settings 里残留的 `x-api-key` 被上游优先校验，导致“无效的令牌”。

如果 CLI 最终超时，但代理已经捕获到上游 HTTP 响应，页面优先展示上游状态码和错误体。例如上游已返回 401/429/503 时，检测结果显示 `failed + HTTP 状态码 + provider error.message`，不再简单显示 `timeout`。只有完全没有捕获到模型请求响应时，才显示 `timeout`。
