import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSse, translate, mapFinishReason, mapUsage } from '../lib/sse.js'

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('translate maps plain text deltas into a text block and finish', async () => {
  const payloads = [
    JSON.stringify({ choices: [{ delta: { content: '你' } }] }),
    JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] }),
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    '[DONE]',
  ]
  const chunks = await collect(translate(payloads))
  const blockStarts = chunks.filter((c) => c.type === 'block-start')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const finish = chunks.find((c) => c.type === 'finish')
  const usage = chunks.find((c) => c.type === 'usage')
  assert.equal(blockStarts.length, 1)
  assert.equal(blockStarts[0].blockType, 'text')
  assert.equal(text, '你好')
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(usage.usage.inputTokens, 10)
  assert.equal(usage.usage.outputTokens, 5)
})

test('translate assembles tool-call argument fragments across deltas', async () => {
  const args1 = JSON.stringify({ path: 'a.txt' })
  const frag1 = args1.slice(0, 6)
  const frag2 = args1.slice(6)
  const payloads = [
    JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: frag1 } }] },
      }],
    }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: frag2 } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]
  const chunks = await collect(translate(payloads))
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(blockEnd.block.type, 'tool-call')
  assert.equal(blockEnd.block.name, 'read_file')
  assert.equal(blockEnd.block.arguments, args1)
  assert.equal(finish.reason.kind, 'tool-calls')
})

test('translate keeps the tool name when later deltas send empty-string names', async () => {
  // CodeBuddy emits the real name on the first tool-call delta, then sends
  // `function.name: ""` on every streaming argument fragment. The name must
  // not be overwritten with an empty string.
  const fullArgs = JSON.stringify({ path: 'a.txt' })
  const frag1 = fullArgs.slice(0, 8)
  const frag2 = fullArgs.slice(8)
  const payloads = [
    JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '' } }] },
      }],
    }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: frag1 } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: frag2 } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]
  const chunks = await collect(translate(payloads))
  const blockEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(blockEnd.block.name, 'read_file')
  assert.equal(blockEnd.block.id, 'call_0')
  assert.equal(blockEnd.block.arguments, fullArgs)
  assert.equal(finish.reason.kind, 'tool-calls')
})

test('translate interleaves reasoning and text blocks', async () => {
  const payloads = [
    JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]
  const chunks = await collect(translate(payloads))
  const types = chunks.filter((c) => c.type === 'block-start').map((c) => c.blockType)
  assert.deepEqual(types, ['reasoning', 'text'])
})

test('translate throws MALFORMED_RESPONSE on invalid JSON', async () => {
  await assert.rejects(() => collect(translate(['not-json', '[DONE]'])), (err) => err.code === 'MALFORMED_RESPONSE')
})

test('translate throws STREAM_CLOSED when [DONE] is missing', async () => {
  await assert.rejects(
    () => collect(translate([JSON.stringify({ choices: [{ delta: { content: 'x' } }] })])),
    (err) => err.code === 'STREAM_CLOSED',
  )
})

test('translate maps empty completion to EMPTY_RESPONSE error finish', async () => {
  const chunks = await collect(
    translate([JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), '[DONE]']),
  )
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('mapFinishReason covers the wire vocabulary', () => {
  assert.equal(mapFinishReason('stop').kind, 'stop')
  assert.equal(mapFinishReason('tool_calls').kind, 'tool-calls')
  assert.equal(mapFinishReason('length').kind, 'max-tokens')
  const unknown = mapFinishReason('content_filter')
  assert.equal(unknown.kind, 'error')
  assert.equal(unknown.failure.code, 'CONTENT_FILTER')
})

test('mapUsage subtracts cache reads from input tokens', () => {
  const usage = mapUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 70 },
    completion_tokens_details: { reasoning_tokens: 5 },
  })
  assert.equal(usage.inputTokens, 30)
  assert.equal(usage.cacheReadTokens, 70)
  assert.equal(usage.outputTokens, 20)
  assert.equal(usage.reasoningTokens, 5)
})

test('parseSse decodes a byte stream and yields [DONE]', async () => {
  const body = new TextEncoder().encode('data: {"a":1}\n\n' + 'data: [DONE]\n\n')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(body)
      controller.close()
    },
  })
  const payloads = []
  for await (const p of parseSse(stream)) payloads.push(p)
  assert.deepEqual(payloads, ['{"a":1}', '[DONE]'])
})

test('translate surfaces an in-band enterprise quota error (14012) as QUOTA', async () => {
  const payloads = [
    JSON.stringify({ error: { code: 14012, msg: '已达到企业为您设置的额度上限，如需调整额度，请联系企业管理员。', type: 'PI_AL_ERROR', requestId: 'r-14012' } }),
  ]
  await assert.rejects(
    () => collect(translate(payloads)),
    (error) => {
      assert.equal(error.code, 'QUOTA')
      assert.match(error.message, /额度上限/)
      return true
    },
  )
})

test('translate surfaces an in-band model-not-allowed error (11136)', async () => {
  const payloads = [
    JSON.stringify({ error: { code: 11136, msg: 'model not allowed by policy' } }),
  ]
  await assert.rejects(
    () => collect(translate(payloads)),
    (error) => {
      assert.equal(error.code, 'MODEL_NOT_ALLOWED')
      return true
    },
  )
})

test('translate surfaces an in-band context-overflow error as CONTEXT_WINDOW_EXCEEDED', async () => {
  const payloads = [
    JSON.stringify({ error: { code: 400, msg: "This model's maximum context length is 168000 tokens. However, you requested 170000 tokens.", requestId: 'r-overflow' } }),
  ]
  await assert.rejects(
    () => collect(translate(payloads)),
    (error) => {
      assert.equal(error.code, 'CONTEXT_WINDOW_EXCEEDED')
      assert.match(error.message, /maximum context length/)
      return true
    },
  )
})

test('translate surfaces an in-band tool-sequence-broken error (11148)', async () => {
  const payloads = [
    JSON.stringify({ error: { code: 11148, msg: 'tool calls and tool results do not match, please start a new conversation and retry', extError: { code: 'tool_call_sequence_broken', type: 'invalid_request_error' } } }),
  ]
  await assert.rejects(
    () => collect(translate(payloads)),
    (error) => {
      assert.equal(error.code, 'TOOL_SEQUENCE_BROKEN')
      return true
    },
  )
})

test('translate turns a truncated tool-call arguments stream into MALFORMED_TOOL_ARGS', async () => {
  // Backend cuts the model's arguments mid-string, then finishes the stream.
  const payloads = [
    JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '' } }] },
      }],
    }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '{"path": "C:/tmp/a.' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]
  const chunks = await collect(translate(payloads))
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'MALFORMED_TOOL_ARGS')
  assert.match(finish.reason.failure.message, /不完整/)
})

test('translate keeps valid tool-call arguments as tool-calls finish', async () => {
  const fullArgs = JSON.stringify({ path: 'C:/tmp/a.txt' })
  const payloads = [
    JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call_10', type: 'function', function: { name: 'read_file', arguments: '' } }] },
      }],
    }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: fullArgs } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]
  const chunks = await collect(translate(payloads))
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
})
