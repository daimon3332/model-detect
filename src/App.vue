<script setup lang="ts">
import { computed, defineComponent, h, onMounted, reactive, ref, watch } from 'vue'
import {
  ElButton,
  ElCard,
  ElCheckbox,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
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
  CircleCheckFilled,
  ArrowDown,
  Close,
  Connection,
  DataAnalysis,
  Delete,
  Document,
  EditPen,
  Files,
  Monitor,
  Menu,
  Refresh,
  Setting,
  Timer,
  User,
  WarningFilled,
  VideoPlay
} from '@element-plus/icons-vue'
import {
  createProviderDraft,
  makeModels,
  modelsToText,
  recentRuns,
} from './mockApi'
import {
  ApiError,
  cancelCheckApi,
  checkSessionApi,
  clearRunsApi,
  deleteProviderApi,
  exportBackupApi,
  getActiveCheckJobsApi,
  getBackupImportJobApi,
  getCheckJobApi,
  getRunApi,
  importBackupApi,
  loadShellState,
  loginApi,
  logoutApi,
  refreshState,
  resetProviderConfigApi,
  saveModelScheduleApi,
  saveProviderScheduleApi,
  saveProviderApi,
  saveScheduleSettingsApi,
  saveSettingsApi,
  updateCliApi,
  startChecksApi
} from './api'
import type { AgentType, AppState, BackupImportJob, CheckJob, CheckTarget, ProviderConfig, RunState, TestRun, TestRunSummary } from './types'
import { agentLabel, formatShortTime, formatTime, isHealthy, redact, runText, stateLabel } from './utils'

type PageKey = 'monitor' | 'providers' | 'prompts' | 'logs' | 'tasks' | 'settings'
type DetailTab = 'cli' | 'request_body' | 'response_body'

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
    const open = ref(true)
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
  { key: 'prompts', label: '提示词管理', icon: EditPen },
  { key: 'logs', label: '日志记录', icon: Document },
  { key: 'tasks', label: '定时任务', icon: Timer },
  { key: 'settings', label: '全局设置', icon: Setting }
]

const state = reactive<AppState>(loadShellState())
const page = ref<PageKey>('monitor')
const providerDrawer = ref(false)
const runDrawer = ref(false)
const activeProvider = ref<ProviderConfig | null>(null)
const activeRun = ref<TestRun | null>(null)
const activeDetailTab = ref<DetailTab>('cli')
const codexModelText = ref('')
const claudeModelText = ref('')
const selectedProviderId = ref('')
const checkingAuth = ref(true)
const authenticated = ref(false)
const loginPassword = ref('')
const loginLoading = ref(false)
const newAdminPassword = ref('')
const confirmAdminPassword = ref('')
const activeJobs = ref<CheckJob[]>([])
const startingCheckKeys = ref(new Set<string>())
const cancellingCheckKeys = ref(new Set<string>())
const pollingJobIds = new Set<string>()
const backupFileInput = ref<HTMLInputElement | null>(null)
const backupImportDialog = ref(false)
const backupImportJob = ref<BackupImportJob | null>(null)
const scheduleSaving = reactive<Record<string, boolean>>({})
const updateLoading = reactive<Record<string, boolean>>({ codex: false, claude: false })
const sidebarOpen = ref(false)
const settingsSaving = ref(false)
const refreshing = ref(false)

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

const pageMeta: Record<PageKey, { title: string; description: string }> = {
  monitor: { title: '模型监控', description: '查看模型可用性、响应状态和近期检测趋势' },
  providers: { title: '模型提供商', description: '管理接入地址、模型和运行参数' },
  prompts: { title: '提示词管理', description: '维护全局、提供商和模型级检测提示词' },
  logs: { title: '日志记录', description: '检索检测结果并查看完整请求与响应' },
  tasks: { title: '定时任务', description: '配置自动检测周期与执行范围' },
  settings: { title: '全局设置', description: '管理运行环境、默认配置、安全与备份' }
}

const currentPage = computed(() => pageMeta[page.value])
const totalModels = computed(() => state.providers.reduce((total, provider) => total + provider.models.length, 0))
const healthyRuns = computed(() => state.runs.filter(isHealthy).length)
const modelStates = computed(() => state.providers.flatMap((provider) => provider.models.map((model) => ({
  provider,
  model,
  run: recentRuns(state, provider.id, model.name, model.agent)[0]
}))))
const healthyModels = computed(() => modelStates.value.filter((item) => isHealthy(item.run)).length)
const abnormalModels = computed(() => modelStates.value.filter((item) => item.run && !isHealthy(item.run)).length)
const uncheckedModels = computed(() => modelStates.value.filter((item) => !item.run).length)
const normalModelRate = computed(() => totalModels.value ? Math.round((healthyModels.value / totalModels.value) * 100) : 0)
const timeoutRuns = computed(() => state.runs.filter((run) => run.state === 'timeout').length)
const failedRuns = computed(() => state.runs.filter((run) => run.state === 'failed').length)
const trendBuckets = computed(() => {
  const runs = [...latestLogs.value].slice(0, 24).reverse()
  if (!runs.length) return []
  const size = Math.max(1, Math.ceil(runs.length / 6))
  const buckets = Array.from({ length: Math.ceil(runs.length / size) }, (_, index) => {
    const items = runs.slice(index * size, (index + 1) * size)
    return {
      label: formatShortTime(items.at(-1)?.createdAt || ''),
      normal: items.filter(isHealthy).length,
      warning: items.filter((run) => run.state === 'warning' || run.state === 'timeout').length,
      failed: items.filter((run) => run.state === 'failed').length,
      total: items.length
    }
  })
  const max = Math.max(...buckets.map((bucket) => bucket.total), 1)
  return buckets.map((bucket) => ({ ...bucket, height: Math.max(12, Math.round((bucket.total / max) * 100)) }))
})

const visibleProviders = computed(() =>
  state.providers.filter((provider) => filters.providerId === 'all' || provider.id === filters.providerId)
)

const modelOptions = computed(() => {
  const names = visibleProviders.value.flatMap((provider) => provider.models.map((model) => model.name))
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const formatLatency = (ms: number | null | undefined) => {
  const value = Number(ms || 0)
  if (!value) return '-'
  const seconds = value / 1000
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()}s`
}

const jobPercent = (job: CheckJob) => {
  if (!job.total) return job.done ? 100 : 0
  return Math.round((job.completed / job.total) * 100)
}

const backupJobPercent = (job: BackupImportJob | null) => {
  if (!job) return 0
  if (!job.total) return job.done ? 100 : 0
  return Math.min(100, Math.round((job.completed / job.total) * 100))
}

const jobItemTagType = (status: string) => {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'running' || status === 'timeout') return 'warning'
  return 'info'
}

const jobStatusLabel = (status: string) => ({ queued: '等待中', running: '检测中', completed: '已完成', failed: '失败', cancelled: '已取消' }[status] || status)
const jobItemStatusLabel = (status: string) => ({ queued: '等待中', running: '检测中', success: '正常', failed: '异常', timeout: '超时', cancelled: '已取消' }[status] || status)
const stateTagType = (run?: TestRunSummary) => {
  if (!run) return 'info'
  if (run.state === 'success') return 'success'
  if (run.state === 'warning' || run.state === 'timeout') return 'warning'
  return 'danger'
}

const latestModelRun = (provider: ProviderConfig, model: ProviderConfig['models'][number]) =>
  recentRuns(state, provider.id, model.name, model.agent)[0]

const modelCheckKey = (providerId: string, agent: AgentType, modelName: string) => `${providerId}:${agent}:${modelName}`
const activeModelCheckKeys = computed(() => new Set(
  activeJobs.value
    .filter((job) => !job.done)
    .flatMap((job) => job.items.filter((item) => item.status === 'queued' || item.status === 'running').map((item) => item.id))
))
const isModelChecking = (providerId: string, agent: AgentType, modelName: string) => {
  const key = modelCheckKey(providerId, agent, modelName)
  return startingCheckKeys.value.has(key) || activeModelCheckKeys.value.has(key)
}
const modelCheckJob = (providerId: string, agent: AgentType, modelName: string) => {
  const key = modelCheckKey(providerId, agent, modelName)
  return activeJobs.value.find((job) =>
    !job.done && job.items.some((item) => item.id === key && (item.status === 'queued' || item.status === 'running'))
  )
}

const upsertJob = (job: CheckJob) => {
  const index = activeJobs.value.findIndex((item) => item.id === job.id)
  if (index >= 0) activeJobs.value.splice(index, 1, job)
  else activeJobs.value.unshift(job)
  activeJobs.value = activeJobs.value.slice(0, 6)
}

const syncActiveJobs = async () => {
  const jobs = await getActiveCheckJobsApi()
  jobs.forEach(upsertJob)
  jobs.forEach((job) => pollJob(job.id))
}

const handleApiError = (error: unknown, fallback: string) => {
  if (error instanceof ApiError && error.status === 401) {
    authenticated.value = false
    ElMessage.error('登录已过期，请重新输入管理员密码')
    return
  }
  let message = error instanceof Error ? error.message : fallback
  try {
    const parsed = JSON.parse(message) as { error?: string; message?: string }
    message = parsed.message || parsed.error || message
  } catch {}
  ElMessage.error(message || fallback)
}

const navigate = (target: PageKey) => {
  page.value = target
  sidebarOpen.value = false
}

const dismissJob = (jobId: string) => {
  activeJobs.value = activeJobs.value.filter((job) => job.id !== jobId)
}

const handleUserCommand = (command: string) => {
  if (command === 'logout') logout()
}

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
  activeProvider.value = createProviderDraft(state.settings)
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
  try {
    await saveProviderApi(state, draft)
    if (!selectedProviderId.value) selectedProviderId.value = draft.id
    providerDrawer.value = false
    ElMessage.success('已保存')
  } catch (error) {
    handleApiError(error, '保存提供商失败')
  }
}

const deleteProvider = async (provider: ProviderConfig) => {
  await ElMessageBox.confirm(`删除 ${provider.name}？对应检测记录也会移除。`, '确认删除', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消'
  })
  try {
    await deleteProviderApi(state, provider.id)
    if (selectedProviderId.value === provider.id) selectedProviderId.value = state.providers[0]?.id ?? ''
    ElMessage.success('已删除')
  } catch (error) {
    handleApiError(error, '删除提供商失败')
  }
}

const clearRunRecords = async (target: CheckTarget = {}, label = '全部检测记录') => {
  await ElMessageBox.confirm(`确认清空${label}？`, '清空检测记录', {
    type: 'warning',
    confirmButtonText: '清空',
    cancelButtonText: '取消'
  })
  try {
    await clearRunsApi(state, target)
    if (activeRun.value && !state.runs.some((run) => run.id === activeRun.value?.id)) {
      runDrawer.value = false
      activeRun.value = null
    }
    ElMessage.success('已清空')
  } catch (error) {
    handleApiError(error, '清空检测记录失败')
  }
}

const runChecks = async (providerId?: string, agent?: AgentType, modelName?: string) => {
  const key = providerId && agent && modelName ? modelCheckKey(providerId, agent, modelName) : ''
  if (key && isModelChecking(providerId!, agent!, modelName!)) {
    ElMessage.info('该模型正在检测，无需重复提交')
    return
  }
  if (key) startingCheckKeys.value = new Set(startingCheckKeys.value).add(key)
  try {
    const result = await startChecksApi({ providerId, agent, modelName })
    upsertJob(result.job)
    pollJob(result.job.id)
    if (result.reused) ElMessage.info('该模型正在检测，已显示现有任务')
    else ElMessage.success('检测任务已加入队列')
  } catch (error) {
    handleApiError(error, '创建检测任务失败')
  } finally {
    if (key) {
      const next = new Set(startingCheckKeys.value)
      next.delete(key)
      startingCheckKeys.value = next
    }
  }
}

const pollJob = async (jobId: string) => {
  if (pollingJobIds.has(jobId)) return
  pollingJobIds.add(jobId)
  try {
    let job = activeJobs.value.find((item) => item.id === jobId)
    let lastCompleted = job?.completed ?? 0
    while (job && !job.done) {
      await sleep(1000)
      job = await getCheckJobApi(state, jobId)
      upsertJob(job)
      if (job.completed > lastCompleted) {
        lastCompleted = job.completed
        await refreshState(state)
      }
    }
    if (job?.status === 'failed') {
      ElMessage.error(job.error || '检测任务失败')
    } else if (job?.status === 'cancelled') {
      await refreshState(state)
      ElMessage.info('检测已取消，未生成检测记录')
    } else {
      await refreshState(state)
      const count = job?.runs.length ?? 0
      ElMessage.success(count ? `已生成 ${count} 条检测记录` : '没有可检测的模型')
    }
  } catch (error) {
    handleApiError(error, '检测失败')
  } finally {
    pollingJobIds.delete(jobId)
  }
}

const cancelJob = async (job: CheckJob, target: CheckTarget = {}) => {
  const targetKeyValue = target.providerId && target.agent && target.modelName
    ? modelCheckKey(target.providerId, target.agent, target.modelName)
    : `job:${job.id}`
  if (cancellingCheckKeys.value.has(targetKeyValue)) return
  cancellingCheckKeys.value = new Set(cancellingCheckKeys.value).add(targetKeyValue)
  try {
    const result = await cancelCheckApi(job.id, target)
    upsertJob(result.job)
    if (result.cancelled) ElMessage.info('正在取消检测，本次结果不会写入记录')
    else ElMessage.info('检测任务已经结束')
  } catch (error) {
    handleApiError(error, '取消检测失败')
  } finally {
    const next = new Set(cancellingCheckKeys.value)
    next.delete(targetKeyValue)
    cancellingCheckKeys.value = next
  }
}

const cancelModelCheck = (providerId: string, agent: AgentType, modelName: string) => {
  const job = modelCheckJob(providerId, agent, modelName)
  if (job) return cancelJob(job, { providerId, agent, modelName })
}

const openRun = async (run: TestRunSummary) => {
  activeDetailTab.value = 'cli'
  try {
    activeRun.value = await getRunApi(run.id)
    runDrawer.value = true
  } catch (error) {
    handleApiError(error, '加载检测详情失败')
  }
}

const openRunProvider = (run: TestRunSummary) => {
  const provider = state.providers.find((item) => item.id === run.providerId)
  if (!provider) return
  page.value = 'providers'
  openEditProvider(provider)
}

const detailButtons: Array<{ key: DetailTab; label: string }> = [
  { key: 'cli', label: 'CLI 输入输出' },
  { key: 'request_body', label: '请求体' },
  { key: 'response_body', label: '响应体' }
]

const detailContent = (run: TestRun) => {
  const detail = run.logDetail
  const values = {
    cli: [
      `Prompt:\n${run.prompt || ''}`,
      `stdout:\n${run.stdout || ''}`,
      `stderr:\n${run.stderr || ''}`,
      `exit code:\n${run.cliExitCode ?? ''}`
    ].join('\n\n'),
    request_body: detail?.client_body ?? run.request.body,
    response_body: detail?.provider_body ?? run.response.body
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
  return JSON.stringify(safeValue, null, 2) ?? String(safeValue ?? '')
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

const copyText = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const input = document.createElement('textarea')
  input.value = text
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  document.execCommand('copy')
  document.body.removeChild(input)
}

const copyDetailContent = async () => {
  if (!activeRun.value) return
  try {
    await copyText(detailPreview(detailContent(activeRun.value)))
    ElMessage.success('已复制')
  } catch {
    ElMessage.error('复制失败')
  }
}

const setScheduleSaving = (key: string, value: boolean) => {
  scheduleSaving[key] = value
}

const isScheduleSaving = (key: string) => scheduleSaving[key] === true

const saveSettings = async () => {
  const extra: Record<string, string> = {}
  if (newAdminPassword.value || confirmAdminPassword.value) {
    if (!newAdminPassword.value.trim()) {
      ElMessage.error('管理员密码不能为空')
      return
    }
    if (newAdminPassword.value !== confirmAdminPassword.value) {
      ElMessage.error('两次输入的管理员密码不一致')
      return
    }
    extra.adminPassword = newAdminPassword.value
  }
  settingsSaving.value = true
  try {
    await saveSettingsApi(state, extra)
    newAdminPassword.value = ''
    confirmAdminPassword.value = ''
    ElMessage.success('已保存')
  } catch (error) {
    handleApiError(error, '保存设置失败')
  } finally {
    settingsSaving.value = false
  }
}

const updateCli = async (target: AgentType) => {
  updateLoading[target] = true
  try {
    const result = await updateCliApi(state, target)
    if (result?.ok) ElMessage.success(`${target === 'codex' ? 'Codex' : 'Claude Code'} 更新完成`)
    else ElMessage.error(result?.output || '更新失败')
  } catch (error) { handleApiError(error, '更新失败') }
  finally { updateLoading[target] = false }
}

const resetAllProviderConfig = async (target: AgentType) => {
  const label = target === 'codex' ? 'Codex config.toml' : 'Claude settings.json'
  try {
    await ElMessageBox.confirm(`确认将所有提供商的 ${label} 重置为当前已保存的全局默认配置？`, `重置所有 ${label}`, {
      type: 'warning',
      confirmButtonText: '重置',
      cancelButtonText: '取消'
    })
    await resetProviderConfigApi(state, { target })
    ElMessage.success(`已重置所有 ${label}`)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    handleApiError(error, `重置 ${label} 失败`)
  }
}

const resetActiveProviderConfigDraft = (target: AgentType) => {
  if (!activeProvider.value) return
  if (target === 'codex') activeProvider.value.codexConfig = state.settings.defaultCodexConfig
  else activeProvider.value.claudeSettings = state.settings.defaultClaudeSettings
  ElMessage.success('已替换为全局默认配置，点击保存后生效')
}

const saveTaskProvider = async (provider: ProviderConfig) => {
  try {
    await saveProviderApi(state, provider)
  } catch (error) {
    handleApiError(error, '保存失败')
  }
}

const saveScheduleSettings = async (rollback?: () => void) => {
  const key = 'global'
  setScheduleSaving(key, true)
  try {
    if (state.settings.scheduleDays + state.settings.scheduleHours + state.settings.scheduleMinutes <= 0) {
      state.settings.scheduleMinutes = 1
      ElMessage.warning('检测周期不能为 0，已调整为 1 分钟')
    }
    await saveScheduleSettingsApi(state, {
      scheduleEnabled: state.settings.scheduleEnabled,
      scheduleDays: state.settings.scheduleDays,
      scheduleHours: state.settings.scheduleHours,
      scheduleMinutes: state.settings.scheduleMinutes
    })
  } catch (error) {
    rollback?.()
    handleApiError(error, '保存定时任务失败')
  } finally {
    setScheduleSaving(key, false)
  }
}

const saveProviderSchedule = async (provider: ProviderConfig, value: boolean) => {
  const key = `provider:${provider.id}`
  setScheduleSaving(key, true)
  try {
    await saveProviderScheduleApi(state, provider.id, value)
  } catch (error) {
    provider.scheduleEnabled = !value
    handleApiError(error, '保存提供商定时任务失败')
  } finally {
    setScheduleSaving(key, false)
  }
}

const saveModelSchedule = async (provider: ProviderConfig, model: ProviderConfig['models'][number], value: boolean) => {
  const key = `model:${provider.id}:${model.agent}:${model.name}`
  setScheduleSaving(key, true)
  try {
    await saveModelScheduleApi(state, provider.id, model.agent, model.name, value)
  } catch (error) {
    model.scheduleEnabled = !value
    handleApiError(error, '保存模型定时任务失败')
  } finally {
    setScheduleSaving(key, false)
  }
}

const exportBackup = async () => {
  try {
    const backup = await exportBackupApi()
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `model-detect-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    link.click()
    URL.revokeObjectURL(link.href)
    ElMessage.success('已导出备份（不包含检测记录）')
  } catch (error) {
    handleApiError(error, '导出备份失败')
  }
}

const triggerBackupImport = () => {
  backupFileInput.value?.click()
}

const importBackupFile = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    await ElMessageBox.confirm('导入会覆盖当前提供商、提示词、定时任务和全局设置，并清空当前检测记录，确认继续？', '导入备份', {
      type: 'warning',
      confirmButtonText: '导入',
      cancelButtonText: '取消'
    })
    const backup = JSON.parse(await file.text())
    const job = await importBackupApi(state, backup)
    backupImportJob.value = job
    backupImportDialog.value = true
    pollBackupImportJob(job.id)
  } catch (error) {
    if (error === 'cancel') return
    handleApiError(error, '导入备份失败')
  }
}

const pollBackupImportJob = async (jobId: string) => {
  try {
    let job = backupImportJob.value
    while (job && !job.done) {
      await sleep(600)
      job = await getBackupImportJobApi(state, jobId)
      backupImportJob.value = job
    }
    if (job?.status === 'failed') {
      ElMessage.error(job.error || '导入备份失败')
      return
    }
    selectedProviderId.value = state.providers[0]?.id ?? ''
    ElMessage.success('已导入备份')
  } catch (error) {
    handleApiError(error, '导入备份失败')
  }
}

const manualRefresh = async () => {
  refreshing.value = true
  try {
    await Promise.all([refreshState(state), syncActiveJobs()])
  } catch (error) {
    handleApiError(error, '刷新失败')
  } finally {
    refreshing.value = false
  }
}

const navToProviders = () => {
  page.value = 'providers'
  openCreateProvider()
}

const login = async () => {
  if (!loginPassword.value) {
    ElMessage.error('请输入管理员密码')
    return
  }
  loginLoading.value = true
  try {
    await loginApi(loginPassword.value)
    authenticated.value = true
    loginPassword.value = ''
    await Promise.all([refreshState(state), syncActiveJobs()])
  } catch {
    ElMessage.error('密码错误')
  } finally {
    loginLoading.value = false
  }
}

const logout = async () => {
  await logoutApi().catch(() => undefined)
  authenticated.value = false
  loginPassword.value = ''
}

const boot = async () => {
  checkingAuth.value = true
  authenticated.value = await checkSessionApi()
  if (authenticated.value) await Promise.all([refreshState(state), syncActiveJobs()]).catch(() => undefined)
  checkingAuth.value = false
}

watch(
  () => [filters.providerId, filters.agent],
  () => {
    if (filters.model !== 'all' && !modelOptions.value.includes(filters.model)) filters.model = 'all'
  }
)

onMounted(boot)
</script>

<template>
  <div v-if="checkingAuth" class="auth-shell">
    <el-card shadow="never" class="auth-card">
      <div class="auth-brand">
        <span class="brand-mark">M</span>
        <strong>Model Detect</strong>
      </div>
      <p>正在检查管理员会话...</p>
    </el-card>
  </div>

  <div v-else-if="!authenticated" class="auth-shell">
    <el-card shadow="never" class="auth-card">
      <div class="auth-brand">
        <span class="brand-mark">M</span>
        <strong>Model Detect</strong>
      </div>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="管理员密码">
          <el-input
            v-model="loginPassword"
            type="password"
            show-password
            autofocus
            placeholder="默认密码：admin"
            @keyup.enter="login"
          />
        </el-form-item>
        <el-button type="primary" :loading="loginLoading" class="auth-submit" @click="login">进入</el-button>
      </el-form>
    </el-card>
  </div>

  <div v-else class="app-shell">
    <button v-if="sidebarOpen" class="sidebar-backdrop" aria-label="关闭导航" @click="sidebarOpen = false"></button>
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <div class="brand">
        <span class="brand-mark">M</span>
        <div>
          <strong>Model Detect</strong>
          <small>模型可用性平台</small>
        </div>
        <el-button class="sidebar-close" text circle :icon="Close" aria-label="关闭导航" @click="sidebarOpen = false" />
      </div>
      <nav class="nav-tabs" aria-label="主导航">
        <button
          v-for="item in pages"
          :key="item.key"
          class="nav-item"
          :class="{ active: page === item.key }"
          @click="navigate(item.key)"
        >
          <component :is="item.icon" />
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <span class="status-dot"></span>
        <div>
          <strong>服务已连接</strong>
          <small>{{ activeProviders.length }} 个提供商已启用</small>
        </div>
      </div>
    </aside>

    <div class="app-main">
      <header class="topbar">
        <div class="page-heading">
          <el-button class="menu-button" text circle :icon="Menu" aria-label="打开导航" @click="sidebarOpen = true" />
          <div>
            <h1>{{ currentPage.title }}</h1>
            <p>{{ currentPage.description }}</p>
          </div>
        </div>
        <div class="top-actions">
          <el-button :icon="Refresh" :loading="refreshing" @click="manualRefresh">刷新</el-button>
          <el-button :icon="CirclePlus" type="primary" aria-label="添加提供商" title="添加提供商" @click="openCreateProvider">添加提供商</el-button>
          <el-dropdown trigger="click" @command="handleUserCommand">
            <button class="user-menu">
              <span class="user-avatar"><User /></span>
              <span>管理员</span>
              <ArrowDown />
            </button>
            <template #dropdown>
              <el-dropdown-menu><el-dropdown-item command="logout">退出登录</el-dropdown-item></el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="workspace">
      <section v-if="page === 'monitor'" class="page-grid">
        <div class="metric-grid">
          <article class="metric-card">
            <span class="metric-icon info"><Connection /></span>
            <div><small>提供商</small><strong>{{ state.providers.length }}</strong><p>已启用 {{ activeProviders.length }} 个</p></div>
          </article>
          <article class="metric-card">
            <span class="metric-icon info"><DataAnalysis /></span>
            <div><small>已配置模型</small><strong>{{ totalModels }}</strong><p>共 {{ totalModels }} 个模型</p></div>
          </article>
          <article class="metric-card">
            <span class="metric-icon success"><CircleCheckFilled /></span>
            <div><small>正常模型</small><strong>{{ healthyModels }}</strong><p>{{ normalModelRate }}% 占比</p></div>
          </article>
          <article class="metric-card">
            <span class="metric-icon danger"><WarningFilled /></span>
            <div><small>异常模型</small><strong>{{ abnormalModels }}</strong><p>{{ totalModels ? Math.round((abnormalModels / totalModels) * 100) : 0 }}% 占比</p></div>
          </article>
        </div>

        <div class="overview-grid">
          <section class="surface-panel trend-panel">
            <div class="panel-heading">
              <div><strong>近期检测趋势</strong></div>
              <span class="trend-range">最近 24 次检测</span>
            </div>
            <div class="trend-legend"><span class="normal">正常</span><span class="warning">超时或警告</span><span class="failed">异常</span></div>
            <div v-if="trendBuckets.length" class="trend-chart">
              <div class="chart-grid"><i></i><i></i><i></i></div>
              <div v-for="(bucket, index) in trendBuckets" :key="`${bucket.label}-${index}`" class="trend-column">
                <div class="trend-stack" :style="{ height: `${bucket.height}%` }" :title="`正常 ${bucket.normal}，超时或警告 ${bucket.warning}，异常 ${bucket.failed}`">
                  <span v-if="bucket.failed" class="failed" :style="{ flex: bucket.failed }"></span>
                  <span v-if="bucket.warning" class="warning" :style="{ flex: bucket.warning }"></span>
                  <span v-if="bucket.normal" class="normal" :style="{ flex: bucket.normal }"></span>
                </div>
                <small>{{ bucket.label }}</small>
              </div>
            </div>
            <el-empty v-else :image-size="54" description="暂无趋势数据" />
            <div v-if="latestLogs.length" class="last-check">最后检测：{{ formatTime(latestLogs[0].createdAt) }}</div>
          </section>
          <section class="surface-panel activity-panel">
            <div class="panel-heading"><div><strong>运行概览</strong></div></div>
            <dl class="summary-list">
              <div><dt>检测总数</dt><dd class="info-text">{{ state.runs.length }}</dd></div>
              <div><dt>正常</dt><dd class="success-text">{{ healthyRuns }}</dd></div>
              <div><dt>超时</dt><dd class="warning-text">{{ timeoutRuns }}</dd></div>
              <div><dt>异常</dt><dd class="danger-text">{{ failedRuns }}</dd></div>
              <div><dt>未检测模型</dt><dd>{{ uncheckedModels }}</dd></div>
              <div><dt>定时检测</dt><dd><el-tag size="small" :type="state.settings.scheduleEnabled ? 'success' : 'info'">{{ state.settings.scheduleEnabled ? '已启用' : '未启用' }}</el-tag></dd></div>
            </dl>
          </section>
        </div>

        <el-card shadow="never" class="surface-card model-workspace">
          <div class="section-head model-section-head">
            <div><strong>模型状态</strong></div>
            <div class="head-actions">
              <el-select v-model="filters.providerId" class="control" placeholder="提供商">
                <el-option label="全部提供商" value="all" />
                <el-option v-for="provider in state.providers" :key="provider.id" :label="provider.name" :value="provider.id" />
              </el-select>
              <el-select v-model="filters.agent" class="control" placeholder="客户端">
                <el-option label="全部客户端" value="all" />
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
              <el-button :icon="Delete" type="danger" text :disabled="!state.runs.length" @click="clearRunRecords()">
                清空记录
              </el-button>
            </div>
          </div>

          <div v-if="activeJobs.length" class="job-board">
            <article v-for="job in activeJobs" :key="job.id" class="job-card" :class="job.status">
              <div class="job-card-head">
                <strong>{{ job.message || '检测任务' }}</strong>
                <div class="job-card-actions">
                  <el-tag :type="job.status === 'failed' ? 'danger' : job.status === 'cancelled' ? 'info' : job.done ? 'success' : 'warning'">{{ jobStatusLabel(job.status) }}</el-tag>
                  <el-button
                    v-if="!job.done"
                    size="small"
                    type="danger"
                    plain
                    :loading="cancellingCheckKeys.has(`job:${job.id}`)"
                    @click="cancelJob(job)"
                  >取消任务</el-button>
                  <el-button v-if="job.done" text circle :icon="Close" aria-label="关闭任务" @click="dismissJob(job.id)" />
                </div>
              </div>
              <div class="progress-bar">
                <span :style="{ width: `${jobPercent(job)}%` }"></span>
              </div>
              <div class="job-meta">
                <span>{{ job.completed }} / {{ job.total }}</span>
                <span>成功 {{ job.success }}</span>
                <span>失败 {{ job.failed }}</span>
                <span v-if="job.cancelled">取消 {{ job.cancelled }}</span>
                <span>{{ job.currentProvider || '-' }}</span>
                <span>{{ job.currentAgent ? agentLabel(job.currentAgent as AgentType) : '-' }} / <b class="mono">{{ job.currentModel || '-' }}</b></span>
              </div>
              <div v-if="job.items?.length" class="job-item-list">
                <div v-for="item in job.items" :key="item.id" class="job-item-row">
                  <el-tag size="small" :type="jobItemTagType(item.status)" effect="plain">{{ jobItemStatusLabel(item.status) }}</el-tag>
                  <span>{{ item.providerName }}</span>
                  <span>{{ agentLabel(item.agent) }}</span>
                  <span class="mono">{{ item.model }}</span>
                  <span>{{ item.httpStatus ?? '-' }}</span>
                  <span>{{ formatLatency(item.latencyMs) }}</span>
                  <span class="job-item-error">{{ item.errorMessage || '-' }}</span>
                </div>
              </div>
              <pre v-if="job.error" class="progress-error">{{ job.error }}</pre>
            </article>
          </div>

          <el-empty v-if="!state.providers.length" description="暂无模型提供商">
            <el-button type="primary" :icon="CirclePlus" @click="navToProviders">添加模型提供商</el-button>
          </el-empty>

          <div v-else class="provider-groups">
            <section v-for="provider in visibleProviders" :key="provider.id" class="provider-group">
              <div class="provider-title">
                <div class="provider-identity">
                  <button @click.stop.prevent="openEditProvider(provider)">{{ provider.name }}</button>
                  <el-tag size="small" :type="provider.enabled ? 'success' : 'info'">{{ provider.enabled ? '已启用' : '已停用' }}</el-tag>
                </div>
                <span class="provider-endpoint" :title="provider.baseUrl || '未配置接口地址'">接口地址：<b class="mono">{{ provider.baseUrl || '未配置' }}</b></span>
                <div class="provider-capabilities">
                  <span>支持客户端：</span>
                  <el-tag v-if="provider.codexEnabled" effect="plain">Codex</el-tag>
                  <el-tag v-if="provider.claudeEnabled" effect="plain" type="success">Claude Code</el-tag>
                  <span>模型数：{{ provider.models.length }}</span>
                </div>
              </div>

              <div v-if="providerModels(provider).length" class="monitor-table">
                <div class="table-head">
                  <span>模型名称</span>
                  <span>客户端</span>
                  <span>检测状态</span>
                  <span>最后检测</span>
                  <span>响应结果与近期记录</span>
                  <span>操作</span>
                </div>
                <div v-for="model in providerModels(provider)" :key="model.id" class="table-row">
                  <strong class="mono model-name">{{ model.name }}</strong>
                  <el-tag effect="plain" :type="model.agent === 'claude' ? 'success' : 'primary'">{{ agentLabel(model.agent) }}</el-tag>
                  <el-tag effect="plain" :type="isModelChecking(provider.id, model.agent, model.name) ? 'warning' : stateTagType(latestModelRun(provider, model))">
                    {{ isModelChecking(provider.id, model.agent, model.name) ? '检测中' : latestModelRun(provider, model) ? stateLabel(latestModelRun(provider, model)!.state) : '未检测' }}
                  </el-tag>
                  <span class="last-run-time">{{ latestModelRun(provider, model) ? formatTime(latestModelRun(provider, model)!.createdAt) : '-' }}</span>
                  <div class="result-cell">
                    <span v-if="latestModelRun(provider, model)" class="result-summary">
                      <el-tag size="small" effect="plain" :type="stateTagType(latestModelRun(provider, model))">{{ runText(latestModelRun(provider, model)) }}</el-tag>
                      <span :title="latestModelRun(provider, model)?.errorMessage || ''">{{ latestModelRun(provider, model)?.errorMessage || stateLabel(latestModelRun(provider, model)!.state) }}</span>
                    </span>
                    <span v-else class="muted">暂无结果</span>
                    <span v-if="recentRuns(state, provider.id, model.name, model.agent).length" class="recent-status-dots">
                      <button
                        v-for="run in recentRuns(state, provider.id, model.name, model.agent)"
                        :key="run.id"
                        :class="run.state"
                        :title="`${formatTime(run.createdAt)} / ${stateLabel(run.state)}`"
                        @click="openRun(run)"
                      ></button>
                    </span>
                  </div>
                  <div class="row-actions">
                    <el-button
                      v-if="isModelChecking(provider.id, model.agent, model.name)"
                      size="small"
                      type="danger"
                      plain
                      :icon="Close"
                      :loading="cancellingCheckKeys.has(modelCheckKey(provider.id, model.agent, model.name))"
                      @click="cancelModelCheck(provider.id, model.agent, model.name)"
                    >取消</el-button>
                    <el-button v-else size="small" :icon="VideoPlay" @click="runChecks(provider.id, model.agent, model.name)">检测</el-button>
                    <el-button v-if="latestModelRun(provider, model)" size="small" @click="openRun(latestModelRun(provider, model)!)">详情</el-button>
                    <el-button
                      size="small"
                      type="danger"
                      text
                      :disabled="!recentRuns(state, provider.id, model.name, model.agent).length"
                      @click="clearRunRecords(
                        { providerId: provider.id, agent: model.agent, modelName: model.name },
                        `${provider.name} / ${agentLabel(model.agent)} / ${model.name} 的检测记录`
                      )"
                    >
                      清空
                    </el-button>
                  </div>
                </div>
              </div>
              <el-empty v-else description="该提供商暂无可显示模型" />
            </section>
          </div>
        </el-card>
      </section>

      <section v-if="page === 'providers'" class="page-grid">
        <el-card shadow="never" class="surface-card">
          <div class="section-head">
            <div><strong>提供商列表</strong><span>配置模型接入和运行能力</span></div>
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
                  <span>超时 <b>{{ provider.timeoutSeconds }} 秒</b></span>
                  <span>定时任务 <b>{{ provider.scheduleEnabled ? '已启用' : '未启用' }}</b></span>
                  <span>代理 <b>{{ provider.proxyUrl || '未配置' }}</b></span>
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
        <el-card shadow="never" class="surface-card prompt-card">
          <div class="section-head"><div><strong>检测提示词</strong><span>下级留空时自动继承上级配置</span></div></div>
          <div class="prompt-global">
            <el-form label-position="top">
              <el-form-item label="Codex 全局 Prompt">
                <el-input v-model="state.settings.codexPrompt" type="textarea" :rows="3" placeholder="Hello" />
              </el-form-item>
              <el-form-item label="Claude Code 全局 Prompt">
                <el-input v-model="state.settings.claudePrompt" type="textarea" :rows="3" placeholder="Reply exactly: ok" />
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
        <el-card shadow="never" class="surface-card">
          <div class="section-head">
            <div><strong>检测日志</strong><span>共 {{ latestLogs.length }} 条记录</span></div>
            <div class="head-actions">
            <el-button :icon="Refresh" :loading="refreshing" @click="manualRefresh">刷新</el-button>
            <el-button :icon="Delete" type="danger" plain :disabled="!state.runs.length" @click="clearRunRecords()">
              清空全部记录
            </el-button>
            </div>
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
              <span>{{ formatLatency(run.latencyMs) }}</span>
              <el-button size="small" @click="openRun(run)">详情</el-button>
            </div>
          </div>
        </el-card>
      </section>

      <section v-if="page === 'tasks'" class="page-grid">
        <el-card shadow="never" class="surface-card">
          <div class="section-head"><div><strong>自动检测计划</strong><span>全局、提供商和模型三级开关共同决定执行范围</span></div></div>
          <div class="task-global">
            <el-switch
              v-model="state.settings.scheduleEnabled"
              active-text="总定时任务"
              :loading="isScheduleSaving('global')"
              @change="(value) => saveScheduleSettings(() => { state.settings.scheduleEnabled = !Boolean(value) })"
            />
            <el-input-number v-model="state.settings.scheduleDays" :min="0" :max="365" @change="() => saveScheduleSettings()" />
            <span>天</span>
            <el-input-number v-model="state.settings.scheduleHours" :min="0" :max="23" @change="() => saveScheduleSettings()" />
            <span>小时</span>
            <el-input-number v-model="state.settings.scheduleMinutes" :min="0" :max="59" @change="() => saveScheduleSettings()" />
            <span>分钟</span>
          </div>
          <el-empty v-if="!state.providers.length" description="暂无模型提供商" />
          <div v-else class="task-grid">
            <article v-for="provider in state.providers" :key="provider.id" class="task-card">
              <div class="task-provider-head">
                <strong>{{ provider.name }}</strong>
                <el-switch
                  v-model="provider.scheduleEnabled"
                  active-text="提供商"
                  :loading="isScheduleSaving(`provider:${provider.id}`)"
                  @change="(value) => saveProviderSchedule(provider, Boolean(value))"
                />
              </div>
              <div class="task-models">
                <label v-for="model in provider.models" :key="model.id" class="task-model-row">
                  <span class="mono">{{ model.name }}</span>
                  <el-tag effect="plain" round>{{ agentLabel(model.agent) }}</el-tag>
                  <el-switch
                    v-model="model.scheduleEnabled"
                    :loading="isScheduleSaving(`model:${provider.id}:${model.agent}:${model.name}`)"
                    @change="(value) => saveModelSchedule(provider, model, Boolean(value))"
                  />
                </label>
              </div>
            </article>
          </div>
        </el-card>
      </section>

      <section v-if="page === 'settings'" class="page-grid">
        <el-card shadow="never" class="surface-card settings-card">
          <div class="section-head settings-toolbar">
            <div><strong>系统配置</strong><span>修改后统一保存，更新和备份操作即时执行</span></div>
            <div class="head-actions">
            <el-button @click="exportBackup">导出备份</el-button>
            <el-button @click="triggerBackupImport">导入备份</el-button>
            <el-button type="primary" :loading="settingsSaving" @click="saveSettings">保存设置</el-button>
            </div>
            <input ref="backupFileInput" type="file" accept="application/json" class="hidden-file-input" @change="importBackupFile" />
          </div>
          <el-form label-position="top" class="settings-form">
            <section class="settings-section">
              <div class="settings-section-head"><strong>运行参数</strong><span>CLI 路径、数据存储和检测资源限制</span></div>
              <div class="settings-grid">
                <el-form-item label="Codex 命令"><el-input v-model="state.settings.codexCommand" /></el-form-item>
                <el-form-item label="Claude Code 命令"><el-input v-model="state.settings.claudeCommand" /></el-form-item>
                <el-form-item label="数据目录"><el-input v-model="state.settings.dataDir" /></el-form-item>
                <el-form-item label="日志保留天数"><el-input-number v-model="state.settings.logRetentionDays" :min="1" :max="365" /></el-form-item>
                <el-form-item label="默认检测超时（秒）"><el-input-number v-model="state.settings.defaultTimeoutSeconds" :min="5" :max="600" /></el-form-item>
                <el-form-item label="最大并发检测数"><el-input-number v-model="state.settings.maxConcurrentChecks" :min="1" :max="3" /></el-form-item>
                <el-form-item label="日志脱敏"><el-switch v-model="state.settings.redactLogs" active-text="启用" /></el-form-item>
              </div>
            </section>

            <section class="settings-section">
              <div class="settings-section-head"><strong>CLI 更新</strong><span>定期从 npm 官方源获取最新版本</span></div>
              <div class="update-row">
                <el-switch v-model="state.settings.autoUpdateEnabled" active-text="自动更新" />
                <el-input-number v-model="state.settings.autoUpdateIntervalDays" :min="1" :max="365" />
                <span class="field-suffix">天一次</span>
                <el-button :loading="updateLoading.codex" @click="updateCli('codex')">更新 Codex</el-button>
                <el-button :loading="updateLoading.claude" @click="updateCli('claude')">更新 Claude Code</el-button>
              </div>
              <div class="update-status-grid">
                <span>Codex 最近更新：<b>{{ state.settings.codexLastUpdateAt ? formatTime(state.settings.codexLastUpdateAt) : '暂无记录' }}</b></span>
                <span>Claude Code 最近更新：<b>{{ state.settings.claudeLastUpdateAt ? formatTime(state.settings.claudeLastUpdateAt) : '暂无记录' }}</b></span>
              </div>
            </section>

            <section class="settings-section">
              <div class="settings-section-head config-heading">
                <div><strong>默认配置</strong><span>新建提供商时使用的初始 CLI 配置</span></div>
                <div class="head-actions">
                  <el-button @click="resetAllProviderConfig('codex')">应用 Codex 默认配置到全部</el-button>
                  <el-button @click="resetAllProviderConfig('claude')">应用 Claude 默认配置到全部</el-button>
                </div>
              </div>
              <el-form-item label="Codex 默认 config.toml"><el-input v-model="state.settings.defaultCodexConfig" type="textarea" :rows="14" class="code-input" /></el-form-item>
              <el-form-item label="Codex instruction.md"><el-input v-model="state.settings.codexInstruction" type="textarea" :rows="5" class="code-input" /></el-form-item>
              <el-form-item label="Claude Code 默认 settings.json"><el-input v-model="state.settings.defaultClaudeSettings" type="textarea" :rows="12" class="code-input" /></el-form-item>
            </section>

            <section class="settings-section">
              <div class="settings-section-head"><strong>管理员安全</strong><span>留空表示保持当前密码</span></div>
              <div class="settings-grid">
                <el-form-item label="新管理员密码"><el-input v-model="newAdminPassword" type="password" show-password placeholder="输入新密码" /></el-form-item>
                <el-form-item label="确认管理员密码"><el-input v-model="confirmAdminPassword" type="password" show-password placeholder="再次输入新密码" /></el-form-item>
              </div>
            </section>
          </el-form>
        </el-card>
      </section>
      </main>
    </div>

    <el-dialog v-model="backupImportDialog" width="520px" title="导入备份进度" :close-on-click-modal="backupImportJob?.done === true">
      <div v-if="backupImportJob" class="backup-import-panel">
        <div class="job-card-head">
          <strong>{{ backupImportJob.message }}</strong>
          <el-tag :type="backupImportJob.status === 'failed' ? 'danger' : backupImportJob.done ? 'success' : 'primary'">
            {{ backupImportJob.status }}
          </el-tag>
        </div>
        <div class="progress-bar">
          <span :style="{ width: `${backupJobPercent(backupImportJob)}%` }"></span>
        </div>
        <div class="job-meta">
          <span>{{ backupImportJob.completed }} / {{ backupImportJob.total }}</span>
          <span>{{ backupImportJob.stage }}</span>
        </div>
        <pre v-if="backupImportJob.error" class="progress-error">{{ backupImportJob.error }}</pre>
      </div>
      <template #footer>
        <el-button :disabled="!backupImportJob?.done" type="primary" @click="backupImportDialog = false">完成</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="providerDrawer" width="860px" top="5vh" class="provider-config-dialog" title="模型提供商配置">
      <el-form v-if="activeProvider" label-position="top" class="provider-form">
        <div class="form-grid">
          <el-form-item label="名称">
            <el-input v-model="activeProvider.name" placeholder="例如 DeepSeek / 鲨鱼辣椒" />
          </el-form-item>
          <el-form-item label="Base URL">
            <el-input v-model="activeProvider.baseUrl" placeholder="https://example.com 或 https://example.com/v1，不要填完整 endpoint" />
          </el-form-item>
          <el-form-item label="API Key">
            <el-input v-model="activeProvider.apiKey" show-password placeholder="sk-..." />
          </el-form-item>
          <el-form-item label="代理连接地址">
            <el-input v-model="activeProvider.proxyUrl" placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7890，留空直连" />
          </el-form-item>
          <el-form-item label="CLI / 上游请求超时（秒）">
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
            <div class="model-config-toolbar">
              <el-button @click="resetActiveProviderConfigDraft('codex')">重置 Codex config.toml</el-button>
            </div>
            <el-input v-model="activeProvider.codexConfig" type="textarea" :rows="16" class="code-input" />
          </el-tab-pane>
          <el-tab-pane label=".claude/settings.json">
            <div class="model-config-toolbar">
              <el-button @click="resetActiveProviderConfigDraft('claude')">重置 Claude settings.json</el-button>
            </div>
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
          <span>{{ formatLatency(activeRun.latencyMs) }}</span>
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
        <div class="detail-meta-line">
          <span>{{ detailMeta(detailContent(activeRun)) }}</span>
          <el-button size="small" @click="copyDetailContent">复制当前内容</el-button>
        </div>
        <div v-if="isJsonTreeValue(detailContent(activeRun))" class="detail-json-tree">
          <JsonTree :data="detailDisplayValue(detailContent(activeRun))" />
        </div>
        <pre v-else class="detail-full-pre">{{ detailPreview(detailContent(activeRun)) }}</pre>
      </template>
    </el-dialog>
  </div>
</template>
