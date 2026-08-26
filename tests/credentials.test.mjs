import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CredentialManager } from '../lib/credentials.js'

async function writeInfo(file, overrides = {}) {
  const info = {
    account: { uid: 'u-123', enterpriseId: 'e-456', nickname: 'tester' },
    auth: {
      accessToken: 'acc-1',
      refreshToken: 'ref-1',
      expiresAt: Date.now() + 3_600_000,
      domain: 'www.codebuddy.cn',
    },
    ...overrides,
  }
  await fs.writeFile(file, JSON.stringify(info), 'utf-8')
}

async function withTempFile(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbmodels-'))
  const file = path.join(dir, 'Tencent-Cloud.coding-copilot.info')
  try {
    await run(file, dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('builds authenticated headers from a fresh auth file', async () => {
  await withTempFile(async (file) => {
    await writeInfo(file)
    const mgr = new CredentialManager(file)
    const headers = await mgr.getHeaders()
    assert.equal(headers.authorization, 'Bearer acc-1')
    assert.equal(headers['x-user-id'], 'u-123')
    assert.equal(headers['x-enterprise-id'], 'e-456')
    assert.equal(headers['x-tenant-id'], 'e-456')
    assert.equal(headers['x-domain'], 'www.codebuddy.cn')
    assert.equal(headers.accept, 'text/event-stream')
  })
})

test('refreshes and persists a new token when near expiry', async () => {
  const originalFetch = globalThis.fetch
  let refreshed = 0
  globalThis.fetch = async (url, init) => {
    refreshed += 1
    assert.equal(String(url).endsWith('/v2/plugin/auth/token/refresh'), true)
    const headers = init.headers
    assert.equal(headers['x-refresh-token'], 'ref-1')
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          accessToken: 'acc-2',
          refreshToken: 'ref-2',
          expiresAt: Date.now() + 3_600_000,
        },
      }),
      { status: 200 },
    )
  }
  try {
    await withTempFile(async (file) => {
      await writeInfo(file, {
        auth: { accessToken: 'acc-1', refreshToken: 'ref-1', expiresAt: Date.now() - 1, domain: 'www.codebuddy.cn' },
      })
      const mgr = new CredentialManager(file)
      const headers = await mgr.getHeaders()
      assert.equal(headers.authorization, 'Bearer acc-2')
      assert.equal(refreshed, 1)
      const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'))
      assert.equal(onDisk.auth.accessToken, 'acc-2')
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reports a clear error when the auth file is missing', async () => {
  await withTempFile(async (file) => {
    await fs.rm(file, { force: true })
    const mgr = new CredentialManager(file)
    await assert.rejects(() => mgr.getHeaders(), /无法读取 CodeBuddy 登录文件/)
  })
})

test('throws when refresh returns a failure code', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 401, msg: 'unauthorized' }), { status: 200 })
  try {
    await withTempFile(async (file) => {
      await writeInfo(file, {
        auth: { accessToken: 'acc-1', refreshToken: 'ref-1', expiresAt: Date.now() - 1 },
      })
      const mgr = new CredentialManager(file)
      await assert.rejects(() => mgr.getHeaders(), /刷新 CodeBuddy token 失败：unauthorized/)
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
