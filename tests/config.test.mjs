import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAdapterOptions, PUBLIC_BASE_URL } from '../lib/index.js'

test('resolveAdapterOptions falls back to the public endpoint for an empty baseURL', () => {
  // Regression: a saved empty baseURL (settings `baseURL: ""`) previously
  // produced a relative request URL ("/v2/chat/completions") that fetch rejects.
  const withEmpty = resolveAdapterOptions({ baseURL: '' })
  assert.equal(withEmpty.baseURL, PUBLIC_BASE_URL)

  const withWhitespace = resolveAdapterOptions({ baseURL: '   ' })
  assert.equal(withWhitespace.baseURL, PUBLIC_BASE_URL)

  const withUndefined = resolveAdapterOptions({})
  assert.equal(withUndefined.baseURL, PUBLIC_BASE_URL)
})

test('resolveAdapterOptions trims and keeps a real baseURL', () => {
  const resolved = resolveAdapterOptions({ baseURL: '  https://api.example.com/  ' })
  assert.equal(resolved.baseURL, 'https://api.example.com/')
})

test('resolveAdapterOptions applies defaults for other fields', () => {
  const resolved = resolveAdapterOptions({})
  assert.equal(resolved.maxTokens, 64000)
  assert.equal(resolved.defaultContextWindow, 1000000)
})
