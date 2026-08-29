/**
 * CodeBuddy LLM adapter for the dsh `ctx.llm` seam.
 *
 * A direct-fetch adapter, shaped like `@deepseek-ai/dsh-llm-deepseek`, that
 * streams chat-completions against the CodeBuddy backend. Connection facts
 * (endpoint, model catalog, output caps) arrive through a thunk resolved once
 * per operation; the bearer token / user identity headers arrive through the
 * credential manager, so a changed login or refreshed token reaches the very
 * next request. The backend is a standard OpenAI chat-completions endpoint, so
 * the adapter serializes harness messages to the wire, POSTs with
 * `stream: true`, and maps the SSE back through {@link translate}.
 *
 * @module dsh-codebuddy-models/adapter
 */

import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm'
import type { CodeBuddyAuthHeaders } from './credentials.js'
import {
  ENTERPRISE_QUOTA_MESSAGE,
  MODEL_NOT_ALLOWED_MESSAGE,
  classifyCode,
  parseSse,
  translate,
} from './sse.js'

/** One optional model entry advertised by the adapter. */
export interface CodeBuddyCatalogModel {
  /** Wire model id accepted by the backend. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail. */
  description?: string
  /** Combined request/response context capacity in tokens. */
  contextWindow?: number
  /** Per-request output cap. */
  maxTokens?: number
}

/** Validated connection facts for one operation. */
export interface CodeBuddyConnectionOptions {
  /** Backend origin; `/v2/chat/completions` is appended. */
  baseURL: string
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers. */
  models: readonly CodeBuddyCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Operation-local resolution hooks the registering plugin owns. */
export interface CodeBuddyAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => CodeBuddyConnectionOptions
  /** Resolve the authenticated backend headers (token + account identity). */
  resolveHeaders: () => Promise<CodeBuddyAuthHeaders>
  /**
   * Resolve the enterprise builtin-models directory, or `undefined` when
   * unavailable (no login, non-enterprise account, or a fetch failure). The
   * adapter prefers this live catalog and falls back to the static default.
   */
  resolveDirectory?: () => Promise<readonly import('./credentials.js').CodeBuddyEnterpriseModel[] | undefined>
}

/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** Default per-request output cap. */
export const DEFAULT_MAX_TOKENS = 64_000
/** Default idle watchdog while a stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Adapter-owned reasoning effort ids. */
export const OFF_REASONING_EFFORT = ReasoningEffortId('off')
export const LOW_REASONING_EFFORT = ReasoningEffortId('low')
export const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
export const MAX_REASONING_EFFORT = ReasoningEffortId('max')
/** Selectable reasoning efforts for CodeBuddy models (the backend streams reasoning). */
const REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
  { id: LOW_REASONING_EFFORT, name: 'Low' },
  { id: HIGH_REASONING_EFFORT, name: 'High' },
  { id: MAX_REASONING_EFFORT, name: 'Max' },
]
/** Reasoning capability advertised on every CodeBuddy model. */
const REASONING: LlmModelReasoningInfo = {
  efforts: REASONING_EFFORTS,
  defaultEffort: HIGH_REASONING_EFFORT,
}

/** The default CodeBuddy model catalog (mirrors the desktop client list). */
export const DEFAULT_MODELS: readonly CodeBuddyCatalogModel[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'auto', name: 'Auto', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'minimax-m3-pay', name: 'MiniMax-M3-Pay', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'hy3-preview-agent', name: 'Hunyuan-Preview-Agent', contextWindow: DEFAULT_CONTEXT_WINDOW },
]

/** Map a wire message's content blocks into OpenAI wire messages. */
function flattenText(blocks: GenerateOptions['messages'][number]['content']): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Reject image content: the CodeBuddy chat route is text-only today. */
function assertTextOnly(blocks: GenerateOptions['messages'][number]['content']): void {
  if (blocks.some((block) => block.type === 'image')) {
    throw new LlmError('The CodeBuddy adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Serialize one assistant message (text + tool calls). */
function serializeAssistant(message: GenerateOptions['messages'][number]): Record<string, unknown> {
  const text = flattenText(message.content)
  const toolCalls = message.content
    .filter((block) => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))
  const out: Record<string, unknown> = { role: 'assistant', content: text }
  if (toolCalls.length > 0) out.tool_calls = toolCalls
  return out
}

/** Serialize the conversation into OpenAI wire messages. */
function serializeMessages(messages: GenerateOptions['messages']): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/** Assemble the full wire request body (always streaming). */
function serializeRequest(options: GenerateOptions): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...serializeMessages(options.messages))
  const tools = options.tools
    ?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (tools !== undefined && tools.length > 0) body.tools = tools
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop !== undefined) body.stop = options.stop
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== OFF_REASONING_EFFORT) {
    body.reasoning_effort = options.reasoningEffort
  }
  return body
}

/** Map an HTTP status to a stable LlmError code. */
function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Classified facts for one non-2xx backend response. */
export interface ClassifiedHttpError {
  code: string
  message: string
  requestId?: string
}

/**
 * Classify a non-2xx CodeBuddy response into a stable LlmError code and a
 * user-facing message. Recognized business codes (enterprise quota 14012,
 * subscription policy 11136) map onto harness codes that are NOT in the
 * default retryable set, so the harness reports the failure without retrying.
 * @param status - the HTTP status code.
 * @param raw - the response body text (may be empty or non-JSON).
 */
export function classifyHttpError(status: number, raw: string): ClassifiedHttpError {
  const fallback = httpErrorCode(status)
  const fallbackMessage = `CodeBuddy API error (HTTP ${status})`
  if (raw.length === 0) return { code: fallback, message: fallbackMessage }
  let parsed: {
    code?: number
    msg?: string
    displayMsg?: { zh?: string }
    error?: { code?: number; msg?: string; message?: string; type?: string; requestId?: string }
  }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return { code: fallback, message: raw.slice(0, 300) || fallbackMessage }
  }
  const code = parsed.code ?? parsed.error?.code
  const rawMessage = parsed.msg ?? parsed.error?.msg ?? parsed.error?.message
  const requestId = parsed.error?.requestId
  const stable = classifyCode(code, parsed.error?.type)
  if (stable === 'QUOTA') {
    return { code: stable, message: rawMessage ?? ENTERPRISE_QUOTA_MESSAGE, ...(requestId ? { requestId } : {}) }
  }
  if (stable === 'MODEL_NOT_ALLOWED') {
    return {
      code: stable,
      message: parsed.displayMsg?.zh ?? rawMessage ?? MODEL_NOT_ALLOWED_MESSAGE,
      ...(requestId ? { requestId } : {}),
    }
  }
  return { code: fallback, message: rawMessage ?? fallbackMessage, ...(requestId ? { requestId } : {}) }
}


/** Build one {@link LlmModelInfo} for a catalog model. */
function modelInfo(provider: string, model: CodeBuddyCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description !== undefined ? { description: model.description } : {}),
    inputModalities: ['text'],
  }
}

/**
 * Map one enterprise directory entry onto an {@link LlmModelInfo}. Only
 * `enabled` models are advertised; capacities come from the subscription grant
 * when present.
 * @param provider - the provider route id.
 * @param model - one directory entry.
 */
function enterpriseModelInfo(
  provider: string,
  model: import('./credentials.js').CodeBuddyEnterpriseModel,
): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.descriptionZh !== undefined && model.descriptionZh.length > 0 ? { description: model.descriptionZh } : {}),
    inputModalities: ['text'],
  }
}

/**
 * The CodeBuddy adapter. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 */
export class CodeBuddyAdapter extends LlmAdapter {
  private readonly config: CodeBuddyAdapterOptions

  constructor(config: CodeBuddyAdapterOptions) {
    super()
    this.config = config
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'CodeBuddy' }
  }

  providerRetryPolicy(): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const staticModels = this.config.options().models.map((model) => modelInfo(provider, model))
    if (this.config.resolveDirectory === undefined) return staticModels
    const directory = await this.config.resolveDirectory().catch(() => undefined)
    if (directory === undefined) return staticModels
    const enabled = directory.filter((entry) => entry.status === 'enabled')
    if (enabled.length === 0) return staticModels
    return enabled.map((entry) => enterpriseModelInfo(provider, entry))
  }

  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find((entry) => entry.id === model)
    const info = configured === undefined
      ? { provider, id: model, name: model, inputModalities: ['text'] as const }
      : modelInfo(provider, configured)
    return Promise.resolve({
      ...info,
      reasoning: REASONING,
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    })
  }

  prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return this.resolveModel(provider, model).then((resolved) => ({
      model: resolved,
      stream: (options) => this.streamWithConnection(options),
    }))
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options)
  }

  async *streamWithConnection(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const connection = this.config.options()
    const headers = await this.config.resolveHeaders()
    const url = `${connection.baseURL}/v2/chat/completions`
    const body = JSON.stringify(serializeRequest(options))

    const requestHeaders: Record<string, string> = {
      ...headers,
      ...attributionHeaders(),
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError('CodeBuddy request aborted by caller', 'ABORTED', { cause: error as Error })
      }
      throw new LlmError(`CodeBuddy API request to ${url} failed`, 'TRANSPORT', { cause: error as Error })
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const classified = classifyHttpError(response.status, raw)
      throw new LlmError(classified.message, classified.code, {
        cause: new Error(raw.length > 0 ? raw : `CodeBuddy HTTP ${response.status}`),
        status: response.status,
        ...(classified.requestId !== undefined ? { requestId: ProviderRequestId(classified.requestId) } : {}),
      })
    }

    if (response.body === null) {
      throw new LlmError('CodeBuddy API returned no response body', 'EMPTY_RESPONSE')
    }

    // Idle watchdog on the caller's signal; the backend is streaming-only so we
    // pass it straight through and let the loop / consumer handle cancellation.
    try {
      yield* translate(parseSse(response.body))
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError('CodeBuddy request aborted by caller', 'ABORTED', { cause: error as Error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`CodeBuddy API stream from ${url} failed`, 'TRANSPORT', { cause: error as Error })
    }
  }
}
