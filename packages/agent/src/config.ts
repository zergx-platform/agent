export function envOr(key: string, fallback: string): string {
  const v = process.env[key]
  return v !== undefined && v !== '' ? v : fallback
}

export function envList(key: string, fallback = ''): string[] {
  return envOr(key, fallback)
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

export interface ServerConfig {
  port: number
  postgresUrl: string
  natsUrl: string
  toolServers: string[]
  toolTimeoutMs: number
  /** Default LLM when no registered provider advertises the session model. */
  llmApiType: string
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  defaultMaxTurns: number
  defaultTemperature: number
  defaultMaxTokens: number
  memoryUrl: string
  repoManagerUrl: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const or = (k: string, d: string) => {
    const v = env[k]
    return v !== undefined && v !== '' ? v : d
  }

  const pgUrl = `postgres://${or('POSTGRES_USER', 'root')}:${or('POSTGRES_PASSWORD', 'devpassword')}@${or('POSTGRES_HOST', 'postgres.develop.svc.cluster.local')}:${or('POSTGRES_PORT', '5432')}/${or('POSTGRES_DB_AGENT', 'rucoder_agent')}`

  return {
    port: Number.parseInt(or('RUCODER_PORT', '8080'), 10),
    postgresUrl: pgUrl,
    natsUrl: or('NATS_URL', 'nats://nats.develop.svc.cluster.local:4222'),
    toolServers: envList('RUCODER_TOOL_SERVERS'),
    toolTimeoutMs:
      Number.parseInt(or('RUCODER_TOOL_TIMEOUT_SECS', '600'), 10) * 1000,
    llmApiType: or('RUCODER_LLM_API_TYPE', 'openai-compatible'),
    llmBaseUrl: or(
      'RUCODER_LLM_BASE_URL',
      'http://tal-openai-proxy.develop.svc.cluster.local:4000/v1',
    ),
    llmApiKey: or('RUCODER_LLM_API_KEY', ''),
    llmModel: or('RUCODER_LLM_MODEL', 'deepseek-v4-pro'),
    defaultMaxTurns: Number.parseInt(or('RUCODER_DEFAULT_MAX_TURNS', '25'), 10),
    defaultTemperature: Number.parseFloat(or('RUCODER_LLM_TEMPERATURE', '0')),
    defaultMaxTokens: Number.parseInt(
      or('RUCODER_LLM_MAX_TOKENS', '32768'),
      10,
    ),
    memoryUrl: or(
      'RUCODER_MEMORY_URL',
      'http://rucoder-memory-tools.develop.svc.cluster.local:80',
    ),
    repoManagerUrl: or(
      'RUCODER_REPO_MANAGER_URL',
      'http://rucoder-repo-manager.develop.svc.cluster.local:80',
    ),
  }
}
