import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyHttpError } from '../lib/adapter.js'
import { classifyCode } from '../lib/sse.js'

test('classifyCode maps enterprise quota (14012) to QUOTA', () => {
  assert.equal(classifyCode(14012), 'QUOTA')
  assert.equal(classifyCode(14012, 'PI_AL_ERROR'), 'QUOTA')
  // type fallback even when the numeric code is missing
  assert.equal(classifyCode(undefined, 'PI_AL_ERROR'), 'QUOTA')
})

test('classifyCode maps model-not-allowed (11136) to MODEL_NOT_ALLOWED', () => {
  assert.equal(classifyCode(11136), 'MODEL_NOT_ALLOWED')
})

test('classifyCode returns undefined for unknown codes', () => {
  assert.equal(classifyCode(12345), undefined)
  assert.equal(classifyCode(undefined), undefined)
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
