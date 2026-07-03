export type AgentType = 'codex' | 'claude'
export type RunState = 'success' | 'warning' | 'failed' | 'timeout'

export interface ProviderModel {
  id: string
  name: string
  agent: AgentType
  enabled: boolean
  prompt?: string
  scheduleEnabled?: boolean
  lastRunAt?: string
  nextRunAt?: string
}

export interface ProviderConfig {
  id: string
  name: string
  enabled: boolean
  baseUrl: string
  apiKey: string
  proxyUrl: string
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

export interface GlobalSettings {
  codexCommand: string
  claudeCommand: string
  dataDir: string
  prompt: string
  codexPrompt: string
  claudePrompt: string
  scheduleEnabled: boolean
  scheduleDays: number
  scheduleHours: number
  scheduleMinutes: number
  proxyPort: number
  maxConcurrentChecks: number
  logRetentionDays: number
  redactLogs: boolean
  defaultCodexConfig: string
  defaultClaudeSettings: string
  codexInstruction: string
  adminPassword?: string
}

export interface CheckTarget {
  providerId?: string
  agent?: AgentType
  modelName?: string
}

export interface BackupData {
  version: number
  exportedAt: string
  state: {
    providers: ProviderConfig[]
    settings: GlobalSettings
  }
  runsIncluded?: boolean
  runs?: TestRun[]
}

export interface BackupImportJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  stage: string
  message: string
  total: number
  completed: number
  error: string
  createdAt: string
  updatedAt: string
  done: boolean
}

export interface CheckJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  target: CheckTarget
  total: number
  completed: number
  success: number
  failed: number
  currentProvider: string
  currentAgent: AgentType | ''
  currentModel: string
  stage: string
  message: string
  error: string
  runs: TestRunSummary[]
  items: CheckJobItem[]
  createdAt: string
  updatedAt: string
  done: boolean
}

export interface CheckJobItem {
  id: string
  providerId: string
  providerName: string
  agent: AgentType
  model: string
  status: 'queued' | 'running' | 'success' | 'failed' | 'timeout'
  httpStatus: number | null
  cliExitCode: number | null
  latencyMs: number
  errorMessage: string
  runId: string
}

export interface HttpExchange {
  method?: string
  url?: string
  targetUrl?: string
  headers: Record<string, string>
  body: unknown
}

export interface TestRunSummary {
  id: string
  providerId: string
  providerName: string
  model: string
  agent: AgentType
  state: RunState
  httpStatus: number | null
  cliExitCode: number | null
  latencyMs: number
  createdAt: string
  prompt: string
  errorMessage: string
}

export interface TestRun extends TestRunSummary {
  stdout: string
  stderr: string
  request: HttpExchange
  response: HttpExchange
  logDetail?: {
    client_headers?: unknown
    client_body?: unknown
    forward_url: string
    forward_headers?: unknown
    forward_body?: unknown
    provider_headers?: unknown
    provider_body?: unknown
  }
  exchanges?: Array<{
    statusCode: number
    durationMs: number
    client?: {
      method: string
      path: string
      headers: Record<string, string>
      body: unknown
    }
    forward?: {
      url: string
      headers: Record<string, string>
      body: unknown
    }
    provider?: {
      headers: Record<string, string>
      body: unknown
    }
    logDetail?: TestRun['logDetail']
    request: HttpExchange
    response: HttpExchange
  }>
}

export interface AppState {
  providers: ProviderConfig[]
  runs: TestRunSummary[]
  settings: GlobalSettings
}
