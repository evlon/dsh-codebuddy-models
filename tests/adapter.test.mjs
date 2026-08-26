import assert from 'node:assert/strict'
import test from 'node:test'
import { CodeBuddyAdapter, DEFAULT_MODELS } from '../lib/adapter.js'

/** Minimal options thunk like the registering plugin provides. */
function makeAdapter() {
  return new CodeBuddyAdapter({
    options: () => ({
      baseURL: 'https://copilot.tencent.com',
      maxTokens: 64000,
      defaultContextWindow: 1_000_000,
      models: DEFAULT_MODELS,
      streamIdleTimeoutMs: 300_000,
      retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], backoff: { initialDelayMs: 500, maxDelayMs: 5000, jitterRatio: 0.1 } },
    }),
    resolveHeaders: async () => ({
      authorization: 'Bearer test',
      'x-user-id': 'u',
      'x-enterprise-id': 'e',
      'x-tenant-id': 'e',
      'x-domain': 'www.codebuddy.cn',
      'user-agent': 'test',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }),
  })
}

test('listModels returns the configured catalog ids', async () => {
  const adapter = makeAdapter()
  const models = await adapter.listModels('codebuddy')
  assert.deepEqual(models.map((m) => m.id), DEFAULT_MODELS.map((m) => m.id))
})

test('resolveModel advertises reasoning support (default effort high)', async () => {
  const adapter = makeAdapter()
  const resolved = await adapter.resolveModel('codebuddy', 'deepseek-v4-flash')
  assert.ok(resolved.reasoning, 'model must declare reasoning capability')
  const ids = resolved.reasoning.efforts.map((e) => e.id)
  assert.deepEqual(ids, ['off', 'low', 'high', 'max'])
  assert.equal(resolved.reasoning.defaultEffort, 'high')
  assert.ok(resolved.inputModalities.includes('text'))
})

test('resolveModel applies per-model context and output caps', async () => {
  const adapter = makeAdapter()
  const resolved = await adapter.resolveModel('codebuddy', 'deepseek-v4-flash')
  assert.equal(resolved.context.contextWindow, 1_000_000)
  assert.equal(resolved.defaultMaxTokens, 64000)
})

test('resolveModel accepts arbitrary model ids (returns generic info)', async () => {
  const adapter = makeAdapter()
  const resolved = await adapter.resolveModel('codebuddy', 'some-other-model')
  assert.equal(resolved.name, 'some-other-model')
  assert.ok(resolved.reasoning)
})

test('providerInfo exposes the CodeBuddy name', () => {
  const adapter = makeAdapter()
  assert.deepEqual(adapter.providerInfo('codebuddy'), { id: 'codebuddy', name: 'CodeBuddy' })
})
