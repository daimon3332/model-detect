# Plan

## 本轮目标

1. 将模型提供商默认超时时间从 `90` 秒改为 `20` 秒。
2. 新增清空检测记录功能，支持三个层级：
   - 全部检测记录
   - 指定模型提供商的检测记录
   - 指定模型提供商 + 指定 agent + 指定模型的检测记录
3. 前端在模型监控页和日志记录页提供清空入口。
4. 更新 README，说明默认超时和清空检测记录规则。
5. 本地验证后提交、推送，并同步部署到 Linux `/root/model-detect`。

## 设计细节

### 1. 默认超时改为 20 秒

后端：

```js
normalizeProvider(provider):
  timeoutSeconds = Number(provider.timeoutSeconds || 20)

runOne(...):
  timeoutMs = Math.max(5, Number(provider.timeoutSeconds || 20)) * 1000
```

前端新建 provider 默认值同步改为：

```ts
timeoutSeconds: 20
```

Provider 编辑弹窗仍保留 `5 - 600` 秒范围。

### 2. 清空检测记录 API

新增后端接口：

```http
POST /api/runs/clear
```

请求体：

```ts
{
  providerId?: string
  agent?: 'codex' | 'claude'
  modelName?: string
}
```

清空规则：

```text
无 providerId
  -> 清空全部 runs

providerId only
  -> 清空该 provider 下全部 runs

providerId + agent + modelName
  -> 清空该 provider 下指定 agent/model 的 runs
```

为了避免页面显示旧状态，清空后同步维护运行时间字段：

```text
清空全部：
  provider.lastRunAt = ''
  provider.nextRunAt = ''
  model.lastRunAt = ''
  model.nextRunAt = ''

清空 provider：
  当前 provider.lastRunAt = ''
  当前 provider.nextRunAt = ''
  当前 provider 所有 model lastRunAt/nextRunAt = ''

清空单模型：
  当前 model lastRunAt/nextRunAt = ''
  当前 provider.lastRunAt 根据剩余 runs 重新计算
```

### 3. 前端 API

新增：

```ts
clearRunsApi(state, target)
```

调用 `/api/runs/clear`，返回新的 `AppState` 后 `assignState`。

### 4. 前端入口

模型监控页：

- 顶部增加 `清空全部记录`。
- provider 卡片增加 `清空该提供商记录`。
- 每个模型行增加 `清空记录`。

日志记录页：

- 增加 `清空全部记录`。

所有清空动作都先弹确认框，确认后调用 API 并刷新 state。

### 5. 文档

更新 README：

- 默认超时：`20s`。
- 清空检测记录支持全部 / provider / provider+agent+model 三层级。

## 验证

本地：

```bash
npm run typecheck
npm run build
node --check server/index.mjs
```

Linux：

```bash
cd /root/model-detect
git pull
export PATH=/root/model-detect/.tools/node-v20.19.5-linux-arm64/bin:$PATH
npm install
npm run build
fuser -k 20020/tcp || true
PORT=20020 nohup npm run server > server.log 2>&1 & echo $! > server.pid
curl -s -D - http://127.0.0.1:20020/api/session
```
