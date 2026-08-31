/**
 * SSE decoding and StreamChunk translation for the CodeBuddy backend.
 *
 * The CodeBuddy backend (`copilot.tencent.com/v2/chat/completions`) is a
 * standard OpenAI chat-completions endpoint: it emits SSE chunks whose
 * `choices[].delta` carries `content`, `reasoning_content`, and `tool_calls`,
 * with `finish_reason` and `usage` on later chunks and a literal `[DONE]`
 * sentinel at the end. This module decodes that stream and maps it onto the
 * harness `StreamChunk` vocabulary, exactly as the DSH adapters do.
 *
 * @module dsh-codebuddy-models/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { CallId, LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal payload OpenAI-compatible backends send after the last chunk. */
export const DONE = '[DONE]'

/** Whether a string is syntactically valid JSON (including `null`/numbers). */
function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Wire usage object reported by the backend. */
export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** One `choices[]` entry in a wire SSE chunk. */
export interface WireChoice {
  delta?: {
    content?: string
    reasoning_content?: string
    tool_calls?: Array<{
      index?: number
      id?: string
      function?: { name?: string; arguments?: string }
    }>
  }
  finish_reason?: string | null
}

/** One wire SSE data chunk. */
export interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage
  /** In-band error object the backend may emit instead of (or before) `[DONE]`. */
  error?: {
    code?: number
    msg?: string
    message?: string
    type?: string
    extError?: { code?: string; message?: string; type?: string }
  }
}

/**
 * CodeBuddy business-error codes the adapter recognizes. Anything else falls
 * back to the HTTP-status mapping in the caller.
 */
export const CODEBUDDY_ENTERPRISE_QUOTA_CODE = 14012
export const CODEBUDDY_MODEL_NOT_ALLOWED_CODE = 11136
/** CodeBuddy rejects a request whose tool-call history is incomplete/mismatched. */
export const CODEBUDDY_TOOL_SEQUENCE_BROKEN_CODE = 11148
/** The harness canonical code for a request that exceeded the model context window. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
/** Stable code for a broken tool-call/result sequence (CodeBuddy 11148). */
export const TOOL_SEQUENCE_BROKEN_CODE = 'TOOL_SEQUENCE_BROKEN'

/**
 * Classify a CodeBuddy business error code onto a stable harness LlmError
 * code. Quota exhaustion (14012) and subscription policy rejection (11136)
 * are terminal: neither belongs to the default retryable set, so the harness
 * will not retry them and will surface the failure to the user directly.
 * @param code - the provider business error code, when present.
 * @param type - the provider error type tag, when present (e.g. PI_AL_ERROR).
 * @param message - the provider message text, used to recognize context-window
 *   overflow (CodeBuddy has no single stable overflow code; the wording does).
 * @returns the stable LlmError code, or `undefined` to use HTTP-status mapping.
 */
export function classifyCode(code: number | undefined, type?: string, message?: string): string | undefined {
  if (code === CODEBUDDY_ENTERPRISE_QUOTA_CODE || type === 'PI_AL_ERROR') return 'QUOTA'
  if (code === CODEBUDDY_MODEL_NOT_ALLOWED_CODE) return 'MODEL_NOT_ALLOWED'
  if (code === CODEBUDDY_TOOL_SEQUENCE_BROKEN_CODE || type === 'tool_call_sequence_broken') return TOOL_SEQUENCE_BROKEN_CODE
  if (message !== undefined && isContextOverflowText(message)) return CONTEXT_WINDOW_EXCEEDED_CODE
  return undefined
}

/** User-facing message for the enterprise quota ceiling. */
export const ENTERPRISE_QUOTA_MESSAGE = '已达到企业为您设置的额度上限，如需调整额度，请联系企业管理员。'
/** User-facing message for a model outside the subscription. */
export const MODEL_NOT_ALLOWED_MESSAGE = '您暂无该模型的使用权限，请联系管理员。'

/**
 * Recognize provider wording for a request that exceeded the model context
 * window. CodeBuddy reports this both as an HTTP error body (`code`/`msg`) and
 * as an in-band SSE error block; the exact business code varies by model and
 * deployment, so the classifier keys on the message wording, mirroring the
 * harness's own `isContextWindowExceededError` patterns ("context length
 * exceeded", "too long for context", "maximum context length", ...).
 * @param text - the provider message/type text to test.
 * @returns true when the text identifies a context-window overflow.
 */
export function isContextOverflowText(text: string): boolean {
  if (text.length === 0) return false
  return (
    /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/i.test(text) ||
    /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(text) ||
    /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i.test(text) ||
    /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(text) ||
    /\b(?:exceed(?:ed|s)?|overflow(?:ed|s)?)\s+the\s+(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i.test(text) ||
    /上下文(?:长度|窗口|超长|溢出)/.test(text) ||
    /超出(?:了)?(?:模型|上下文)(?:的)?(?:上下文)?(?:长度|窗口|限制)/.test(text)
  )
}


/**
 * Parse a fetch response body into SSE data payloads. The literal `[DONE]` is
 * yielded last, matching the deepseek adapter contract; an EOF before it is a
 * truncated response and raises `LlmError('STREAM_CLOSED')`.
 * @param stream - the readable byte stream of the response body.
 * @param onComment - optional activity callback for SSE comments.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const event of events as AsyncIterable<{ data?: string }>) {
    const data = event.data
    if (data === undefined) continue
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * Map a wire `finish_reason` onto the harness FinishReason.
 * @param reason - the wire finish reason string.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

/**
 * Map wire usage onto the disjoint harness `TokenUsage` convention. Cache
 * reads are subtracted out of input tokens; reasoning tokens are kept when
 * reported.
 * @param usage - wire usage.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const out: TokenUsage = {
    inputTokens: (usage.prompt_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens ?? 0,
  }
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead
  if (reasoning !== undefined) out.reasoningTokens = reasoning
  return out
}

type OpenBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; text: string; callId?: string; name?: string }

/** A block with its assigned stream index. */
type IndexedBlock = OpenBlock & { index: number }
/** The tool-call block subtype with its call identity. */
type ToolBlock = Extract<IndexedBlock, { kind: 'tool-call' }>

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: IndexedBlock | undefined
  let reasoningBlock: IndexedBlock | undefined
  const toolBlocks = new Map<number, ToolBlock>()
  const order: IndexedBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  const open = (kind: OpenBlock['kind']): IndexedBlock => {
    const block: IndexedBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  const close = (block: IndexedBlock): StreamChunk => {
    switch (block.kind) {
      case 'text':
        return { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      case 'reasoning':
        return { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      case 'tool-call':
        return {
          type: 'block-end',
          index: block.index,
          block: {
            type: 'tool-call',
            id: CallId(block.callId ?? ''),
            name: block.name ?? '',
            arguments: block.text,
          },
        }
    }
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) yield close(block)
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      let reason = pendingFinish ?? { kind: 'stop' }
      // A tool-call block whose arguments are non-empty but not valid JSON is
      // a truncated stream: the backend cut the model's arguments mid-string.
      // Forwarding it would surface a confusing presenter warning and execute
      // a tool with garbage input, so fail the turn with a clear message.
      if (reason.kind === 'tool-calls' || reason.kind === 'stop') {
        const malformed = order.find(
          (block): block is ToolBlock =>
            block.kind === 'tool-call' &&
            block.text.length > 0 &&
            !isValidJson(block.text),
        )
        if (malformed !== undefined) {
          reason = {
            kind: 'error',
            failure: {
              message: `模型返回了不完整的工具调用参数（JSON 被截断），工具 "${malformed.name ?? '未知'}" 的参数不是有效的 JSON。请重试。`,
              code: 'MALFORMED_TOOL_ARGS',
            },
          }
        }
      }
      yield {
        type: 'finish',
        reason:
          reason.kind === 'stop' && order.length === 0
            ? {
                kind: 'error',
                failure: {
                  message: 'model returned a completed response with no content',
                  code: 'EMPTY_RESPONSE',
                },
              }
            : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    // In-band error: the backend may abort the stream with an error object
    // instead of emitting `[DONE]`. Surface it with a stable code so the
    // harness reports the real failure (e.g. enterprise quota, context
    // overflow) instead of a generic STREAM_CLOSED.
    if (chunk.error !== undefined) {
      const rawMessage = chunk.error.msg ?? chunk.error.message ?? chunk.error.extError?.message
      const type = chunk.error.type ?? chunk.error.extError?.type ?? chunk.error.extError?.code
      const stable = classifyCode(chunk.error.code, type, rawMessage)
      let message = rawMessage
      let code = stable
      if (code === 'QUOTA' && message === undefined) message = ENTERPRISE_QUOTA_MESSAGE
      if (code === 'MODEL_NOT_ALLOWED' && message === undefined) message = MODEL_NOT_ALLOWED_MESSAGE
      if (message === undefined) message = rawMessage ?? 'CodeBuddy API error'
      throw new LlmError(message, code ?? 'INVALID_RESPONSE', {
        cause: new Error(`in-band SSE error: ${JSON.stringify(chunk.error)}`),
      })
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta?.tool_calls ?? []) {
        const key = call.index ?? 0
        let block = toolBlocks.get(key)
        if (!block) {
          block = open('tool-call') as ToolBlock
          toolBlocks.set(key, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (typeof call.id === 'string' && call.id.length > 0) block.callId = call.id
        if (typeof call.function?.name === 'string' && call.function.name.length > 0) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
