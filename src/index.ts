/**
 * dsh-codebuddy-models — expose the locally-logged-in CodeBuddy / WorkBuddy
 * subscription as a native dsh provider route (`codebuddy`) in the model
 * picker.
 *
 * Enabling this bundle registers a configurable provider and an {@link
 * CodeBuddyAdapter} on `ctx.llm`. The adapter reads the desktop login from the
 * local auth file (never performing login, never storing a password), refreshes
 * the token against the CodeBuddy backend when it nears expiry, and streams
 * chat-completions from `copilot.tencent.com/v2/chat/completions`. The models
 * therefore appear in the GUI model selector and are callable like any other
 * provider. Disabling / removing the bundle withdraws the route and the models.
 *
 * export shape: named namespace plugin (name / inject / Config / apply), no
 * default export — the same shape as `@deepseek-ai/dsh-llm-deepseek`.
 *
 * @module dsh-codebuddy-models
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError, RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, settingsNamespace } from '@deepseek-ai/dsh-settings'

import { CodeBuddyAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_MODELS } from './adapter.js'
import type { CodeBuddyCatalogModel } from './adapter.js'
import { CredentialManager, EnterpriseModelDirectory, findAuthFile } from './credentials.js'

export * from './adapter.js'
export * from './credentials.js'
export * from './sse.js'

export const name = 'llm-codebuddy'
/** The LLM registry is the only hard dependency. */
export const inject = ['llm']

const NS = settingsNamespace('llm-codebuddy')
/** The single provider route this plugin owns. */
const PROVIDER = 'codebuddy'

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

/** Plugin config, also serving as the `llm-codebuddy` settings-section shape. */
export interface Config {
  /** Backend origin; `/v2/chat/completions` is appended. Defaults to the public CodeBuddy backend. */
  baseURL?: string
  /** Default per-request output cap (default 64000). */
  maxTokens?: number
  /** Context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers. */
  models?: CodeBuddyCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default 5 minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy. */
  retryPolicy?: import('@deepseek-ai/dsh-llm').RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS as unknown as Schemastery.TypeT<typeof catalogModel>[]),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** Public backend origin; the adapter appends `/v2/chat/completions`. */
export const PUBLIC_BASE_URL = 'https://copilot.tencent.com'

/** Validate and detach the advisory model catalog. */
function resolveModels(models: CodeBuddyCatalogModel[] | undefined): CodeBuddyCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('dsh-codebuddy-models: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`dsh-codebuddy-models: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`dsh-codebuddy-models: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`dsh-codebuddy-models: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (seen.has(model.id)) throw new Error(`dsh-codebuddy-models: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      ...(model.description !== undefined ? { description: model.description } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    }
  })
}

/** Resolve and validate raw config into connection facts (fail loud at load). */
function resolveAdapterOptions(config: Config) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error('dsh-codebuddy-models: streamIdleTimeoutMs must be a positive finite number')
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('dsh-codebuddy-models: maxTokens must be a positive safe integer')
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('dsh-codebuddy-models: defaultContextWindow must be a positive integer')
  }
  return {
    baseURL: config.baseURL ?? PUBLIC_BASE_URL,
    maxTokens,
    defaultContextWindow,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'dsh-codebuddy-models: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current = (): Config => config
  let lastRaw: Config | undefined
  let lastGood: ReturnType<typeof resolveAdapterOptions> | undefined
  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    const next = resolveAdapterOptions(raw)
    lastRaw = raw
    lastGood = next
    return next
  }
  options()

  const authFile = findAuthFile()
  if (authFile === undefined) {
    ctx.logger.warn(
      '[dsh-codebuddy-models] 未找到 CodeBuddy 登录文件；模型仍会在选择器中显示，但请求会失败，直到桌面端登录。' +
        '请在 CodeBuddy / WorkBuddy 桌面端完成登录。',
    )
  }
  let manager: CredentialManager | undefined = authFile === undefined ? undefined : new CredentialManager(authFile)
  let directory: EnterpriseModelDirectory | undefined = manager === undefined ? undefined : new EnterpriseModelDirectory(manager)

  const adapter = new CodeBuddyAdapter({
    options,
    resolveHeaders: async () => {
      if (manager === undefined) {
        const file = findAuthFile()
        if (file === undefined) {
          throw new LlmError(
            'dsh-codebuddy-models: 未找到 CodeBuddy 登录凭据。请在桌面端登录 CodeBuddy / WorkBuddy。',
            'MISSING_CREDENTIAL',
          )
        }
        manager = new CredentialManager(file)
      }
      return manager.getHeaders()
    },
    resolveDirectory: async () => {
      if (directory === undefined) {
        const file = findAuthFile()
        if (file === undefined) return undefined
        directory = new EnterpriseModelDirectory(new CredentialManager(file))
      }
      return directory.read()
    },
  })

  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'CodeBuddy',
      settingsNs: NS,
      settingsPath: [],
    },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  // Settings: register the `llm-codebuddy` namespace (live) and wire the
  // config source so edits re-resolve the adapter facts. The enterprise model
  // directory is NOT persisted here — it is fetched on demand by the adapter
  // (`listModels`) and read by the settings UI through the LLM model API, so
  // nothing runtime-derived is written to settings.yaml.
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings as {
      register(
        ns: string,
        schema: unknown,
        options?: { applies?: string; base?: unknown },
      ): {
        get(): unknown
        watch(cb: (next: unknown) => void): () => void
        update(patch: object): Promise<void>
      }
    }
    const scope = settings.register(NS, Config, { applies: 'live', base: config })
    const applyUser = (): void => {
      // `scope.get()` is the resolved value (base + defaults + user layer).
      current = () => scope.get() as Config
    }
    applyUser()
    const unsub = scope.watch(() => applyUser())
    ensureRegistrationFacts()
    sctx.effect(() => () => {
      unsub()
    })
  })
}
