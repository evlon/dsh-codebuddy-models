import assert from 'node:assert/strict'
import test from 'node:test'
import { CodeBuddyAdapter, DEFAULT_MODELS } from '../lib/adapter.js'
import { EnterpriseModelDirectory } from '../lib/credentials.js'

/** A fake CredentialManager-shaped object for directory tests. */
const fakeManager = {
  session: async () => ({ auth: { accessToken: 't', expiresAt: Date.now() + 3600000 }, account: { enterpriseId: 'e-1' } }),
}

test('EnterpriseModelDirectory caches within TTL and keeps last good on failure', async () => {
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    return new Response(JSON.stringify({ code: 0, data: [{ id: 'a', name: 'A', maxInputTokens: 100, maxOutputTokens: 10, supportsToolCall: true, supportsImages: false, status: 'enabled' }] }), { status: 200 })
  }
  try {
    const dir = new EnterpriseModelDirectory(fakeManager)
    const first = await dir.read()
    assert.equal(first.length, 1)
    assert.equal(first[0].id, 'a')
    assert.equal(calls, 1)
    // Second read within TTL uses the cache.
    await dir.read()
    assert.equal(calls, 1)
    // Cache clear forces a refetch.
    dir.clear()
    await dir.read()
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('EnterpriseModelDirectory returns undefined on fetch failure without cached data', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"code":1,"msg":"denied"}', { status: 403 })
  try {
    const dir = new EnterpriseModelDirectory(fakeManager)
    assert.equal(await dir.read(), undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function makeAdapter(resolveDirectory) {
  return new CodeBuddyAdapter({
    options: () => ({
      baseURL: 'https://copilot.tencent.com',
      maxTokens: 64000,
      defaultContextWindow: 1000000,
      models: DEFAULT_MODELS,
      streamIdleTimeoutMs: 300000,
      retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['RATE_LIMIT'], backoff: { initialDelayMs: 100, maxDelayMs: 500, jitterRatio: 0 } },
    }),
    resolveHeaders: async () => ({ authorization: 'Bearer t', 'x-user-id': 'u', 'x-enterprise-id': 'e', 'x-tenant-id': 'e', 'x-domain': 'd', 'user-agent': 't', 'content-type': 'application/json', accept: 'text/event-stream' }),
    resolveDirectory,
  })
}

test('listModels prefers the enterprise directory and filters to enabled', async () => {
  const adapter = makeAdapter(async () => [
    { id: 'live-model', name: 'Live', maxInputTokens: 1000, maxOutputTokens: 100, supportsToolCall: true, supportsImages: false, descriptionZh: '实时模型', status: 'enabled' },
    { id: 'retired-model', name: 'Retired', maxInputTokens: 1000, maxOutputTokens: 100, supportsToolCall: true, supportsImages: false, status: 'disabled' },
  ])
  const models = await adapter.listModels('codebuddy')
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'live-model')
  assert.equal(models[0].description, '实时模型')
})

test('listModels falls back to the static catalog when the directory is unavailable', async () => {
  const adapter = makeAdapter(async () => undefined)
  const models = await adapter.listModels('codebuddy')
  assert.equal(models.length, DEFAULT_MODELS.length)
  assert.deepEqual(models.map((m) => m.id), DEFAULT_MODELS.map((m) => m.id))
})

test('listModels falls back when the directory rejects', async () => {
  const adapter = makeAdapter(async () => { throw new Error('network down') })
  const models = await adapter.listModels('codebuddy')
  assert.equal(models.length, DEFAULT_MODELS.length)
})
