<script setup lang="ts">
import { computed, defineComponent, h, onMounted, reactive, ref, watch } from 'vue'
import {
  ElButton,
  ElCard,
  ElCheckbox,
  ElDialog,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTabPane,
  ElTabs,
  ElTag
} from 'element-plus'
import {
  CirclePlus,
  Delete,
  Document,
  EditPen,
  Files,
  Monitor,
  Refresh,
  Setting,
  Timer,
  VideoPlay
} from '@element-plus/icons-vue'
import {
  createProviderDraft,
  makeModels,
  modelsToText,
  recentRuns,
} from './mockApi'
import { deleteProviderApi, loadInitialState, refreshState, runChecksApi, saveProviderApi, saveSettingsApi } from './api'
import type { AgentType, AppState, ProviderConfig, RunState, TestRun } from './types'
import { agentLabel, formatTime, isHealthy, redact, runText, stateLabel } from './utils'

type PageKey = 'monitor' | 'providers' | 'prompts' | 'logs' | 'tasks' | 'settings'
type DetailTab = 'request_headers' | 'request_body' | 'response_headers' | 'response_body' | 'forward_headers' | 'forward_body'

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'

let JsonTree: any
JsonTree = defineComponent({
  name: 'JsonTree',
  props: {
    data: { type: null, required: true },
    nodeKey: { type: String, default: '' },
    level: { type: Number, default: 0 }
  },
  setup(props) {
    const open = ref(props.level < 1)
    return () => {
      const value = props.data
      const collapsible = isRecord(value)
      const keyNode = props.nodeKey ? h('span', { class: 'json-key' }, `${props.nodeKey}:`) : null
      if (!collapsible) {
        return h('div', { class: 'json-leaf' }, [keyNode, h('span', { class: `json-value ${typeof value}` }, formatJsonPrimitive(value))])
      }

      const isArray = Array.isArray(value)
      const entries = Object.entries(value as Record<string, unknown>)
      const start = isArray ? '[' : '{'
      const end = isArray ? ']' : '}'
      return h('div', { class: 'json-node' }, [
        h('button', { class: 'json-toggle', onClick: () => (open.value = !open.value) }, [
          h('span', { class: 'json-caret' }, open.value ? '▾' : '▸'),
          keyNode,
          h('span', { class: 'json-bracket' }, open.value ? start : `${start} ${entries.length} ${isArray ? 'items' : 'keys'} ${end}`)
        ]),
        open.value
          ? h('div', { class: 'json-children' }, [
              ...entries.map(([key, entry]) => h(JsonTree, { key, nodeKey: key, data: entry, level: props.level + 1 })),
              h('div', { class: 'json-end' }, end)
            ])
          : null
      ])
    }
  }
})

function formatJsonPrimitive(value: unknown) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  return String(value)
}

const pages: Array<{ key: PageKey; label: string; icon: unknown }> = [
  { key: 'monitor', label: '模型监控', icon: Monitor },
  { key: 'providers', label: '模型提供商', icon: Files },
  { key: 'prompts', label: '提示词', icon: EditPen },
  { key: 'logs', label: '日志记录', icon: Document },
  { key: 'tasks', label: '定时任务', icon: Timer },
  { key: 'settings', label: '全局设置', icon: Setting }
]

const state = reactive<AppState>(loadInitialState())
const page = ref<PageKey>('monitor')
const providerDrawer = ref(false)
const runDrawer = ref(false)
const activeProvider = ref<ProviderConfig | null>(null)
const activeRun = ref<TestRun | null>(null)
const activeDetailTab = ref<DetailTab>('request_headers')
const codexModelText = ref('')
const claudeModelText = ref('')
const selectedProviderId = ref('')

const filters = reactive({
  providerId: 'all',
  agent: 'all' as AgentType | 'all',
  model: 'all',
  state: 'all' as RunState | 'all'
})

const activeProviders = computed(() => state.providers.filter((provider) => provider.enabled))
const selectedProvider = computed(() => state.providers.find((item) => item.id === selectedProviderId.value) ?? null)
const latestLogs = computed(() =>
  [...state.runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
)

const visibleProviders = computed(() =>
  state.providers.filter((provider) => filters.providerId === 'all' || provider.id === filters.providerId)
)

const modelOptions = computed(() => {
  const names = visibleProviders.value.flatMap((provider) => provider.models.map((model) => model.name))
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
})

const providerModels = (provider: ProviderConfig) =>
  provider.models
    .filter((model) => model.enabled)
    .filter((model) => filters.agent === 'all' || model.agent === filters.agent)
    .filter((model) => filters.model === 'all' || model.name === filters.model)
    .filter((model) => {
      if (filters.state === 'all') return true
      const latest = recentRuns(state, provider.id, model.name, model.agent)[0]
      return latest?.state === filters.state
    })

const openCreateProvider = () => {
  activeProvider.value = createProviderDraft()
  codexModelText.value = ''
  claudeModelText.value = ''
  providerDrawer.value = true
}

const openEditProvider = (provider: ProviderConfig) => {
  activeProvider.value = JSON.parse(JSON.stringify(provider))
  codexModelText.value = modelsToText(provider, 'codex')
  claudeModelText.value = modelsToText(provider, 'claude')
  providerDrawer.value = true
}

const saveProvider = async () => {
  if (!activeProvider.value) return
  const draft = activeProvider.value
  syncActiveProviderModels()
  await saveProviderApi(state, draft)
  if (!selectedProviderId.value) selectedProviderId.value = draft.id
  providerDrawer.value = false
  ElMessage.success('已保存')
}

const deleteProvider = async (provider: ProviderConfig) => {
  await ElMessageBox.confirm(`删除 ${provider.name}？对应检测记录也会移除。`, '确认删除', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消'
  })
  await deleteProviderApi(state, provider.id)
  if (selectedProviderId.value === provider.id) selectedProviderId.value = state.providers[0]?.id ?? ''
  ElMessage.success('已删除')
}

const runChecks = async (providerId?: string, agent?: AgentType, modelName?: string) => {
  const created = await runChecksApi(state, { providerId, agent, modelName })
  ElMessage.success(created.length ? `已生成 ${created.length} 条检测记录` : '没有可检测的模型')
}

const openRun = (run: TestRun) => {
  activeRun.value = run
  activeDetailTab.value = 'request_headers'
  runDrawer.value = true
}

const openRunProvider = (run: TestRun) => {
  const provider = state.providers.find((item) => item.id === run.providerId)
  if (!provider) return
  page.value = 'providers'
  openEditProvider(provider)
}

const detailButtons: Array<{ key: DetailTab; label: string }> = [
  { key: 'request_headers', label: '请求头' },
  { key: 'request_body', label: '请求体' },
  { key: 'response_headers', label: '响应头' },
  { key: 'response_body', label: '响应体' },
  { key: 'forward_headers', label: '网关路由转发头' },
  { key: 'forward_body', label: '网关路由转发体' }
]

const detailContent = (run: TestRun) => {
  const detail = run.logDetail
  const values = {
    request_headers: detail?.client_headers ?? run.request.headers,
    request_body: detail?.client_body ?? run.request.body,
    response_headers: detail?.provider_headers ?? run.response.headers,
    response_body: detail?.provider_body ?? run.response.body,
    forward_headers: detail?.forward_headers ?? {},
    forward_body: detail?.forward_body ?? run.request.body
  }
  return values[activeDetailTab.value]
}

const syncActiveProviderModels = () => {
  if (!activeProvider.value) return
  const previous = new Map(activeProvider.value.models.map((model) => [`${model.agent}:${model.name}`, model]))
  activeProvider.value.models = [...makeModels(codexModelText.value, 'codex'), ...makeModels(claudeModelText.value, 'claude')].map((model) => ({
    ...model,
    ...(previous.get(`${model.agent}:${model.name}`) ?? {})
  }))
}

const detailPreview = (value: unknown) => {
  const safeValue = detailDisplayValue(value)
  if (typeof safeValue === 'string') return safeValue.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n')
  return JSON.stringify(safeValue, null, 2)
}

const detailDisplayValue = (value: unknown) => {
  const safeValue = redact(value)
  if (typeof safeValue !== 'string') return safeValue
  const normalized = safeValue.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n')
  const trimmed = normalized.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return normalized
  try {
    return JSON.parse(trimmed)
  } catch {
    return normalized
  }
}

const isJsonTreeValue = (value: unknown) => isRecord(detailDisplayValue(value))

const detailMeta = (value: unknown) => {
  const length = detailPreview(value).length
  if (length < 1000) return `${length} 字符`
  if (length < 1000000) return `${(length / 1000).toFixed(1)}K 字符`
  return `${(length / 1000000).toFixed(1)}M 字符`
}

const saveSettings = async () => {
  await saveSettingsApi(state)
  ElMessage.success('已保存')
}

const saveTaskProvider = async (provider: ProviderConfig) => {
  await saveProviderApi(state, provider)
}

const navToProviders = () => {
  page.value = 'providers'
  openCreateProvider()
}

watch(
  () => [filters.providerId, filters.agent],
  () => {
    if (filters.model !== 'all' && !modelOptions.value.includes(filters.model)) filters.model = 'all'
  }
)

onMounted(() => {
  refreshState(state).catch(() => undefined)
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">M</span>
        <span>Model Detect</span>
      </div>
      <nav class="nav-tabs">
        <button
          v-for="item in pages"
          :key="item.key"
          class="nav-item"
          :class="{ active: page === item.key }"
          @click="page = item.key"
        >
          <component :is="item.icon" />
          {{ item.label }}
        </button>
      </nav>
      <div class="top-actions">
        <el-button :icon="CirclePlus" type="primary" @click="openCreateProvider">添加提供商</el-button>
      </div>
    </header>

    <main class="workspace">
      <section v-if="page === 'monitor'" class="page-grid">
        <el-card shadow="never" class="glass-card">
          <div class="toolbar-only">
            <div class="head-actions">
              <el-select v-model="filters.providerId" class="control" placeholder="提供商">
                <el-option label="全部提供商" value="all" />
                <el-option v-for="provider in state.providers" :key="provider.id" :label="provider.name" :value="provider.id" />
              </el-select>
              <el-select v-model="filters.agent" class="control" placeholder="Agent">
                <el-option label="全部 Agent" value="all" />
                <el-option label="Codex" value="codex" />
                <el-option label="Claude Code" value="claude" />
              </el-select>
              <el-select v-model="filters.model" class="control wide" filterable placeholder="模型">
                <el-option label="全部模型" value="all" />
                <el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" />
              </el-select>
              <el-select v-model="filters.state" class="control" placeholder="状态">
                <el-option label="全部状态" value="all" />
                <el-option label="正常" value="success" />
                <el-option label="警告" value="warning" />
                <el-option label="异常" value="failed" />
                <el-option label="超时" value="timeout" />
              </el-select>
              <el-button :icon="VideoPlay" type="primary" @click="runChecks()">检测全部</el-button>
            </div>
          </div>

          <el-empty v-if="!state.providers.length" description="暂无模型提供商">
            <el-button type="primary" :icon="CirclePlus" @click="navToProviders">添加模型提供商</el-button>
          </el-empty>

          <div v-else class="provider-groups">
            <section v-for="provider in visibleProviders" :key="provider.id" class="provider-group">
              <div class="provider-title">
                <button @click.stop.prevent="openEditProvider(provider)">{{ provider.name }}</button>
                <span>{{ provider.baseUrl || '未配置 Base URL' }}</span>
                <div>
                  <el-tag v-if="provider.codexEnabled" effect="plain">Codex</el-tag>
                  <el-tag v-if="provider.claudeEnabled" effect="plain" type="success">Claude Code</el-tag>
                  <el-button size="small" :icon="VideoPlay" @click.stop="runChecks(provider.id)">检测</el-button>
                </div>
              </div>

              <div v-if="providerModels(provider).length" class="monitor-table">
                <div class="table-head">
                  <span>模型</span>
                  <span>Agent</span>
                  <span>操作</span>
                  <span>最近 10 次检测</span>
                </div>
                <div v-for="model in providerModels(provider)" :key="model.id" class="table-row">
                  <span class="mono">{{ model.name }}</span>
                  <el-tag effect="plain" round>{{ agentLabel(model.agent) }}</el-tag>
                  <el-button size="small" :icon="VideoPlay" @click="runChecks(provider.id, model.agent, model.name)">检测</el-button>
                  <div class="run-strip">
                    <button
                      v-for="run in recentRuns(state, provider.id, model.name, model.agent)"
                      :key="run.id"
                      class="run-chip"
                      :class="run.state"
                      @click="openRun(run)"
                    >
                      <b>{{ runText(run) }}</b>
                      <small>{{ formatTime(run.createdAt) }}</small>
                    </button>
                    <span v-if="!recentRuns(state, provider.id, model.name, model.agent).length" class="muted">
                      暂无检测记录
                    </span>
                  </div>
                </div>
              </div>
              <el-empty v-else description="该提供商暂无可显示模型" />
            </section>
          </div>
        </el-card>
      </section>

      <section v-if="page === 'providers'" class="page-grid">
        <el-card shadow="never" class="glass-card">
          <div class="toolbar-only">
            <el-button type="primary" :icon="CirclePlus" @click="openCreateProvider">添加提供商</el-button>
          </div>

          <el-empty v-if="!state.providers.length" description="暂无模型提供商">
            <el-button type="primary" :icon="CirclePlus" @click="openCreateProvider">添加模型提供商</el-button>
          </el-empty>

          <div v-else class="provider-list">
            <article v-for="provider in state.providers" :key="provider.id" class="provider-card">
              <div>
                <div class="provider-name">
                  {{ provider.name }}
                  <el-tag v-if="!provider.enabled" type="info">停用</el-tag>
                </div>
                <p>{{ provider.baseUrl || '未配置 Base URL' }}</p>
                <div class="provider-meta">
                  <span>Timeout: <b>{{ provider.timeoutSeconds }}s</b></span>
                  <span>Schedule: <b>{{ provider.scheduleEnabled ? 'on' : 'off' }}</b></span>
                  <span>Proxy: <b>{{ provider.proxyUrl || '无代理' }}</b></span>
                </div>
                <div class="agent-tags">
                  <el-tag v-if="provider.codexEnabled" effect="plain">Codex</el-tag>
                  <el-tag v-if="provider.claudeEnabled" effect="plain" type="success">Claude Code</el-tag>
                  <el-tag type="info">{{ provider.models.length }} 模型</el-tag>
                </div>
              </div>
              <div class="card-actions">
                <el-button :icon="VideoPlay" @click.stop="runChecks(provider.id)">检测</el-button>
                <el-button :icon="EditPen" @click.stop.prevent="openEditProvider(provider)">编辑</el-button>
                <el-button :icon="Delete" type="danger" plain @click="deleteProvider(provider)">删除</el-button>
              </div>
            </article>
          </div>
        </el-card>
      </section>

      <section v-if="page === 'prompts'" class="page-grid">
        <el-card shadow="never" class="glass-card prompt-card">
          <div class="prompt-global">
            <el-form label-position="top">
              <el-form-item label="全局 Prompt">
                <el-input v-model="state.settings.prompt" type="textarea" :rows="3" placeholder="Hello" />
              </el-form-item>
            </el-form>
            <el-button type="primary" @click="saveSettings">保存全局 Prompt</el-button>
          </div>

          <el-empty v-if="!state.providers.length" description="暂无模型提供商" />
          <div v-else class="prompt-provider-list">
            <article v-for="provider in state.providers" :key="provider.id" class="prompt-provider-card">
              <div class="prompt-provider-head">
                <strong>{{ provider.name }}</strong>
                <el-button size="small" type="primary" @click="saveTaskProvider(provider)">保存</el-button>
              </div>
              <el-form label-position="top">
                <el-form-item label="Provider Prompt">
                  <el-input v-model="provider.prompt" type="textarea" :rows="3" placeholder="留空继承全局 Prompt" />
                </el-form-item>
              </el-form>
              <div class="prompt-model-list">
                <div v-for="model in provider.models" :key="model.id" class="prompt-model-row">
                  <div>
                    <strong class="mono">{{ model.name }}</strong>
                    <el-tag effect="plain" round>{{ agentLabel(model.agent) }}</el-tag>
                  </div>
                  <el-input v-model="model.prompt" type="textarea" :rows="2" placeholder="留空继承 Provider / 全局 Prompt" />
                </div>
              </div>
            </article>
          </div>
        </el-card>
      </section>

      <section v-if="page === 'logs'" class="page-grid">
        <el-card shadow="never" class="glass-card">
          <div class="toolbar-only">
            <el-button :icon="Refresh" @click="refreshState(state)">刷新</el-button>
          </div>

          <el-empty v-if="!latestLogs.length" description="暂无日志记录" />
          <div v-else class="log-table">
            <div class="log-head">
              <span>时间</span>
              <span>提供商</span>
              <span>模型</span>
              <span>Agent</span>
              <span>状态</span>
              <span>耗时</span>
              <span>操作</span>
            </div>
            <div v-for="run in latestLogs" :key="run.id" class="log-row">
              <span>{{ formatTime(run.createdAt) }}</span>
              <button class="link-button" @click="openRunProvider(run)">{{ run.providerName }}</button>
              <span class="mono">{{ run.model }}</span>
              <span>{{ agentLabel(run.agent) }}</span>
              <el-tag :type="isHealthy(run) ? 'success' : 'danger'">
                {{ run.httpStatus ?? stateLabel(run.state) }}
              </el-tag>
              <span>{{ run.latencyMs }}ms</span>
              <el-button size="small" @click="openRun(run)">详情</el-button>
            </div>
          </div>
        </el-card>
      </section>

      <section v-if="page === 'tasks'" class="page-grid">
        <el-card shadow="never" class="glass-card">
          <div class="task-global">
            <el-switch v-model="state.settings.scheduleEnabled" active-text="总定时任务" @change="saveSettingsApi(state)" />
            <el-input-number v-model="state.settings.scheduleDays" :min="0" :max="365" @change="saveSettingsApi(state)" />
            <span>天</span>
            <el-input-number v-model="state.settings.scheduleHours" :min="0" :max="23" @change="saveSettingsApi(state)" />
            <span>小时</span>
            <el-input-number v-model="state.settings.scheduleMinutes" :min="0" :max="59" @change="saveSettingsApi(state)" />
            <span>分钟</span>
          </div>
          <el-empty v-if="!state.providers.length" description="暂无模型提供商" />
          <div v-else class="task-grid">
            <article v-for="provider in state.providers" :key="provider.id" class="task-card">
              <div class="task-provider-head">
                <strong>{{ provider.name }}</strong>
                <el-switch v-model="provider.scheduleEnabled" active-text="提供商" @change="saveTaskProvider(provider)" />
              </div>
              <div class="task-models">
                <label v-for="model in provider.models" :key="model.id" class="task-model-row">
                  <span class="mono">{{ model.name }}</span>
                  <el-tag effect="plain" round>{{ agentLabel(model.agent) }}</el-tag>
                  <el-switch v-model="model.scheduleEnabled" @change="saveTaskProvider(provider)" />
                </label>
              </div>
            </article>
          </div>
        </el-card>
      </section>

      <section v-if="page === 'settings'" class="page-grid">
        <el-card shadow="never" class="glass-card settings-card">
          <div class="toolbar-only">
            <el-button type="primary" @click="saveSettings">保存</el-button>
          </div>
          <el-form label-position="top">
            <el-form-item label="Codex 命令">
              <el-input v-model="state.settings.codexCommand" />
            </el-form-item>
            <el-form-item label="Claude Code 命令">
              <el-input v-model="state.settings.claudeCommand" />
            </el-form-item>
            <el-form-item label="数据目录">
              <el-input v-model="state.settings.dataDir" />
            </el-form-item>
            <el-form-item label="日志保留天数">
              <el-input-number v-model="state.settings.logRetentionDays" :min="1" :max="365" />
            </el-form-item>
            <el-form-item label="日志脱敏">
              <el-switch v-model="state.settings.redactLogs" />
            </el-form-item>
          </el-form>
        </el-card>
      </section>
    </main>

    <el-dialog v-model="providerDrawer" width="860px" top="5vh" class="provider-config-dialog" title="模型提供商配置">
      <el-form v-if="activeProvider" label-position="top" class="provider-form">
        <div class="form-grid">
          <el-form-item label="名称">
            <el-input v-model="activeProvider.name" placeholder="例如 DeepSeek / 鲨鱼辣椒" />
          </el-form-item>
          <el-form-item label="Base URL">
            <el-input v-model="activeProvider.baseUrl" placeholder="https://example.com/v1" />
          </el-form-item>
          <el-form-item label="API Key">
            <el-input v-model="activeProvider.apiKey" show-password placeholder="sk-..." />
          </el-form-item>
          <el-form-item label="代理连接地址">
            <el-input v-model="activeProvider.proxyUrl" placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7890，留空直连" />
          </el-form-item>
          <el-form-item label="CLI 超时">
            <el-input-number v-model="activeProvider.timeoutSeconds" :min="5" :max="600" />
          </el-form-item>
        </div>

        <div class="switch-line">
          <el-checkbox v-model="activeProvider.enabled">启用提供商</el-checkbox>
          <el-checkbox v-model="activeProvider.codexEnabled">Codex</el-checkbox>
          <el-checkbox v-model="activeProvider.claudeEnabled">Claude Code</el-checkbox>
          <el-checkbox v-model="activeProvider.scheduleEnabled">定时任务</el-checkbox>
          <el-checkbox v-model="activeProvider.saveBody">保存请求/响应 Body</el-checkbox>
        </div>

        <el-tabs class="config-tabs">
          <el-tab-pane label="模型">
            <div class="editor-grid">
              <el-form-item label="Codex 模型，每行一个">
                <el-input v-model="codexModelText" type="textarea" :rows="8" class="code-input" />
              </el-form-item>
              <el-form-item label="Claude Code 模型，每行一个">
                <el-input v-model="claudeModelText" type="textarea" :rows="8" class="code-input" />
              </el-form-item>
            </div>
            <div class="model-config-toolbar">
              <el-button @click="syncActiveProviderModels">应用模型列表</el-button>
            </div>
            <div v-if="activeProvider.models.length" class="model-config-list">
              <article v-for="model in activeProvider.models" :key="model.id" class="model-config-row">
                <div>
                  <strong class="mono">{{ model.name }}</strong>
                  <el-tag effect="plain" round>{{ agentLabel(model.agent) }}</el-tag>
                </div>
                <el-switch v-model="model.enabled" active-text="启用" />
                <el-switch v-model="model.scheduleEnabled" active-text="定时" />
              </article>
            </div>
          </el-tab-pane>
          <el-tab-pane label=".codex/config.toml">
            <el-input v-model="activeProvider.codexConfig" type="textarea" :rows="16" class="code-input" />
          </el-tab-pane>
          <el-tab-pane label=".claude/settings.json">
            <el-input v-model="activeProvider.claudeSettings" type="textarea" :rows="16" class="code-input" />
          </el-tab-pane>
        </el-tabs>

        <div class="drawer-actions">
          <el-button @click="providerDrawer = false">取消</el-button>
          <el-button type="primary" @click="saveProvider">保存</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="runDrawer" width="92vw" top="4vh" class="run-detail-dialog" title="检测详情">
      <template v-if="activeRun">
        <div class="run-summary">
          <el-tag :type="isHealthy(activeRun) ? 'success' : 'danger'">{{ stateLabel(activeRun.state) }}</el-tag>
          <span>{{ activeRun.providerName }}</span>
          <span class="mono">{{ activeRun.model }}</span>
          <span>{{ agentLabel(activeRun.agent) }}</span>
          <span>{{ activeRun.latencyMs }}ms</span>
        </div>
        <div class="detail-button-row">
          <el-button
            v-for="item in detailButtons"
            :key="item.key"
            :type="activeDetailTab === item.key ? 'primary' : 'default'"
            @click="activeDetailTab = item.key"
          >
            {{ item.label }}
          </el-button>
        </div>
        <div class="detail-meta-line">{{ detailMeta(detailContent(activeRun)) }}</div>
        <div v-if="isJsonTreeValue(detailContent(activeRun))" class="detail-json-tree">
          <JsonTree :data="detailDisplayValue(detailContent(activeRun))" />
        </div>
        <pre v-else class="detail-full-pre">{{ detailPreview(detailContent(activeRun)) }}</pre>
      </template>
    </el-dialog>
  </div>
</template>
