/**
 * Verify the overflow classification end-to-end: a classifyHttpError result
 * for a context-overflow body must carry code CONTEXT_WINDOW_EXCEEDED, and
 * dsh's own isContextWindowExceededError must agree on the same wording (the
 * compaction overflow-recovery listener keys on the normalized code, which
 * our adapter now emits). Run with `node scripts/verify-overflow.mjs`.
 */
import { classifyHttpError } from '../lib/adapter.js'
import { isContextOverflowText } from '../lib/sse.js'

const sample = "This model's maximum context length is 168000 tokens. However, you requested 170000 tokens (170000 in the messages, 0 in the completion). Please reduce the length of the messages or completion."

const classified = classifyHttpError(400, JSON.stringify({
  code: 400,
  msg: sample,
  requestId: 'req-overflow-1',
}))

console.log('classified:', JSON.stringify(classified))
const ok =
  classified.code === 'CONTEXT_WINDOW_EXCEEDED' &&
  isContextOverflowText(sample) &&
  classified.requestId === 'req-overflow-1'
console.log(ok ? 'OVERFLOW CLASSIFICATION OK' : 'OVERFLOW CLASSIFICATION FAILED')
process.exit(ok ? 0 : 1)
