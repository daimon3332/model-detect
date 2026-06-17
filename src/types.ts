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
  scheduleEnabled: boolean
  scheduleDays: number
  scheduleHours: number
  scheduleMinutes: number
  proxyPort: number
  logRetentionDays: number
  redactLogs: boolean
}

export interface CheckTarget {
  providerId?: string
  agent?: AgentType
  modelName?: string
}

export interface HttpExchange {
  method?: string
  url?: string
  targetUrl?: string
  headers: Record<string, string>
  body: unknown
}

export interface TestRun {
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
  stdout: string
  stderr: string
  errorMessage: string
  request: HttpExchange
  response: HttpExchange
  logDetail?: {
    client_headers: unknown
    client_body: unknown
    forward_url: string
    forward_headers: unknown
    forward_body: unknown
    provider_headers: unknown
    provider_body: unknown
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
  runs: TestRun[]
  settings: GlobalSettings
}
