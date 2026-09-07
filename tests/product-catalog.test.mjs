import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverOfficialCatalog, parseOfficialModels, OfficialCatalogReader } from '../lib/product-catalog.js'

/** A realistic subset of the official CodeBuddy product.json models. */
function productFixture(models, productName = 'CodeBuddy') {
  return JSON.stringify({ productName, models })
}

/** Materialize one extension directory under a fresh temp root. */
async function installExtension(root, version, product) {
  const dir = path.join(root, `tencent-cloud.coding-copilot-${version}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'product.json'), product, 'utf-8')
  return dir
}

async function withTempRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbproduct-'))
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('parseOfficialModels maps chat rows and drops completion-only and cap-less rows', () => {
  const models = parseOfficialModels(JSON.parse(productFixture([
    { id: 'default', name: 'Default', maxInputTokens: 168000, maxOutputTokens: 32000, supportsToolCall: true, descriptionZh: '默认' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', maxInputTokens: 1000000, maxOutputTokens: 128000 },
    { id: 'completion-gf', name: 'completion-gf', maxOutputTokens: 8192, supportsExtra: true },
    { id: 'no-caps', name: 'NoCaps' },
    { id: 'kimi', name: 'Kimi', maxOutputTokens: 8192 }, // no input cap
  ])))
  assert.equal(models.length, 2)
  assert.deepEqual(models.map((m) => m.id), ['default', 'deepseek-v4-flash'])
  assert.equal(models[0].descriptionZh, '默认')
  assert.equal(models[1].maxInputTokens, 1000000)
  assert.equal(models[1].supportsImages, undefined)
})

test('parseOfficialModels rejects non-official manifests and empty catalogs', () => {
  assert.equal(parseOfficialModels({ productName: 'AnotherProduct', models: [] }), undefined)
  assert.equal(parseOfficialModels({ productName: 'CodeBuddy', models: [] }), undefined)
  assert.equal(parseOfficialModels(null), undefined)
  assert.equal(parseOfficialModels('nope'), undefined)
})

test('discoverOfficialCatalog picks the newest installed extension', async () => {
  await withTempRoot(async (root) => {
    await installExtension(root, '4.10.1', productFixture([{ id: 'hy3', name: 'hy3', maxInputTokens: 192000, maxOutputTokens: 64000 }]))
    const newest = await installExtension(root, '4.11.37554360', productFixture([
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', maxInputTokens: 1000000, maxOutputTokens: 128000 },
      { id: 'default', name: 'Default', maxInputTokens: 168000, maxOutputTokens: 32000 },
    ]))
    const result = await discoverOfficialCatalog([root])
    assert.equal(result.sourcePath, path.join(newest, 'product.json'))
    assert.deepEqual(result.models.map((m) => m.id), ['deepseek-v4-flash', 'default'])
  })
})

test('discoverOfficialCatalog ignores unreadable roots and non-CodeBuddy products', async () => {
  await withTempRoot(async (root) => {
    await installExtension(root, '4.0.0', productFixture([{ id: 'x', name: 'X', maxInputTokens: 1000, maxOutputTokens: 100 }], 'WorkBuddy'))
    assert.equal(await discoverOfficialCatalog([path.join(root, 'missing')]), undefined)
    assert.equal(await discoverOfficialCatalog([root]), undefined)
  })
})

test('OfficialCatalogReader caches within TTL and keeps last good on later failure', async () => {
  await withTempRoot(async (root) => {
    await installExtension(root, '4.0.0', productFixture([{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', maxInputTokens: 1000000, maxOutputTokens: 128000 }]))
    const reader = new OfficialCatalogReader([root], 60_000)
    const first = await reader.read()
    assert.equal(first.models.length, 1)
    // A stale cache keeps serving without a rescan even after the file disappears.
    await fs.rm(path.join(root, 'tencent-cloud.coding-copilot-4.0.0'), { recursive: true, force: true })
    const second = await reader.read()
    assert.equal(second, first)
    // Clearing forces a rescan, which now finds nothing.
    reader.clear()
    assert.equal(await reader.read(), undefined)
  })
})
