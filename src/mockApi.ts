import type { AgentType, AppState, GlobalSettings, ProviderConfig, ProviderModel, RunState, TestRun } from './types'

const key = 'model-detect-state-v2'

const defaultSettings: GlobalSettings = {
  codexCommand: 'codex',
  claudeCommand: 'claude',
  dataDir: './data',
  prompt: 'Hello',
  scheduleEnabled: false,
  scheduleDays: 0,
  scheduleHours: 0,
  scheduleMinutes: 30,
  proxyPort: 7788,
  maxConcurrentChecks: 3,
  logRetentionDays: 30,
  redactLogs: true,
  defaultCodexConfig: '',
  defaultClaudeSettings: ''
}

const defaultCodexConfig = `model = "gpt-5.5"
model_provider = "provider"
approval_policy = "never"
sandbox_mode = "read-only"
model_instructions_file = "~/.codex/instruction.md"

[model_providers.provider]
name = "Provider"
base_url = "https://example.com/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
`

const defaultClaudeSettings = `{
  "env": {
    "ANTHROPIC_BASE_URL": "https://example.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_MODEL": ""
  }
}
`

export function loadState(): AppState {
  const raw = localStorage.getItem(key)
  if (!raw) return { providers: [], runs: [], settings: normalizeSettings() }

  try {
    const parsed = JSON.parse(raw) as AppState
    return {
      providers: parsed.providers ?? [],
      runs: parsed.runs ?? [],
      settings: normalizeSettings(parsed.settings)
    }
  } catch {
    return { providers: [], runs: [], settings: normalizeSettings() }
  }
}

function normalizeSettings(settings?: Partial<GlobalSettings>): GlobalSettings {
  const merged = { ...defaultSettings, ...(settings ?? {}) }
  if (settings && settings.scheduleDays === undefined && settings.scheduleHours === undefined) {
    const total = Math.max(0, Number(settings.scheduleMinutes ?? defaultSettings.scheduleMinutes))
    merged.scheduleDays = Math.floor(total / 1440)
    merged.scheduleHours = Math.floor((total % 1440) / 60)
    merged.scheduleMinutes = total % 60
  }
  merged.scheduleDays = Number(merged.scheduleDays || 0)
  merged.scheduleHours = Number(merged.scheduleHours || 0)
  merged.scheduleMinutes = Number(merged.scheduleMinutes || 0)
  merged.maxConcurrentChecks = Math.min(10, Math.max(1, Number(merged.maxConcurrentChecks || 3)))
  merged.defaultCodexConfig = String(merged.defaultCodexConfig || defaultCodexConfig)
  merged.defaultClaudeSettings = String(merged.defaultClaudeSettings || defaultClaudeSettings)
  return merged
}

export function persistState(state: AppState) {
  localStorage.setItem(key, JSON.stringify(state))
}

export function createProviderDraft(settings?: Partial<GlobalSettings>): ProviderConfig {
  return {
    id: createId(),
    name: '',
    enabled: true,
    baseUrl: '',
    apiKey: '',
    proxyUrl: '',
    codexEnabled: true,
    claudeEnabled: false,
    prompt: '',
    timeoutSeconds: 20,
    scheduleEnabled: false,
    saveBody: true,
    models: [],
    codexConfig: settings?.defaultCodexConfig || defaultCodexConfig,
    claudeSettings: settings?.defaultClaudeSettings || defaultClaudeSettings
  }
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function makeModels(text: string, agent: AgentType): ProviderModel[] {
  return text
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((name) => ({
      id: `${agent}:${name}`,
      name,
      agent,
      enabled: true,
      prompt: '',
      scheduleEnabled: true
    }))
}

export function modelsToText(provider: ProviderConfig, agent: AgentType) {
  return provider.models
    .filter((model) => model.agent === agent)
    .map((model) => model.name)
    .join('\n')
}

export function upsertProvider(state: AppState, provider: ProviderConfig) {
  const nextProvider = { ...provider, name: provider.name.trim() || '未命名提供商' }
  const index = state.providers.findIndex((item) => item.id === nextProvider.id)
  if (index >= 0) state.providers.splice(index, 1, nextProvider)
  else state.providers.unshift(nextProvider)
  persistState(state)
}

export function removeProvider(state: AppState, providerId: string) {
  state.providers = state.providers.filter((provider) => provider.id !== providerId)
  state.runs = state.runs.filter((run) => run.providerId !== providerId)
  persistState(state)
}

export function runProviderChecks(state: AppState, target: { providerId?: string; agent?: AgentType; modelName?: string } = {}) {
  const targets = state.providers
    .filter((provider) => provider.enabled && (!target.providerId || provider.id === target.providerId))
    .flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled)
        .filter((model) => !target.agent || model.agent === target.agent)
        .filter((model) => !target.modelName || model.name === target.modelName)
        .filter((model) => (model.agent === 'codex' ? provider.codexEnabled : provider.claudeEnabled))
        .map((model) => makeRun(state, provider, model))
    )

  state.runs = [...targets, ...state.runs].slice(0, 1000)
  persistState(state)
  return targets
}

export function recentRuns(state: AppState, providerId: string, model: string, agent: AgentType) {
  return state.runs
    .filter((run) => run.providerId === providerId && run.model === model && run.agent === agent)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10)
}

function makeRun(app: AppState, provider: ProviderConfig, model: ProviderModel): TestRun {
  const state = randomState()
  const ok = state === 'success' || state === 'warning'
  const httpStatus = state === 'timeout' ? null : ok ? 200 : Math.random() > 0.5 ? 429 : 500
  const errorMessage =
    state === 'timeout'
      ? 'CLI process timed out'
      : state === 'failed'
        ? httpStatus === 429
          ? 'rate_limit_exceeded'
          : 'upstream_error'
        : ''

  return {
    id: crypto.randomUUID(),
    providerId: provider.id,
    providerName: provider.name,
    model: model.name,
    agent: model.agent,
    state,
    httpStatus,
    cliExitCode: state === 'timeout' ? null : ok ? 0 : 1,
    latencyMs: state === 'timeout' ? provider.timeoutSeconds * 1000 : Math.round(800 + Math.random() * 4200),
    createdAt: new Date().toISOString(),
    prompt: model.prompt || provider.prompt || app.settings.prompt || 'Hello',
    stdout: ok ? 'hello' : '',
    stderr: state === 'warning' ? 'CLI returned non-fatal warning' : errorMessage,
    errorMessage,
    request: {
      headers: {
        authorization: provider.apiKey ? `Bearer ${provider.apiKey}` : '',
        'content-type': 'application/json',
        'user-agent': model.agent === 'codex' ? 'codex_exec' : 'claude-code'
      },
      body: {
        model: model.name,
        input: model.prompt || provider.prompt || app.settings.prompt || 'Hello'
      }
    },
    response: {
      headers: {
        'content-type': 'application/json',
        'x-request-id': crypto.randomUUID()
      },
      body: ok ? { output_text: 'hello' } : { error: { message: errorMessage } }
    }
  }
}

function randomState(): RunState {
  const value = Math.random()
  if (value < 0.06) return 'timeout'
  if (value < 0.16) return 'failed'
  if (value < 0.24) return 'warning'
  return 'success'
}
