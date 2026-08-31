import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyHttpError } from '../lib/adapter.js'
import { classifyCode, isContextOverflowText } from '../lib/sse.js'

test('classifyCode maps enterprise quota (14012) to QUOTA', () => {
  assert.equal(classifyCode(14012), 'QUOTA')
  assert.equal(classifyCode(14012, 'PI_AL_ERROR'), 'QUOTA')
  // type fallback even when the numeric code is missing
  assert.equal(classifyCode(undefined, 'PI_AL_ERROR'), 'QUOTA')
})

test('classifyCode maps model-not-allowed (11136) to MODEL_NOT_ALLOWED', () => {
  assert.equal(classifyCode(11136), 'MODEL_NOT_ALLOWED')
})

test('classifyCode maps tool-sequence-broken (11148) to TOOL_SEQUENCE_BROKEN', () => {
  assert.equal(classifyCode(11148), 'TOOL_SEQUENCE_BROKEN')
  // extError.type / extError.code fallback even when the numeric code is absent
  assert.equal(classifyCode(undefined, 'tool_call_sequence_broken'), 'TOOL_SEQUENCE_BROKEN')
  assert.equal(classifyCode(undefined, undefined, 'tool calls and tool results do not match'), undefined)
})

test('classifyCode returns undefined for unknown codes', () => {
  assert.equal(classifyCode(12345), undefined)
  assert.equal(classifyCode(undefined), undefined)
})

test('isContextOverflowText recognizes provider overflow wording', () => {
  for (const text of [
    'This model\'s maximum context length is 168000 tokens. However, you requested 170000 tokens (170000 in the messages, 0 in the completion).',
    'context length exceeded',
    'request too long for context window',
    'input is too long for this model',
    'prompt exceeds the model context window',
    '上下文长度超出限制',
    '请求超出上下文窗口限制',
  ]) {
    assert.ok(isContextOverflowText(text), `should detect: ${text}`)
  }
  for (const text of [
    'rate limit exceeded',
    'quota exhausted',
    'model not allowed by policy',
    'server error',
  ]) {
    assert.ok(!isContextOverflowText(text), `should NOT detect: ${text}`)
  }
})

test('classifyCode maps context-overflow wording to CONTEXT_WINDOW_EXCEEDED', () => {
  assert.equal(
    classifyCode(undefined, undefined, "This model's maximum context length is 168000 tokens."),
    'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.equal(classifyCode(400, undefined, 'context length exceeded'), 'CONTEXT_WINDOW_EXCEEDED')
  // unknown code with no overflow wording still returns undefined
  assert.equal(classifyCode(400, undefined, 'generic error'), undefined)
})

test('classifyHttpError maps context-overflow body to CONTEXT_WINDOW_EXCEEDED', () => {
  const raw = JSON.stringify({
    code: 400,
    msg: "This model's maximum context length is 168000 tokens. However, you requested 170000 tokens.",
    requestId: 'req-1',
  })
  const classified = classifyHttpError(400, raw)
  assert.equal(classified.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.match(classified.message, /maximum context length/)
  assert.equal(classified.requestId, 'req-1')
})

test('classifyHttpError maps nested overflow error to CONTEXT_WINDOW_EXCEEDED', () => {
  const raw = JSON.stringify({
    error: { code: 400, msg: 'request too long for context window', requestId: 'req-2' },
  })
  const classified = classifyHttpError(400, raw)
  assert.equal(classified.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(classified.requestId, 'req-2')
})

test('classifyHttpError maps Chinese overflow message to CONTEXT_WINDOW_EXCEEDED', () => {
  const classified = classifyHttpError(400, JSON.stringify({ code: 400, msg: '上下文长度超出限制' }))
  assert.equal(classified.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('classifyHttpError maps nested enterprise quota error (14012) to QUOTA with message and requestId', () => {
  const raw = JSON.stringify({
    error: {
      code: 14012,
      msg: '已达到企业为您设置的额度上限，如需调整额度，请联系企业管理员。',
      type: 'PI_AL_ERROR',
      requestId: 'a5372296-6f77-4028-aea2-d99a7d996938',
    },
  })
  const classified = classifyHttpError(403, raw)
  assert.equal(classified.code, 'QUOTA')
  assert.match(classified.message, /额度上限/)
  assert.equal(classified.requestId, 'a5372296-6f77-4028-aea2-d99a7d996938')
})

test('classifyHttpError maps top-level enterprise quota code (14012) to QUOTA', () => {
  const classified = classifyHttpError(403, JSON.stringify({ code: 14012, msg: '额度上限' }))
  assert.equal(classified.code, 'QUOTA')
  assert.equal(classified.message, '额度上限')
})

test('classifyHttpError keeps MODEL_NOT_ALLOWED behavior for 11136 with displayMsg', () => {
  const raw = JSON.stringify({
    code: 11136,
    msg: 'model not allowed by policy',
    displayMsg: { zh: '您暂无该模型的使用权限，请联系管理员。' },
  })
  const classified = classifyHttpError(403, raw)
  assert.equal(classified.code, 'MODEL_NOT_ALLOWED')
  assert.equal(classified.message, '您暂无该模型的使用权限，请联系管理员。')
})

test('classifyHttpError maps the real 11148 tool-sequence response to TOOL_SEQUENCE_BROKEN', () => {
  const raw = JSON.stringify({
    code: 11148,
    msg: 'tool calls and tool results do not match, please start a new conversation and retry',
    requestId: '0a7fc9bd-a7b5-4f7a-a14f-f6a10dd31942',
    extError: {
      code: 'tool_call_sequence_broken',
      message: 'tool calls and tool results do not match, please start a new conversation and retry',
      param: '',
      type: 'invalid_request_error',
      StatusCode: 400,
    },
    displayMsg: { zh: '工具调用记录不完整，请重新发起对话。' },
  })
  const classified = classifyHttpError(400, raw)
  assert.equal(classified.code, 'TOOL_SEQUENCE_BROKEN')
  assert.equal(classified.message, '工具调用记录不完整，请重新发起对话。')
  assert.equal(classified.requestId, '0a7fc9bd-a7b5-4f7a-a14f-f6a10dd31942')
})

test('classifyHttpError falls back to HTTP-status code when the error is unrecognized', () => {
  const classified = classifyHttpError(429, JSON.stringify({ error: { code: 9999, msg: 'transient' } }))
  assert.equal(classified.code, 'RATE_LIMIT')
  assert.equal(classified.message, 'transient')
})

test('classifyHttpError uses the default quota message when the body lacks one', () => {
  const classified = classifyHttpError(403, JSON.stringify({ error: { code: 14012 } }))
  assert.equal(classified.code, 'QUOTA')
  assert.match(classified.message, /额度上限/)
})

test('classifyHttpError handles empty and non-JSON bodies', () => {
  assert.deepEqual(classifyHttpError(500, ''), { code: 'SERVER', message: 'CodeBuddy API error (HTTP 500)' })
  const nonJson = classifyHttpError(502, 'upstream timeout')
  assert.equal(nonJson.code, 'SERVER')
  assert.equal(nonJson.message, 'upstream timeout')
})
