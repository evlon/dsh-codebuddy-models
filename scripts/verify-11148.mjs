/**
 * Verify the real 11148 response classifies to TOOL_SEQUENCE_BROKEN with the
 * zh hint, using the exact body captured from the backend probe.
 */
import { classifyHttpError } from '../lib/adapter.js'

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
console.log('classified:', JSON.stringify(classified))
const ok =
  classified.code === 'TOOL_SEQUENCE_BROKEN' &&
  classified.message === '工具调用记录不完整，请重新发起对话。' &&
  classified.requestId === '0a7fc9bd-a7b5-4f7a-a14f-f6a10dd31942'
console.log(ok ? '11148 CLASSIFICATION OK' : '11148 CLASSIFICATION FAILED')
process.exit(ok ? 0 : 1)
