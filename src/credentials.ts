/**
 * CodeBuddy / WorkBuddy desktop credential reading and auto-refresh.
 *
 * Re-implements (in TypeScript, no Python) the credential half of the
 * `codebuddy2openai` converter: locate the locally-logged-in desktop auth
 * file, parse it, refresh the access token against the CodeBuddy backend when
 * it nears expiry, and build the authenticated headers used by the adapter.
 *
 * The plugin never performs login or stores passwords — it only reads the
 * auth file that the installed desktop app keeps, and writes it back only to
 * persist a refreshed token (atomically), exactly like the desktop app itself.
 *
 * @module dsh-codebuddy-models/credentials
 */

import { promises as fs, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** CodeBuddy backend origin. */
export const BACKEND = 'https://copilot.tencent.com'
/** Fallback X-Domain header value when the auth record has no domain. */
export const DEFAULT_DOMAIN = 'www.codebuddy.cn'
/** Uvicorn/gateway-style user agent used for backend requests. */
export const USER_AGENT = 'dsh-codebuddy-models/0.1.5'

/** Headers needed to authenticate one backend request. */
export interface CodeBuddyAuthHeaders {
  authorization: string
  'x-user-id': string
  'x-enterprise-id': string
  'x-tenant-id': string
  'x-domain': string
  'user-agent': string
  'content-type': string
  accept: string
}

/** The subset of the desktop auth record the plugin needs. */
export interface AuthSession {
  /** Bearer access token. */
  accessToken: string
  /** Token used to obtain a fresh access token. */
  refreshToken: string
  /** Epoch-millisecond access-token expiry. */
  expiresAt: number
  /** Optional login domain, e.g. `www.codebuddy.cn`. */
  domain?: string
}

/** The subset of the desktop account record the plugin needs. */
export interface AccountSession {
  uid?: string
  enterpriseId?: string
  nickname?: string
}

/** The shape of the desktop `*.info` auth file. */
export interface CodeBuddyInfoFile {
  auth?: Partial<AuthSession> & { refreshToken?: string }
  account?: AccountSession
}

/**
 * Locate every candidate auth directory for the current platform.
 * @returns directories searched, in priority order.
 */
export function authDirs(): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share')
  return [path.join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
}

/**
 * Find the first `*.info` auth file in the candidate directories.
 * @returns the absolute path of the file, or `undefined` when none is found.
 */
export function findAuthFile(): string | undefined {
  for (const dir of authDirs()) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.endsWith('.info')) {
        return path.join(dir, entry)
      }
    }
  }
  return undefined
}

/** Read a JSON file with tolerant BOM handling. */
async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf-8')
  return JSON.parse(raw.replace(/^\uFEFF/, ''))
}

/** Write a JSON object atomically (temp file + rename). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

/**
 * A thread/await-safe credential manager over one auth file.
 *
 * The file is cached by mtime; external writes (e.g. a desktop re-login) are
 * picked up on the next request. Token refresh is guarded by an in-process
 * lock so concurrent model calls never refresh or write twice.
 */
export class CredentialManager {
  private readonly path: string
  private tail: Promise<void> = Promise.resolve()
  private cached: CodeBuddyInfoFile | undefined
  private mtime = 0

  constructor(file: string) {
    this.path = file
  }

  /** True when no usable auth file could be read yet. */
  get file(): string {
    return this.path
  }

  private async loadIfStale(): Promise<void> {
    const stat = await fs.stat(this.path).catch(() => undefined)
    if (stat === undefined) {
      this.cached = undefined
      this.mtime = 0
      return
    }
    if (this.cached !== undefined && stat.mtimeMs === this.mtime) return
    this.cached = (await readJson(this.path)) as CodeBuddyInfoFile
    this.mtime = stat.mtimeMs
  }

  /** The currently-valid session, refreshing first if near expiry. */
  async session(): Promise<{ auth: AuthSession; account: AccountSession }> {
    return this.withLock(async () => {
      await this.loadIfStale()
      const info = this.cached
      if (info === undefined) throw new Error(`无法读取 CodeBuddy 登录文件：${this.path}`)
      const auth = info.auth ?? {}
      const account = info.account ?? {}
      if (typeof auth.accessToken !== 'string' || auth.accessToken.length === 0) {
        throw new Error('CodeBuddy 登录文件缺少 accessToken，请先在桌面端重新登录')
      }
      const expiresAt = typeof auth.expiresAt === 'number' ? auth.expiresAt : 0
      // refresh 60s before expiry
      const nearExpiry = Date.now() + 60_000 >= expiresAt
      if (nearExpiry) {
        await this.refresh(info)
      }
      const freshAuth = info.auth ?? auth
      return {
        auth: {
          accessToken: freshAuth.accessToken as string,
          refreshToken: (freshAuth.refreshToken ?? '') as string,
          expiresAt: typeof freshAuth.expiresAt === 'number' ? freshAuth.expiresAt : 0,
          domain: freshAuth.domain,
        },
        account,
      }
    })
  }

  /** Build the authenticated headers for one backend request. */
  async getHeaders(): Promise<CodeBuddyAuthHeaders> {
    const { auth, account } = await this.session()
    return {
      authorization: `Bearer ${auth.accessToken}`,
      'x-user-id': account.uid ?? '',
      'x-enterprise-id': account.enterpriseId ?? '',
      'x-tenant-id': account.enterpriseId ?? '',
      'x-domain': auth.domain ?? DEFAULT_DOMAIN,
      'user-agent': USER_AGENT,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }
  }

  /** A short human-readable account summary for diagnostics. */
  async summary(): Promise<Record<string, unknown>> {
    try {
      const { auth, account } = await this.session()
      return {
        uid: account.uid,
        nickname: account.nickname,
        tokenExpiresAt: auth.expiresAt,
        tokenExpired: Date.now() >= auth.expiresAt,
      }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }

  /** Serialize a single asynchronous critical section (refresh). */
  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Call the backend refresh endpoint and persist the new auth block. */
  private async refresh(info: CodeBuddyInfoFile): Promise<void> {
    const auth = info.auth ?? {}
    const account = info.account ?? {}
    const headers = this.buildHeadersFrom(auth, account)
    headers['x-refresh-token'] = auth.refreshToken ?? ''
    headers['x-auth-refresh-source'] = 'plugin'
    let response: Response
    try {
      response = await fetch(`${BACKEND}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers,
        body: '{}',
      })
    } catch (error) {
      throw new Error(`刷新 CodeBuddy token 网络失败：${(error as Error).message}`)
    }
    const data = (await response.json().catch(() => undefined)) as
      | { code?: number; data?: Partial<AuthSession>; msg?: string }
      | undefined
    if (data?.code !== 0 || data.data === undefined) {
      throw new Error(`刷新 CodeBuddy token 失败：${data?.msg ?? 'unknown'}`)
    }
    const next = data.data
    const merged: AuthSession = {
      accessToken: next.accessToken ?? auth.accessToken ?? '',
      refreshToken: next.refreshToken ?? auth.refreshToken ?? '',
      expiresAt: next.expiresAt ?? Date.now(),
      domain: next.domain ?? auth.domain,
    }
    if (merged.expiresAt <= Date.now() && merged.expiresAt > 0) {
      throw new Error('刷新 CodeBuddy token 返回了已过期 token')
    }
    info.auth = merged
    await writeJsonAtomic(this.path, info)
    this.cached = info
    this.mtime = (await fs.stat(this.path)).mtimeMs
  }

  private buildHeadersFrom(auth: Partial<AuthSession>, account: AccountSession): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${auth.accessToken ?? ''}`,
      'x-user-id': account.uid ?? '',
      'x-enterprise-id': account.enterpriseId ?? '',
      'x-tenant-id': account.enterpriseId ?? '',
      'x-domain': auth.domain ?? DEFAULT_DOMAIN,
      'user-agent': USER_AGENT,
    }
  }
}

/** Load the first available auth file into a manager, or return undefined. */
export function openCredentialManager(): CredentialManager | undefined {
  const file = findAuthFile()
  return file === undefined ? undefined : new CredentialManager(file)
}

/** Console origin serving the enterprise builtin-models directory. */
export const CONSOLE_ORIGIN = 'https://www.codebuddy.cn'

/** One entry of the enterprise builtin-models directory. */
export interface CodeBuddyEnterpriseModel {
  /** Wire model id accepted by the chat backend. */
  id: string
  /** Display name. */
  name: string
  /** Output cap the subscription grants. */
  maxOutputTokens: number
  /** Input capacity the subscription grants. */
  maxInputTokens: number
  /** Whether the backend accepts tool calls for this model. */
  supportsToolCall: boolean
  /** Whether image input is accepted. */
  supportsImages: boolean
  /** Chinese description, when present. */
  descriptionZh?: string
  /** Model lifecycle state; only `enabled` models are usable. */
  status: string
}

/** Wire shape of the builtin-models response. */
interface BuiltinModelsResponse {
  code: number
  msg?: string
  data?: CodeBuddyEnterpriseModel[]
}

/**
 * Fetch the enterprise builtin-models directory with the desktop credentials.
 * The console endpoint is authenticated by the same bearer token and identity
 * headers the chat backend uses, plus the `x-rbac-context` scope header.
 * @param manager - the credential manager resolving the session/headers.
 * @returns the directory entries, or `undefined` when unreadable/unauthorized.
 */
export async function fetchEnterpriseModels(
  manager: CredentialManager,
): Promise<CodeBuddyEnterpriseModel[] | undefined> {
  let session: { auth: AuthSession; account: AccountSession }
  try {
    session = await manager.session()
  } catch {
    return undefined
  }
  const enterpriseId = session.account.enterpriseId ?? ''
  if (enterpriseId.length === 0) return undefined
  const url = `${CONSOLE_ORIGIN}/console/enterprises/${encodeURIComponent(enterpriseId)}/builtin-models`
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${session.auth.accessToken}`,
    'x-user-id': session.account.uid ?? '',
    'x-enterprise-id': enterpriseId,
    'x-tenant-id': enterpriseId,
    'x-domain': session.auth.domain ?? DEFAULT_DOMAIN,
    'x-rbac-context': 'scope=ai.model',
    'user-agent': USER_AGENT,
  }
  let response: Response
  try {
    response = await fetch(url, { headers })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  const body = (await response.json().catch(() => undefined)) as BuiltinModelsResponse | undefined
  if (body?.code !== 0 || !Array.isArray(body.data)) return undefined
  return body.data
}

/**
 * A cached enterprise model directory: fetches on demand, serves from an
 * in-memory cache for {@link TTL_MS}, and never throws — failures return
 * `undefined` so callers fall back to their static catalog.
 */
export class EnterpriseModelDirectory {
  private cached: CodeBuddyEnterpriseModel[] | undefined
  private cachedAt = 0
  /** Cache lifetime; the directory changes rarely. */
  static readonly TTL_MS = 10 * 60_000

  constructor(private readonly manager: CredentialManager) {}

  /** Reset the cache (e.g. after a credential refresh). */
  clear(): void {
    this.cached = undefined
    this.cachedAt = 0
  }

  /** Read the directory, refreshing the cache when stale or absent. */
  async read(): Promise<CodeBuddyEnterpriseModel[] | undefined> {
    const now = Date.now()
    if (this.cached !== undefined && now - this.cachedAt < EnterpriseModelDirectory.TTL_MS) {
      return this.cached
    }
    const fetched = await fetchEnterpriseModels(this.manager)
    if (fetched === undefined) return this.cached // keep last good on failure
    this.cached = fetched
    this.cachedAt = now
    return fetched
  }
}
