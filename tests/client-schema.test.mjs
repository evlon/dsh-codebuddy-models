import assert from 'node:assert/strict'
import test from 'node:test'
import { FORM_DEFAULTS, mergeFormSection, normalizeModels, validateModels } from '../src/client-schema.js'

test('normalizeModels drops non-objects and unknown keys', () => {
  assert.deepEqual(normalizeModels(undefined), [])
  assert.deepEqual(normalizeModels(null), [])
  assert.deepEqual(normalizeModels([null, 'x', 3]), [])
  assert.deepEqual(
    normalizeModels([{ id: 'a', name: 'A', junk: 1 }, { id: 'b' }]),
    [{ id: 'a', name: 'A' }, { id: 'b' }],
  )
})

test('validateModels accepts a clean catalog', () => {
  assert.equal(validateModels([]), undefined)
  assert.equal(validateModels([
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1000000, maxTokens: 64000 },
  ]), undefined)
})

test('validateModels rejects an empty or duplicate id', () => {
  assert.match(validateModels([{}]), /ID 不能为空/)
  assert.match(validateModels([{ id: 'a' }, { id: 'a' }]), /重复/)
})

test('validateModels rejects invalid name and capacity', () => {
  assert.match(validateModels([{ id: 'a', name: '' }]), /显示名称/)
  assert.match(validateModels([{ id: 'a', contextWindow: -1 }]), /容量/)
  assert.match(validateModels([{ id: 'a', maxTokens: 0 }]), /容量/)
})

test('mergeFormSection falls back to defaults and overlays section fields', () => {
  assert.deepEqual(mergeFormSection(undefined), FORM_DEFAULTS)
  const merged = mergeFormSection({ baseURL: 'https://x', models: [{ id: 'm' }] })
  assert.equal(merged.baseURL, 'https://x')
  assert.deepEqual(merged.models, [{ id: 'm' }])
  assert.equal(merged.maxTokens, FORM_DEFAULTS.maxTokens)
})
