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

import { CodeBuddyAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_MODELS } from './adapter.js'
import type { CodeBuddyCatalogModel } from './adapter.js'
import { CredentialManager, findAuthFile } from './credentials.js'
import { OfficialCatalogReader } from './product-catalog.js'

export * from './adapter.js'
export * from './credentials.js'
export * from './product-catalog.js'
export * from './sse.js'

export const name = 'llm-codebuddy'
/**
 * The LLM registry is the hard dependency; `settings` is declared so Cordis
 * waits for the settings system to be ready before apply, and so the volatile
 * Config fields are projected into the native settings form (0.1.7
 * `SettingsForms.describe()`).
 */
export const inject = ['llm', 'settings']

const NS = 'llm-codebuddy'
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

/**
 * Plugin config. In dsh 0.1.7 the settings system projects only the fields
 * marked `.volatile()` into the editable form (`SettingsForms.describe()`),
 * so every user-tunable request parameter is volatile; `retryPolicy` stays
 * non-volatile (deployment-fixed, edited only in `settings.yaml`).
 */
export const Config = z.object({
  baseURL: z.string().default('').volatile(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS).volatile(),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
  models: z.array(catalogModel).default(DEFAULT_MODELS as unknown as Schemastery.TypeT<typeof catalogModel>[]).volatile(),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS).volatile(),
  retryPolicy: RetryPolicySchema,
}) as unknown as z<Config>

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
export function resolveAdapterOptions(config: Config) {
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
    // Empty/whitespace baseURL falls back to the public endpoint (an empty
    // string would otherwise yield a relative request path that fetch rejects).
    baseURL: typeof config.baseURL === 'string' && config.baseURL.trim().length > 0
      ? config.baseURL.trim()
      : PUBLIC_BASE_URL,
    maxTokens,
    defaultContextWindow,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'dsh-codebuddy-models: retryPolicy'),
  }
}

/** JSON-stable deep equality for two resolved retry-policy snapshots (plain JSON data). */
function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Unwrap `apply`'s raw config into a plain `Config`: in dsh 0.1.7 every
 * `.volatile()` field arrives as a cosmokit `Volatile<T>` object (schemastery
 * `Schema.resolve` wraps meta.volatile nodes), so each field must be read via
 * `.get()`. Identical to the official `plainOptions` / dsh-matrix-agent's
 * `plainMatrixConfig`; uses duck-typing to avoid a hard cosmokit dependency.
 * After a `loader/volatile-update` the config object's identity is stable and
 * the Volatile refs are updated in place, so re-running this yields the latest
 * values.
 */
function unwrapVolatile(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    const keys = Object.keys(value as object)
    if (keys.length <= 2 && keys.includes('get')) return (value as { get(): unknown }).get()
  }
  return value
}

function plainConfig(raw: Config): Config {
  const src = raw as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(src)) {
    out[key] = unwrapVolatile(src[key])
  }
  return out as unknown as Config
}

export function apply(ctx: Context, config: Config): void {
  // 0.1.7: volatile fields are `Volatile<T>` objects here; keep the raw
  // reference (its Volatile refs are updated in place on hot-edit) and unwrap
  // a plain snapshot for the adapter thunk. The plain snapshot is cached so the
  // `options()` memoization (`raw === lastRaw`) stays effective across calls;
  // `loader/volatile-update` refreshes the cache and re-resolves adapter facts.
  const rawConfig = config
  let plainCache: Config | undefined
  const current = (): Config => {
    if (plainCache === undefined) plainCache = plainConfig(rawConfig)
    return plainCache
  }
  const refresh = (): void => {
    plainCache = plainConfig(rawConfig)
  }
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
  let catalog: OfficialCatalogReader | undefined

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
    resolveCatalog: async () => {
      if (catalog === undefined) catalog = new OfficialCatalogReader()
      return (await catalog.read())?.models
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

  // Settings (0.1.7): user edits land through the native settings form, which
  // writes the `.volatile()` fields and emits `loader/volatile-update`. The
  // official model catalog is scanned from the local client's product.json by
  // the adapter (`resolveCatalog`) and is NOT persisted here — the volatile
  // fields only carry the hand-configured fallback catalog plus request
  // parameters. On hot-edit the `current` thunk re-reads `rawConfig` (its
  // Volatile refs were updated in place) so the adapter facts re-resolve.
  try {
    const onVolatile = (ctx.on as (event: string, cb: (paths: unknown) => void) => () => void)(
      'loader/volatile-update',
      () => {
        // Refresh the unwrapped snapshot so the adapter thunk re-reads the
        // latest volatile values, then re-check registration facts.
        refresh()
        ensureRegistrationFacts()
      },
    )
    ctx.effect(() => () => onVolatile())
  } catch (error) {
    ctx.logger.warn('[dsh-codebuddy-models] loader/volatile-update listener failed: %s', error instanceof Error ? error.message : String(error))
  }
}
